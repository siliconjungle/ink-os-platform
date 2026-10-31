import {SharedState,register} from '../shared/state.mjs';
import {SharedText} from '../shared/text.mjs';
import {textDiff} from '../shared/text-diff.mjs';
import {hash} from './world.mjs';
import {unlink} from 'node:fs/promises';
import {join} from 'node:path';

const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const version=object=>object.namespace==='os'&&object.kind==='os.version';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const decode=text=>new Uint8Array(Buffer.from(text,'base64'));
const stateID=(namespace,path)=>hash(namespace+'\0state\0'+path.slice(1).replaceAll('~1','/').replaceAll('~0','~')).slice(0,32);
const value=row=>row&&!row.deleted?JSON.parse(row.value):undefined;
const content=object=>{const{revision,updated,...rest}=object;return rest;};
const empty=(id,namespace,kind,now)=>({id,namespace,kind,title:'',body:'',summary:'',tags:[],spaces:[],status:'idea',cover:'',source:'',location:'',revision:0,created:now,updated:now,starred:false,archived:false,vector:[]});

// Each batch is journalable without exceeding the ordinary collaboration limits.
export function restoreBatches(updates){
 const result=[];let batch=[],bytes=2;
 for(const update of updates){const size=Buffer.byteLength(JSON.stringify(update))+1;if(size>2*1024*1024)fail(413,'A restore operation exceeds the journal bound');if(batch.length&&(batch.length===128||bytes+size>2*1024*1024)){result.push(batch);batch=[];bytes=2;}batch.push(update);bytes+=size;}
 if(batch.length)result.push(batch);return result;
}
function documents(manifest){
 const result=new Map();
 for(const doc of manifest.documents){const meta=doc.metadata;if(!meta||meta.id!==hash(meta.namespace+'\0'+meta.key)||!['state','text'].includes(meta.kind)||doc.snapshot.kind!==meta.kind||doc.snapshot.namespace!==meta.namespace||doc.snapshot.key!==meta.key||result.has(meta.id))fail(503,'Invalid saved document identity');result.set(meta.id,doc);}
 return result;
}
async function textChanges(snapshot,text){
 const copy=new SharedText({actor:1});await copy.restore({...snapshot,bytes:decode(snapshot.bytes)});
 if(copy.text===text)return[];
 const edit=textDiff(copy.text,text),updates=[];let offset=0,index=edit.index;
 do{let end=Math.min(edit.text.length,offset+16384);if(end<edit.text.length&&edit.text.charCodeAt(end)>=0xdc00&&edit.text.charCodeAt(end)<=0xdfff)end--;const chunk=edit.text.slice(offset,end);updates.push(...copy.splice(index,offset?0:edit.remove,chunk));index+=chunk.length;offset=end;}while(offset<edit.text.length);
 if(copy.text!==text)fail(503,'Text restore did not materialize the saved value');return updates;
}
function stateChanges(snapshot,target){
 const copy=new SharedState(),current=new Map(snapshot.registers.map(row=>[row.path,register(row)])),desired=new Map((target?.registers||[]).map(row=>[row.path,register(row)]));
 for(const row of current.values())copy.clock=copy.clock>row.clock?copy.clock:row.clock;
 const writes=[];
 for(const path of new Set([...current.keys(),...desired.keys()])){const before=value(current.get(path)),after=value(desired.get(path));if(same(before,after))continue;writes.push(after===undefined?{path,deleted:true}:{path,value:after});}
 const updates=[];for(let start=0;start<writes.length;start+=128)updates.push(...copy.commit(writes.slice(start,start+128)));return updates;
}

