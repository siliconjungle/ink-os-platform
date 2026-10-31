import{mkdir,readFile,writeFile,rename,unlink,open}from'node:fs/promises';
import{join}from'node:path';
import{hash}from'./world.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const json=value=>JSON.stringify(value);
const identity=value=>{if(!/^[a-f0-9]{32}$/.test(value||''))fail(400,'Invalid restore operation identity');return value;};
export class RestoreJournal{
 constructor(directory,{world}={}){this.world=world;this.directory=join(directory,'restoration');this.path=join(this.directory,'pending.json');this.tail=Promise.resolve();}
 async durable(path,value){await mkdir(this.directory,{recursive:true,mode:0o700});await writeFile(path+'.next',json(value),{mode:0o600,flush:true});await rename(path+'.next',path);const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}
 async pending(){
  let record;try{record=JSON.parse(await readFile(this.path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;fail(503,'The pending restore journal is unreadable');}
  if(!record?.input?.plan||record.format!=='ink-os-restore-journal-v1'||!/^[a-f0-9]{32}$/.test(record.operation||'')||record.operation!==record.input.plan.operation||record.planDigest!==hash(json(record.input.plan))||record.inputDigest!==hash(json(record.input)))fail(503,'The pending restore journal failed its integrity check');return record;
 }
 async receipt(operation){identity(operation);try{const result=JSON.parse(await readFile(join(this.directory,operation+'.json'),'utf8'));if(!result||result.operation!==operation||result.format!=='ink-os-restore-receipt-v1')fail(503,'Restore receipt identity mismatch');const{digest,...body}=result;if(digest!==hash(json(body)))fail(503,'Restore receipt failed its integrity check');return result;}catch(error){if(error.code==='ENOENT')return null;if(error.status===503)throw error;fail(503,'Restore receipt is unreadable');}}
 prepare(plan,{before,targetDigest,backupId,preparedReleases={}}){
  const task=this.tail.then(async()=>{
   identity(plan.operation);identity(backupId);if(plan.format!=='ink-os-restore-plan-v1'||before.format!=='ink-os-version-v1'||before.id!==backupId||backupId===plan.target||before.world.version!==plan.sourceWorldVersion||!/^[a-f0-9]{64}$/.test(targetDigest||''))fail(400,'Restore intent does not match its captured input');
   const input={plan,before,targetDigest,backupId,preparedReleases},record={format:'ink-os-restore-journal-v1',operation:plan.operation,planDigest:hash(json(plan)),inputDigest:hash(json(input)),input};
   const previous=await this.pending();if(previous){if(previous.operation!==plan.operation||previous.inputDigest!==record.inputDigest)fail(409,'A different restore intent is already pending');return previous;}
   const completed=await this.receipt(plan.operation);if(completed){if(completed.planDigest!==record.planDigest)fail(409,'A completed restore identity cannot be reused for another plan');return completed;}
   await this.durable(this.path,record);return record;
  });this.tail=task.catch(()=>{});return task;
 }
 complete(operation,applied){
  const task=this.tail.then(async()=>{
   identity(operation);const pending=await this.pending(),previous=await this.receipt(operation);
   const canonical=this.world?.restorations?.[operation],pick=value=>Object.fromEntries(['operation','planDigest','target','backupId','version','committedAt'].map(key=>[key,value?.[key]]));
   if(!canonical||json(pick(applied))!==json(pick(canonical)))fail(409,'The World has not durably committed this restore receipt');
   if(!pending){if(previous){if(applied.operation!==operation||applied.planDigest!==previous.planDigest||applied.backupId!==previous.backupId)fail(409,'Restore completion changed after it was committed');return previous;}fail(409,'No restore intent is pending');}
   if(pending.operation!==operation||applied.operation!==operation||applied.planDigest!==pending.planDigest||applied.backupId!==pending.input.backupId)fail(409,'Restore completion does not match its durable intent');
   const body={format:'ink-os-restore-receipt-v1',...pick(applied)},receipt={...body,digest:hash(json(body))};await this.durable(join(this.directory,operation+'.json'),receipt);await unlink(this.path);const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}return receipt;
  });this.tail=task.catch(()=>{});return task;
 }
}
