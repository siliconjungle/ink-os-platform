import{mkdir,readFile,writeFile,rename,open}from'node:fs/promises';import{join}from'node:path';import{randomBytes}from'node:crypto';
const failure=(status,message)=>Object.assign(Error(message),{status});
const identity=()=>randomBytes(16).toString('hex');
// Private host state, excluded from shared data and OS version snapshots.
export class RuntimePool{
 constructor({directory,provider,runtime,environment,origin,maxModuleSlots=100,maxOCISlots=100,maxLeases=100,maxMachines=100,accountLimit=100,idleMs=120000,now=Date.now}){Object.assign(this,{directory,provider,runtime,environment,origin,maxModuleSlots,maxOCISlots,maxLeases,maxMachines,accountLimit,idleMs,now});this.path=join(directory,'runtime-pool.json');this.slots=[];this.tail=Promise.resolve();this.pending=new Map();this.requests=new Map();this.verified=new Map();this.timer=null;}
 async open({sweep=true}={}){await mkdir(this.directory,{recursive:true});try{const data=JSON.parse(await readFile(this.path,'utf8'));if(data.version!==1||!Array.isArray(data.slots))throw Error('Invalid runtime pool state');this.slots=data.slots;for(const slot of this.slots)if(['starting','draining'].includes(slot.status))slot.status='uncertain';}catch(error){if(error.code!=='ENOENT')throw error;}if(sweep){this.timer=setInterval(()=>void this.reap().catch(()=>{}),Math.max(1000,Math.min(15000,this.idleMs/2)));this.timer.unref();}return this;}
 async close(){clearInterval(this.timer);this.timer=null;await Promise.all([...this.pending.values(),this.reaping].filter(Boolean));await this.tail;}
 async save(){const text=JSON.stringify({version:1,slots:this.slots});await writeFile(this.path+'.next',text,{mode:0o600,flush:true});await rename(this.path+'.next',this.path);const handle=await open(this.directory,'r');try{await handle.sync();}finally{await handle.close();}}
 change(run){const task=this.tail.then(async()=>{const result=await run();await this.save();return result;});this.tail=task.catch(()=>{});return task;}
 active(leaseId,appId,releaseId){return this.slots.some(slot=>slot.leaseId===leaseId&&slot.appId===appId&&slot.releaseId===releaseId&&['starting','ready','uncertain'].includes(slot.status));}
 publicSlot(slot){return{slotId:slot.id,kind:slot.kind,status:slot.status,appId:slot.appId||null,releaseId:slot.releaseId||null,leaseId:slot.leaseId||null,startedAt:slot.startedAt,lastUsedAt:slot.lastUsedAt,inFlight:this.requests.get(slot.leaseId)||0,holds:slot.holds||[],allowIdle:slot.allowIdle===true,assignmentCount:slot.assignmentCount||0,machineId:slot.deployment?.machineId,backendMachineId:slot.deployment?.backendMachineId};}
 budget(){return Math.min(this.maxMachines,this.provider.poolCapacity?this.capacitySnapshot?.maxPoolMachines??0:this.maxMachines);}
 async refreshCapacity(){if(this.provider.poolCapacity)this.capacitySnapshot=await this.provider.poolCapacity(this.slots,{accountLimit:this.accountLimit});return this.capacitySnapshot;}
 async inspect(){await this.refreshCapacity();return this.describe();}
 describe(){const machines=this.budget();return{capacity:this.capacitySnapshot,configured:{backendLeases:this.maxLeases,machines:this.maxMachines},limits:{backendLeases:Math.min(this.maxLeases,machines),machines,moduleSlots:Math.min(this.maxModuleSlots,machines),ociSlots:Math.min(this.maxOCISlots,Math.floor(machines/2)),idleMs:this.idleMs},allocatedMachines:this.slots.reduce((n,s)=>n+(s.kind==='oci'?2:1),0),slots:this.slots.map(slot=>this.publicSlot(slot))};}
 find(leaseId){const slot=this.slots.find(s=>s.leaseId===leaseId&&['starting','ready','uncertain'].includes(s.status));if(!slot)throw failure(409,'Compute lease has expired');return slot;}
 async hold(leaseId,label){if(typeof label!=='string'||!label.trim()||label.length>120)throw failure(400,'Give this background job a short name');const id=identity();await this.change(()=>{const slot=this.find(leaseId);if((slot.holds||[]).length>=100)throw failure(429,'Too many background holds');slot.holds=[...(slot.holds||[]),{id,label,createdAt:this.now()}];});return{id,label};}
 async releaseHold(leaseId,id){await this.change(()=>{const slot=this.find(leaseId);slot.holds=(slot.holds||[]).filter(hold=>hold.id!==id);slot.lastUsedAt=this.now();});return{released:true};}
 async allowIdle(leaseId){await this.change(()=>{this.find(leaseId).allowIdle=true;});return{idleAllowed:true};}
 async ensure(appId,releaseId,meta){const key=appId+':'+releaseId;if(this.pending.has(key))return this.pending.get(key);const task=this.ensureNow(appId,releaseId,meta).finally(()=>this.pending.delete(key));this.pending.set(key,task);return task;}
 async ensureNow(appId,releaseId,meta){
  const kind=meta.backend?.image?'oci':'module';let slot=this.slots.find(s=>s.appId===appId&&s.releaseId===releaseId&&['ready','starting','uncertain'].includes(s.status));
  if(slot?.status==='ready'&&this.verified.get(slot.id)===slot.leaseId)return slot;
  if(slot){try{const status=await this.provider.poolStatus(slot,this.runtime.leaseToken(appId,releaseId,slot.leaseId));if(status.appId===appId&&status.releaseId===releaseId&&status.leaseId===slot.leaseId&&!status.draining){if(slot.status!=='ready')await this.change(()=>{slot.status='ready';});this.verified.set(slot.id,slot.leaseId);return slot;}}catch{}// Never discard an unresponsive running worker.
   if(!await this.provider.poolStopped(slot)){if(this.provider.resumePoolSlot){const deployment=await this.provider.resumePoolSlot({slot,appId,releaseId,meta,key:this.runtime.leaseToken(appId,releaseId,slot.leaseId),origin:this.origin,environment:this.environment.values(appId)});await this.change(()=>{slot.deployment=deployment;slot.status='ready';});this.verified.set(slot.id,slot.leaseId);return slot;}throw failure(503,'Existing compute is busy or unavailable; its work was preserved');}await this.change(()=>{slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];});
  }
  const reserve=async()=>{if(!this.slots.some(s=>s.kind===kind&&s.status==='idle'))await this.refreshCapacity();return this.change(()=>{let idle=this.slots.find(s=>s.kind===kind&&s.status==='idle');if(!idle){if(this.slots.length>=this.maxLeases||this.slots.reduce((n,s)=>n+(s.kind==='oci'?2:1),0)+(kind==='oci'?2:1)>this.budget()||this.slots.filter(s=>s.kind===kind).length>=(kind==='oci'?this.maxOCISlots:this.maxModuleSlots))return null;idle={id:identity(),kind,status:'idle'};this.slots.push(idle);}Object.assign(idle,{status:'starting',appId,releaseId,leaseId:identity(),lastUsedAt:this.now(),startedAt:this.now(),holds:[],allowIdle:false,assignmentCount:(idle.assignmentCount||0)+1});return idle;});};
  slot=await reserve();if(!slot){await this.reap();slot=await reserve();}if(!slot)throw failure(503,'Compute pool is fully leased; active and background work was preserved');
  await this.runtime.prepare(appId);const leaseId=slot.leaseId;
  try{const deployment=await this.provider.assignPoolSlot({slot,appId,releaseId,meta,key:this.runtime.leaseToken(appId,releaseId,leaseId),origin:this.origin,environment:this.environment.values(appId)});await this.change(()=>{if(slot.leaseId!==leaseId)throw failure(409,'Compute assignment changed');slot.deployment=deployment;slot.status='ready';});this.verified.set(slot.id,slot.leaseId);return slot;}
  catch(error){await this.change(()=>{slot.status='uncertain';slot.lastError='Assignment did not become ready';});throw error;}
 }
 async invoke(appId,releaseId,meta,input){
  let slot,leaseId;
  for(;;){slot=await this.ensure(appId,releaseId,meta);leaseId=slot.leaseId;const admitted=await this.change(()=>{if(slot.status!=='ready'||slot.leaseId!==leaseId)return false;this.requests.set(leaseId,(this.requests.get(leaseId)||0)+1);slot.lastUsedAt=this.now();return true;});if(admitted)break;}
  try{return await this.provider.poolInvoke(slot,this.runtime.leaseToken(appId,releaseId,leaseId),input);}
  catch(error){this.verified.delete(slot.id);throw error;}
  finally{await this.change(()=>{const count=this.requests.get(leaseId)-1;if(count)this.requests.set(leaseId,count);else this.requests.delete(leaseId);if(slot.leaseId===leaseId)slot.lastUsedAt=this.now();});}
 }
 reap(){if(this.reaping)return this.reaping;this.reaping=this.reapNow().finally(()=>{this.reaping=null;});return this.reaping;}
 async retireRelease(appId,releaseId){
  for(const slot of this.slots.filter(slot=>slot.appId===appId&&slot.releaseId===releaseId)){
   const leaseId=slot.leaseId;
   if(this.requests.get(leaseId)||(slot.holds||[]).length)throw failure(409,'Backend cleanup is waiting for active work to finish');
   if(!await this.provider.poolStopped(slot)){
    const key=this.runtime.leaseToken(appId,releaseId,leaseId),status=await this.provider.poolStatus(slot,key);
    if(status.activeRequests||status.resources||status.startPinned&&!slot.allowIdle)throw failure(409,'Backend cleanup is waiting for background work to finish');
    const claimed=await this.change(()=>{if(this.requests.get(leaseId)||(slot.holds||[]).length||slot.leaseId!==leaseId)return false;slot.status='draining';return true;});
    if(!claimed)throw failure(409,'Backend cleanup is waiting for active work to finish');
    const drained=await this.provider.drainPoolSlot(slot,key,{allowIdle:slot.allowIdle});
    if(!drained.idle){await this.change(()=>{slot.status='ready';});throw failure(409,'Backend cleanup is waiting for active work to finish');}
    if(!await this.provider.stopPoolSlot(slot)){await this.change(()=>{slot.status='uncertain';});throw failure(409,'Backend cleanup has not confirmed an idle stopped worker');}
   }
   await this.provider.removeStopped?.(slot);
   await this.change(()=>{slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];delete slot.deployment;});
  }
 }
 async reapNow(){const released=[];for(const slot of [...this.slots]){
   const leaseId=slot.leaseId;if(slot.status==='uncertain'){if(await this.provider.poolStopped(slot)){await this.change(()=>{slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];});}continue;}
   if(slot.status!=='ready'||this.requests.get(leaseId)||this.now()-slot.lastUsedAt<this.idleMs)continue;
   const key=this.runtime.leaseToken(slot.appId,slot.releaseId,leaseId);let status;try{status=await this.provider.poolStatus(slot,key);}catch{if(await this.provider.poolStopped(slot))await this.change(()=>{if(slot.status==='ready'&&slot.leaseId===leaseId&&!this.requests.get(leaseId)){slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];}});continue;}
   if((slot.holds||[]).length||status.leaseId!==leaseId||status.activeRequests||status.resources||status.startPinned&&!slot.allowIdle||status.draining)continue;
   const claimed=await this.change(()=>{if(slot.status!=='ready'||slot.leaseId!==leaseId||this.requests.get(leaseId)||(slot.holds||[]).length||this.now()-slot.lastUsedAt<this.idleMs)return false;slot.status='draining';return true;});if(!claimed)continue;
   try{const drained=await this.provider.drainPoolSlot(slot,key,{allowIdle:slot.allowIdle});if(!drained.idle){await this.change(()=>{slot.status='ready';});continue;}if(!await this.provider.stopPoolSlot(slot))throw Error('Pool slot could not be safely stopped');await this.change(()=>{slot.status='idle';slot.appId=null;slot.releaseId=null;slot.leaseId=null;slot.holds=[];slot.lastUsedAt=this.now();});released.push(slot.id);}
   catch{await this.change(()=>{slot.status='uncertain';slot.lastError='Idle release could not be confirmed';});}
  }return{released, ...this.describe()};}
}
