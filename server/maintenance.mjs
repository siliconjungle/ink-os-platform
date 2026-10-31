import { open, rename, mkdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isAdmin } from './api-keys.mjs';

const format = 'ink-os-maintenance-store-v1';
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const check = (value, status, message) => { if (!value) fail(status, message); };
const hex = (value, size) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + size + '}$').test(value);
const pin = value => typeof value === 'string' && value.length <= 1024 && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value) && !value.includes('://');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])) : value;
const equal = (a, b) => hash(sorted(a)) === hash(sorted(b));
const processBootId = randomBytes(16).toString('hex');
export const maintenanceActivityFields = ['requests', 'writers', 'publications', 'workflows', 'schedules', 'nativeJobs', 'codeTasks', 'poolAssignments', 'poolRequests'];
const emptyActivity = () => Object.fromEntries(maintenanceActivityFields.map(key => [key, 0]));
const validActivity = value => exact(value, maintenanceActivityFields) && Object.values(value).every(n => Number.isSafeInteger(n) && n >= 0);
const idle = value => validActivity(value) && Object.values(value).every(n => n === 0);
const imagesValid = value => exact(value, ['os', 'runtime']) && pin(value.os) && pin(value.runtime);
const validPool = value => value && typeof value.admissionClosed === 'boolean' && ['active', 'held', 'uncertain', 'oldRuntimeSlotsRemaining', 'incompatibleRuntimeOverrides'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) && Array.isArray(value.retired) && value.retired.length <= 2000 && value.retired.every(id => hex(id, 32)) && new Set(value.retired).size === value.retired.length && Array.isArray(value.customRuntimeImages) && value.customRuntimeImages.length <= 1000 && value.customRuntimeImages.every(pin) && new Set(value.customRuntimeImages).size === value.customRuntimeImages.length;
const idlePool = value => validPool(value) && value.admissionClosed && ['active', 'held', 'uncertain', 'oldRuntimeSlotsRemaining', 'incompatibleRuntimeOverrides'].every(key => value[key] === 0);
const initialPool = () => ({ admissionClosed: false, active: 0, held: 0, uncertain: 1, oldRuntimeSlotsRemaining: 0, incompatibleRuntimeOverrides: 0, retired: [], customRuntimeImages: [] });
export { idle as quiescentHostActivity, idlePool as quiescentRuntimePool };
const directorySync = async path => { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } };

/** A durable admission gate. It never stops the host or a worker. The adapter
 * must preserve already-admitted work and prove its own runtime quiescence. */