// Produces an immutable, replayable *forward* operation plan. The coordinator
// must hold the live journals while capturing `current` and persisting this plan.
// This module never mutates the running World, journals, actor leases or vaults.
export async function planRestore(current,target,{operation,now=Date.now(),seedFiles={}}={}){
 if(current.format!=='ink-os-version-v1'||target.format!=='ink-os-version-v1'||current.world.core!==target.world.core)fail(409,'This saved version needs an explicit schema migration');
 if(!/^[a-f0-9]{32}$/.test(operation||''))fail(400,'Restore requires a stable operation identity');
 const before=new Map(current.world.objects.map(object=>[object.id,object])),wanted=new Map(target.world.objects.map(object=>[object.id,structuredClone(object)]));
 if(before.size!==current.world.objects.length||wanted.size!==target.world.objects.length)fail(503,'Duplicate saved object identity');
 for(const object of wanted.values()){if(version(object))fail(503,'Version control records cannot be restored as application data');const previous=before.get(object.id);if(previous&&(previous.namespace!==object.namespace||previous.kind!==object.kind))fail(409,'Restore cannot change object ownership or kind');if((current.world.purged||[]).includes(object.id))fail(410,'A saved identity was permanently deleted');}
 const runtimeTransitions=[];
 for(const app of new Map([...before,...wanted]).values())if(app.namespace==='os'&&app.kind==='app'){
  const old=before.get(app.id),next=wanted.get(app.id),previous=old&&!old.archived?JSON.parse(old.body).releaseId||null:null,selected=next&&!next.archived?JSON.parse(next.body).releaseId||null:null;
  if(previous||selected)runtimeTransitions.push({appId:app.id,before:previous,after:selected});
 }
 // Deployment availability, environment activation and launch telemetry describe
 // the current host. Restoring application data must not rewind these fields.
 for(const object of wanted.values())if(object.namespace==='os'&&object.kind==='release'&&before.has(object.id)){
  const old=JSON.parse(before.get(object.id).body),next=JSON.parse(object.body);if(old.appId!==next.appId||old.digest!==next.digest)fail(409,'Immutable release identity changed');
  for(const key of ['deployment','environmentVersions','lastLaunchAt','parkedAt','status']){if(Object.hasOwn(old,key))next[key]=old[key];else delete next[key];}object.body=JSON.stringify(next);
 }
 const live=documents(current),saved=documents(target),plans=[];
 for(const id of saved.keys())if(!live.has(id))fail(503,'A saved document journal is unavailable; causal history cannot be invented');
 for(const [id,doc]of live){
  const previous=doc.snapshot,next=saved.get(id);if(next&&next.metadata.kind!==doc.metadata.kind)fail(409,'Restore cannot change a document kind');
  let text,updates,finalRegisters;
  if(doc.metadata.kind==='state'){updates=stateChanges(previous,next?.snapshot);finalRegisters=new Map(previous.registers.map(row=>[row.path,row]));for(const row of updates)finalRegisters.set(row.path,row);}
  else{
   if(next)text=next.snapshot.text;
   else if(doc.metadata.key.startsWith('object:'))text=wanted.get(doc.metadata.key.slice(7))?.body||'';
   else if(doc.metadata.seedFile){const file=wanted.get(doc.metadata.seedFile);if(!file||file.archived)text='';else if(file.location){if(!Object.hasOwn(seedFiles,file.id))fail(503,'Restoring an uninitialized draft requires its saved file bytes');text=seedFiles[file.id];}else text=file.body;}
   else text='';
   if(typeof text!=='string')fail(503,'Saved text must be a string');updates=await textChanges(previous,text);
  }
  const batches=restoreBatches(updates),metadata=structuredClone(doc.metadata),cursor=previous.cursor+batches.length;
  if(previous.cursor&&!previous.journalHead)fail(503,'Restore planning requires a fresh live journal checkpoint');
  plans.push({id,metadata,beforeCursor:previous.cursor,beforeJournalHead:previous.journalHead||null,afterCursor:cursor,batches,...(text===undefined?{}:{text}),presentInTarget:!!next});
  if(doc.metadata.kind==='text'&&doc.metadata.key.startsWith('object:')){const object=wanted.get(doc.metadata.key.slice(7));if(object)object.body=text;}
  if(doc.metadata.kind==='state'&&doc.metadata.key==='state'){
   const desired=finalRegisters,paths=new Set([...previous.registers.map(row=>row.path),...(next?.snapshot.registers||[]).map(row=>row.path)]);
   for(const path of paths){const key=stateID(doc.metadata.namespace,path),row=desired.get(path),old=wanted.get(key)||before.get(key);if(row&&!row.deleted){const object={...(old||empty(key,doc.metadata.namespace,'state',now)),title:path.slice(1).replaceAll('~1','/').replaceAll('~0','~'),body:row.value,archived:false};wanted.set(key,object);}else if(old)wanted.set(key,{...old,archived:true});}
  }
  const projection=id.slice(0,32),old=before.get(projection)||wanted.get(projection);
  wanted.set(projection,{...(old||empty(projection,doc.metadata.namespace,'collaboration',now)),title:doc.metadata.key,body:JSON.stringify({key:doc.metadata.key,kind:doc.metadata.kind,cursor}),location:'ink-collaboration:'+id,archived:false});
 }
 // Preserve identities born after the selected point as recoverable archives.
 for(const [id,object]of before)if(!wanted.has(id)&&!version(object))wanted.set(id,{...object,archived:true});
 const objects=[];
 for(const [id,desired]of wanted){const old=before.get(id);if(old&&same(content(old),content(desired)))continue;objects.push({...desired,revision:(old?.revision||0)+1,created:old?.created??desired.created,updated:now});}
 const revisions=new Map([...before.values(),...objects].map(object=>[object.id,object.revision]));
 for(const doc of plans)if(doc.metadata.seedFile&&wanted.has(doc.metadata.seedFile))doc.metadata={...doc.metadata,initialized:true,seedRevision:revisions.get(doc.metadata.seedFile)};
 return{format:'ink-os-restore-plan-v1',operation,target:target.id,sourceWorldVersion:current.world.version,plannedAt:now,documents:plans,objects,runtimeTransitions,retainedBlobs:structuredClone(target.world.blobRefs||{}),summary:{objects:objects.length,documents:plans.filter(doc=>doc.batches.length).length,journalBatches:plans.reduce((sum,doc)=>sum+doc.batches.length,0),archived:objects.filter(object=>object.archived&&!before.get(object.id)?.archived).length}};
}