export class Maintenance {
  constructor({ directory, instanceId, images, adapter, bootId = processBootId, fault, admissionAvailable = () => true } = {}) {
    check(directory && typeof images === 'function' && adapter && typeof admissionAvailable === 'function', 400, 'Provide maintenance storage, image provenance and host adapter');
    Object.assign(this, { directory, instanceId, images, adapter, bootId, fault, admissionAvailable, path: join(directory, 'maintenance.json'), operations: [], committedReceipts:new Map(), activeOperation: null, closed: false, ready: false, tail: Promise.resolve(), progressTask: null });
  }
  serial(run) { const task = this.tail.then(run); this.tail = task.catch(() => {}); return task; }
  owner(principal) { check(isAdmin(principal), 403, 'Only the administrator can prepare or release maintenance'); }
  currentImages() { const images = this.images(); check(hex(this.instanceId, 32) && hex(this.bootId, 32) && imagesValid(images), 503, 'Hosted image provenance is required for maintenance'); return { os: images.os, runtime: images.runtime }; }
  request(input) {
    check(exact(input, ['format','instanceId','operationId','challenge','fromImages','targetImages','retireRuntimeImage']) && input.format === 'ink-os-maintenance-request-v1' && input.instanceId === this.instanceId && hex(input.operationId,32) && hex(input.challenge,64) && imagesValid(input.fromImages) && imagesValid(input.targetImages) && input.retireRuntimeImage === (input.fromImages.runtime !== input.targetImages.runtime), 400, 'Provide the exact bound maintenance request');
    return { format: input.format, instanceId: input.instanceId, operationId: input.operationId, challenge: input.challenge, fromImages: { os:input.fromImages.os,runtime:input.fromImages.runtime }, targetImages: { os:input.targetImages.os,runtime:input.targetImages.runtime }, retireRuntimeImage: input.retireRuntimeImage };
  }
  async persist() {
    const body = { format, instanceId:this.instanceId, activeOperation:this.activeOperation, operations:this.operations }, handle = await open(this.path+'.next', constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({...body,digest:hash(body)})); await handle.sync(); } finally { await handle.close(); }
    await rename(this.path+'.next',this.path); await directorySync(this.directory);this.committedReceipts=new Map(this.operations.map(op=>[op.request.operationId,structuredClone(op.receipt)]));
  }
  async open() {
    await mkdir(this.directory,{recursive:true,mode:0o700}); const info=await lstat(this.directory); check(info.isDirectory()&&!info.isSymbolicLink(),503,'Maintenance storage must be an instance directory');
    let handle;
    try {
      handle=await open(this.path,constants.O_RDONLY|constants.O_NOFOLLOW); const info=await handle.stat(); check(info.isFile()&&!(info.mode&0o077)&&info.size<=16*1024*1024,503,'Invalid private maintenance store');
      const bytes=await handle.readFile(); check(bytes.length===info.size,503,'Maintenance store changed while reading'); const saved=JSON.parse(bytes),{digest,...body}=saved;
      check(exact(body,['format','instanceId','activeOperation','operations'])&&body.format===format&&body.instanceId===this.instanceId&&digest===hash(body)&&Array.isArray(body.operations)&&body.operations.length<=256&&(body.activeOperation===null||hex(body.activeOperation,32)),503,'Maintenance store failed integrity checks');
      const ids=new Set();
      for(const operation of body.operations){const request=this.request(operation.request),receipt=operation.receipt;check(!ids.has(request.operationId)&&hex(operation.preparedBootId,32)&&receipt?.format==='ink-os-maintenance-receipt-v1'&&receipt.instanceId===this.instanceId&&receipt.operationId===request.operationId&&receipt.challenge===request.challenge&&equal(receipt.fromImages,request.fromImages)&&equal(receipt.targetImages,request.targetImages)&&['draining','quiescent','restarted','complete','cancelled'].includes(receipt.state)&&receipt.admissionClosed===!['complete','cancelled'].includes(receipt.state)&&receipt.durable===true&&typeof receipt.stopAuthorized==='boolean'&&hex(receipt.bootId,32)&&validActivity(receipt.activity)&&validPool(receipt.pool)&&Number.isFinite(Date.parse(receipt.preparedAt)),503,'Maintenance operation failed integrity checks');if(['quiescent','restarted'].includes(receipt.state))check(idle(receipt.activity)&&idlePool(receipt.pool),503,'Invalid quiescent maintenance receipt');ids.add(request.operationId);}
      check(body.activeOperation===null?body.operations.every(op=>['complete','cancelled'].includes(op.receipt.state)):body.operations.filter(op=>!['complete','cancelled'].includes(op.receipt.state)).length===1&&body.operations.some(op=>op.request.operationId===body.activeOperation&&!['complete','cancelled'].includes(op.receipt.state)),503,'Maintenance active-operation mismatch');
      this.operations=body.operations;this.committedReceipts=new Map(this.operations.map(op=>[op.request.operationId,structuredClone(op.receipt)]));this.activeOperation=body.activeOperation;this.closed=!!this.activeOperation;
      if(this.closed){const operation=this.active(),current=this.currentImages();check(equal(current,operation.request.fromImages)||operation.receipt.stopAuthorized&&equal(current,operation.request.targetImages),503,'Maintenance boot image does not match the saved upgrade');if(operation.receipt.bootId!==this.bootId){operation.receipt.bootId=this.bootId;if(equal(current,operation.request.targetImages)&&['quiescent','restarted'].includes(operation.receipt.state))operation.receipt.state='restarted';else operation.receipt.state='draining';await this.persist();}}
    } catch(error){if(error.code!=='ENOENT'||handle)throw error;}finally{await handle?.close();}
    this.ready=true;return this;
  }
  inspect(principal) { this.owner(principal);check(this.ready,503,'Maintenance needs recovery');return{format:'ink-os-maintenance-inspection-v1',instanceId:this.instanceId,bootId:this.bootId,images:this.currentImages(),admissionClosed:this.closed,activeOperation:this.activeOperation,ready:true}; }
  active() { return this.operations.find(op=>op.request.operationId===this.activeOperation); }
  async activate() { check(this.ready,503,'Open maintenance before activation');if(this.closed)await this.adapter.closeAdmission({poolClosed:this.active().receipt.stopAuthorized||['quiescent','restarted'].includes(this.active().receipt.state)}); }
  kick() {
    if(this.progressTask||!this.closed||this.active()?.receipt.state!=='draining')return;
    const task=this.serial(()=>this.advance());this.progressTask=task;
    task.catch(()=>{}).finally(()=>{if(this.progressTask===task)this.progressTask=null;});
  }
  async prepare(principal,input) { this.owner(principal);const request=this.request(input);return this.serial(async()=>{
    check(this.ready,503,'Maintenance is unavailable');const previous=this.operations.find(op=>op.request.operationId===request.operationId);
    if(previous){check(equal(previous.request,request),409,'Maintenance operation belongs to different input');if(this.activeOperation===request.operationId)this.kick();return structuredClone(previous.receipt);}
    check(!this.activeOperation,409,'Another maintenance operation is active');check(this.operations.length<256,409,'Maintenance history needs explicit retention review');check(equal(this.currentImages(),request.fromImages),409,'Maintenance source images do not match this host');
    check(this.admissionAvailable()===true,409,'Another host operation owns admission');
    const receipt={format:'ink-os-maintenance-receipt-v1',instanceId:this.instanceId,operationId:request.operationId,challenge:request.challenge,state:'draining',bootId:this.bootId,admissionClosed:true,durable:true,stopAuthorized:false,fromImages:request.fromImages,targetImages:request.targetImages,activity:emptyActivity(),pool:initialPool(),preparedAt:new Date().toISOString()};
    this.closed=true;this.activeOperation=request.operationId;this.operations.push({request,preparedBootId:this.bootId,receipt});
    try{await this.adapter.closeAdmission({poolClosed:false});await this.persist();}catch(error){this.ready=false;throw error;}
    await this.fault?.('prepared');this.kick();return structuredClone(receipt);
  }); }
  get(principal,id) { this.owner(principal);check(this.ready,503,'Maintenance needs recovery');const receipt=this.committedReceipts.get(id);check(receipt,404,'Maintenance operation has not been durably recorded');this.kick();return structuredClone(receipt); }
  async advance() {
    if(!this.closed||this.active()?.receipt.state!=='draining')return;
    const operation=this.active();
    try {
      const activity=await this.adapter.activity();check(validActivity(activity),503,'Host activity proof is incomplete');operation.receipt.activity=activity;
      if(!idle(activity)){if(operation.receipt.pool.admissionClosed){await this.adapter.continueDraining();operation.receipt.pool.admissionClosed=false;}await this.persist();return;}
      const pool=await this.adapter.quiescePool(operation.request);check(validPool(pool),503,'Pool maintenance proof is incomplete');operation.receipt.pool=pool;
      if(!idlePool(pool)){if(pool.admissionClosed){await this.adapter.continueDraining();pool.admissionClosed=false;}await this.persist();return;}
      await this.adapter.flush(); const after=await this.adapter.activity();check(validActivity(after),503,'Host activity proof is incomplete');operation.receipt.activity=after;
      if(!idle(after)){await this.adapter.continueDraining();pool.admissionClosed=false;await this.persist();return;}
      operation.receipt.state=operation.preparedBootId!==this.bootId&&equal(this.currentImages(),operation.request.targetImages)?'restarted':'quiescent';delete operation.receipt.error;await this.persist();await this.fault?.('quiescent');
    } catch(error){if(error.code==='MAINTENANCE_ACTIVITY_CHANGED'){await this.adapter.continueDraining();operation.receipt.state='draining';operation.receipt.pool.admissionClosed=false;await this.persist();return;}operation.receipt.error='Maintenance progress could not be verified; admission remains closed.';await this.persist().catch(()=>{this.ready=false;});throw error;}
  }
  async seal(principal,id,input) { this.owner(principal);return this.serial(async()=>{
    check(exact(input,['challenge','bootId','fromImages','targetImages'])&&hex(input.challenge,64)&&hex(input.bootId,32)&&imagesValid(input.fromImages)&&imagesValid(input.targetImages),400,'Provide the exact maintenance stop binding');
    const operation=this.active();check(this.ready&&operation?.request.operationId===id&&operation.receipt.state==='quiescent'&&operation.request.challenge===input.challenge&&operation.receipt.bootId===input.bootId&&this.bootId===input.bootId&&equal(operation.request.fromImages,input.fromImages)&&equal(operation.request.targetImages,input.targetImages)&&equal(this.currentImages(),input.fromImages),409,'Only the current quiescent source boot can authorize a stop');
    if(operation.receipt.stopAuthorized){check(this.committedReceipts.get(id)?.stopAuthorized,503,'Stop authorization is not durable');return structuredClone(this.committedReceipts.get(id));}
    operation.receipt.stopAuthorized=true;try{await this.persist();}catch(error){operation.receipt.stopAuthorized=false;throw error;}return structuredClone(operation.receipt);
  }); }
  async complete(principal,id,input) { this.owner(principal);return this.serial(async()=>{
    check(exact(input,['challenge','targetImages'])&&hex(input.challenge,64)&&imagesValid(input.targetImages),400,'Provide the exact maintenance completion binding');const operation=this.operations.find(op=>op.request.operationId===id);check(operation&&operation.request.challenge===input.challenge&&equal(operation.request.targetImages,input.targetImages),409,'Maintenance completion binding differs');
    if(operation.receipt.state==='complete'){if(!this.activeOperation){this.closed=false;await this.adapter.resumeAdmission();}return structuredClone(operation.receipt);}
    check(this.ready&&this.activeOperation===id&&operation.receipt.state==='restarted'&&operation.receipt.stopAuthorized&&operation.preparedBootId!==this.bootId&&equal(this.currentImages(),input.targetImages),409,'A verified target-image restart is required before releasing maintenance');
    const pool=await this.adapter.quiescePool(operation.request);if(!idlePool(pool)){await this.adapter.continueDraining();operation.receipt.state='draining';operation.receipt.pool={...pool,admissionClosed:false};await this.persist();this.kick();fail(409,'Runtime maintenance is not quiescent');}try{await this.adapter.flush();}catch(error){if(error.code==='MAINTENANCE_ACTIVITY_CHANGED'){await this.adapter.continueDraining();operation.receipt.state='draining';operation.receipt.pool={...pool,admissionClosed:false};await this.persist();this.kick();}throw error;}const activity=await this.adapter.activity();check(validActivity(activity),503,'Host activity proof is incomplete');if(!idle(activity)){await this.adapter.continueDraining();operation.receipt.state='draining';operation.receipt.pool={...pool,admissionClosed:false};operation.receipt.activity=activity;await this.persist();this.kick();fail(409,'The restarted host still has active work');}
    const previousReceipt=structuredClone(operation.receipt);
    Object.assign(operation.receipt,{state:'complete',admissionClosed:false,pool:{...pool,admissionClosed:false},activity,completedAt:new Date().toISOString()});this.activeOperation=null;
    try{await this.persist();}catch(error){operation.receipt=previousReceipt;this.activeOperation=id;throw error;}await this.fault?.('complete');this.closed=false;await this.adapter.resumeAdmission();return structuredClone(operation.receipt);
  }); }
  async cancel(principal,id,{challenge}={}) { this.owner(principal);return this.serial(async()=>{
    check(this.ready,503,'Maintenance needs recovery');const operation=this.operations.find(op=>op.request.operationId===id);check(operation&&operation.request.challenge===challenge,409,'Maintenance cancellation binding differs');
    if(operation.receipt.state==='cancelled'){if(!this.activeOperation){this.closed=false;await this.adapter.resumeAdmission();}return structuredClone(operation.receipt);}
    check(this.activeOperation===id&&['draining','quiescent'].includes(operation.receipt.state)&&!operation.receipt.stopAuthorized&&equal(this.currentImages(),operation.request.fromImages),409,'Only source-image maintenance can be cancelled');
    const previousReceipt=structuredClone(operation.receipt);
    Object.assign(operation.receipt,{state:'cancelled',admissionClosed:false,pool:{...operation.receipt.pool,admissionClosed:false},completedAt:new Date().toISOString()});this.activeOperation=null;try{await this.persist();}catch(error){operation.receipt=previousReceipt;this.activeOperation=id;throw error;}this.closed=false;await this.adapter.resumeAdmission();return structuredClone(operation.receipt);
  }); }
}