function held(store,barrier){if(!barrier?.active||barrier!==store.activeVersionBarrier)fail(409,'Restore needs the owning live journal barrier');}
// Internal building block: the caller must durably store the plan, install the
// maintenance fence and hold the World queue before starting destructive work.
export async function applyRestoreDocuments(store,plan,barrier,journal){
 held(store,barrier);if(plan.format!=='ink-os-restore-plan-v1')fail(400,'Invalid restore plan');
 const intent=await journal.pending();if(journal.directory!==join(store.world.directory,'restoration')||intent?.planDigest!==hash(JSON.stringify(plan)))fail(409,'The restore plan must be durably prepared before editing journals');
 // Validate every prefix before applying any new batch. Recovery skips only the
 // exact batches already fsynced by this operation, never a cursor-shaped guess.
 for(const item of plan.documents){
  const doc=barrier.documents.get(item.id);if(!doc||doc.kind!==item.metadata.kind)fail(409,'A restore document is unavailable');
  if(doc.cursor<item.beforeCursor||doc.cursor>item.afterCursor||(doc.entries[item.beforeCursor-1]?.checksum||null)!==item.beforeJournalHead)fail(409,'A journal changed outside this restore operation');
  for(let index=0;index<doc.cursor-item.beforeCursor;index++)if(doc.entries[item.beforeCursor+index].checksum!==hash(JSON.stringify(item.batches[index])))fail(409,'A journal contains a different operation at the restore cursor');
 }
 for(const item of plan.documents){const doc=barrier.documents.get(item.id);clearTimeout(doc.projectTimer);doc.projectionEpoch=(doc.projectionEpoch||0)+1;}
 for(const item of plan.documents){
  const doc=barrier.documents.get(item.id);
  for(let index=doc.cursor-item.beforeCursor;index<item.batches.length;index++)await store.commit(doc,item.batches[index],{notify:false,project:false});
  if(!same(store.documentMetadata.get(item.id),item.metadata)){await store.saveMetadata(item.metadata);Object.assign(doc,item.metadata);}
 }
}
export async function publishRestoreDocuments(store,plan,barrier){
 held(store,barrier);
 if(store.world.restorations?.[plan.operation]?.planDigest!==hash(JSON.stringify(plan)))fail(409,'The restored World must be durable before publishing document snapshots');
 for(const item of plan.documents){const doc=barrier.documents.get(item.id);if(doc.cursor!==item.afterCursor)fail(409,'Restore journal is incomplete');await unlink(join(doc.dir,'pending-projection')).catch(error=>{if(error.code!=='ENOENT')throw error;});doc.projectionPending=false;const snapshot={type:'snapshot',...await store.capture(doc)};for(const listener of doc.listeners)listener(snapshot);}
}
