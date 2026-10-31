import { publishedAdapters, acceptsAdapter, defaultAdapters, adapterGroup, matchesShape } from '../shared/adapters.mjs';
import { fileInfo } from '../shared/file-types.mjs';
import { hash, id, plain } from './world.mjs';

const fail = (status,message) => { throw Object.assign(Error(message),{status}); };
const settingsId = hash('ink-os-adapters-v1').slice(0,32);
const configurationVersion=(platform,adapter)=>hash(JSON.stringify([adapter.releaseId,platform.environment?.records?.[adapter.id]?.metadata||{}]));
function settings(platform) { try { return JSON.parse(platform.world.get(settingsId)?.body || '{}'); } catch { return {}; } }
function serial(platform,key,run) {
  platform.adapterTasks ||= new Map();
  const task = (platform.adapterTasks.get(key) || Promise.resolve()).catch(()=>{}).then(run);
  platform.adapterTasks.set(key,task);
  void task.finally(()=>{if(platform.adapterTasks.get(key)===task)platform.adapterTasks.delete(key);}).catch(()=>{});
  return task;
}
export function adapterSettings(platform) {
  const state = settings(platform), all = publishedAdapters(platform.world.all());
  const adapters = all.map(adapter => ({...adapter, configurationVersion:configurationVersion(platform,adapter), configured:state.enabled?.[adapter.id] === configurationVersion(platform,adapter)}));
  return {adapters, defaults:state.defaults || {}};
}
function configured(platform) { return adapterSettings(platform).adapters.filter(a=>a.configured); }
async function saveSettings(platform,change) {
  return serial(platform,'settings',async()=>{
    const current=platform.world.get(settingsId), state=settings(platform);
    await platform.world.put({id:settingsId,namespace:'os',kind:'state',title:'Adapters',tags:['adapter-settings'],body:JSON.stringify(change(state))},{writer:'os',expected:current?.revision||0,actor:'Owner',action:'configured adapters'});
    return adapterSettings(platform);
  });
}
async function invoke(platform,adapter,path,body) {
  const result=await platform.invoke(adapter.id,{releaseId:adapter.releaseId,path,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body})});
  if(result.status>=400)fail(result.status,result.body?.error||'Adapter request failed');
  if(!result.body||typeof result.body!=='object')fail(502,'Adapter returned an invalid response');
  return result.body;
}
export async function activateAdapter(platform,adapterId,enabled=true) {
  const adapter=publishedAdapters(platform.world.all()).find(a=>a.id===adapterId);
  if(!adapter)fail(404,'Published adapter not found');
  if(enabled) {
    const health=await invoke(platform,adapter,'/adapter/health');
    if(health.configured!==true)fail(409,'Finish configuring this adapter before enabling it');
  }
  return saveSettings(platform,state=>({...state,enabled:{...state.enabled,[adapterId]:enabled?configurationVersion(platform,adapter):null},defaults:{...state.defaults,...(enabled&&!state.defaults?.[adapterGroup(adapter)]?{[adapterGroup(adapter)]:adapter.id}:{})}}));
}
export async function setAdapterDefault(platform,adapterId) {
  const adapter=configured(platform).find(a=>a.id===adapterId);
  if(!adapter)fail(400,'Choose an enabled, configured adapter');
  return saveSettings(platform,state=>({...state,defaults:{...state.defaults,[adapterGroup(adapter)]:adapterId}}));
}
export function adaptersFor(platform,sourceId) {
  const source=platform.world.get(sourceId);
  if(!source||source.archived)fail(404,'Source not found');
  const state=settings(platform);
  return {adapters:defaultAdapters(configured(platform).filter(a=>acceptsAdapter(a,source)),state.defaults),defaults:state.defaults||{}};
}
function publicRun(platform,record) {
  const data=JSON.parse(record.body), output=data.outputId&&platform.world.get(data.outputId);
  return {id:record.id,status:data.status,error:data.error||'',adapterId:data.adapter.id,method:data.adapter.name,sourceId:data.sourceId,sourceRevision:data.sourceRevision,...(output&&!output.archived?{object:platform.world.publicObject(output)}:{})};
}
async function changeRun(platform,record,changes) {
  return platform.world.update(record.id,{body:JSON.stringify({...JSON.parse(record.body),...changes})},{writer:'os',expected:record.revision,actor:'Adapter',action:'updated transformation'});
}
async function applyResult(platform,record,result) {
  const data=JSON.parse(record.body);
  if(result.status==='failed')return changeRun(platform,record,{status:'failed',error:'The adapter could not complete this transformation. Retry from Open with.'});
  if(result.status==='pending') {
    if(typeof result.jobId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(result.jobId))fail(502,'Adapter returned an invalid job');
    return changeRun(platform,record,{status:'pending',jobId:result.jobId});
  }
  if(result.status!=='completed'||!result.output)fail(502,'Adapter returned an invalid transformation');
  const output=result.output, contract=data.adapter.output;
  let bytes;
  if(typeof output.text==='string')bytes=Buffer.from(output.text);
  else if(typeof output.base64==='string'&&output.base64.length<=34*1024*1024&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output.base64))bytes=Buffer.from(output.base64,'base64');
  else fail(502,'Adapter must return text or base64 bytes');
  if(bytes.length>24*1024*1024)fail(413,'Adapter output exceeds 24 MiB');
  if(contract.shape) { let value;try{value=JSON.parse(bytes.toString());}catch{fail(502,'Adapter output does not match its declared data shape');}if(!matchesShape(value,contract.shape))fail(502,'Adapter output does not match its declared data shape'); }
  const outputId=hash('adapter-output:'+record.id).slice(0,32);
  let object=platform.world.get(outputId);
  if(!object) {
    const name=(data.sourceName.replace(/\.[^.]+$/,'')||'Untitled')+' — '+contract.label+contract.extension;
    const blob=await platform.storage.put(bytes,contract.mime,{retain:true});
    try { object=await platform.world.create({id:outputId,namespace:'os',kind:'file',title:name,source:name,location:blob.location,tags:['adapted'],body:JSON.stringify({originalName:name,mime:contract.mime,bytes:bytes.length,adaptation:{runId:record.id,sourceId:data.sourceId,sourceRevision:data.sourceRevision,adapterId:data.adapter.id,releaseId:data.adapter.releaseId,method:data.adapter.name,configurationVersion:data.adapter.configurationVersion}})},{writer:'os',actor:data.adapter.name,action:'created representation'}); }
    finally {blob.release?.();}
  }
  // A crash after creating the result is recovered by the stable output identity.
  if(object.archived)fail(409,'This representation was deleted; start a new transformation');
  return changeRun(platform,record,{status:'completed',outputId,completedAt:Date.now()});
}
export function startAdapter(platform,input,principal) {
  const source=platform.world.get(input.sourceId);
  if(!source||source.archived)fail(404,'Source not found');
  const adapters=adaptersFor(platform,source.id).adapters;
  const adapter=input.group?adapters.find(a=>adapterGroup(a)===input.group):configured(platform).find(a=>a.id===input.adapterId&&acceptsAdapter(a,source));
  if(!adapter)fail(400,'No configured adapter supports this source');
  if(Buffer.byteLength(source.body)>1024*1024)fail(413,'Structured adapter input exceeds 1 MiB');
  const key=hash(JSON.stringify([source.id,source.revision,adapter.id,adapter.releaseId,adapter.configurationVersion]));
  return serial(platform,key,async()=>{
    principal?.writeAccess?.check();
    const records=platform.world.all().filter(o=>o.namespace==='os'&&o.kind==='adapter-run'&&!o.archived);
    for(const record of records) {const run=JSON.parse(record.body);if(run.key===key&&['starting','pending','completed'].includes(run.status)) {
      if(run.status==='completed'&&!platform.world.get(run.outputId)?.archived&&platform.world.get(run.outputId))return publicRun(platform,record);
      if(run.status==='pending')return publicRun(platform,record);
      if(run.status==='starting'){await changeRun(platform,record,{status:'failed',error:'This transformation was interrupted before its job was recorded. Retry explicitly.'});}
    }}
    let record=await platform.world.create({id:id(),namespace:'os',kind:'adapter-run',title:source.title,tags:['adapter-run'],body:JSON.stringify({key,status:'starting',sourceId:source.id,sourceRevision:source.revision,sourceName:fileInfo(source).name,adapter,startedAt:Date.now()})},{writer:'os',actor:'Adapter',action:'started transformation',writeAccess:principal?.writeAccess});
    try {
      const result=await invoke(platform,adapter,'/adapter/run',{requestId:record.id,source:plain(platform.world.publicObject(source)),contentPath:'/api/v1/files/'+source.id+'/content?revision='+source.revision});
      record=await applyResult(platform,record,result);
    }catch(error){record=await changeRun(platform,record,{status:'failed',error:'The adapter could not start or save this transformation. Check its configuration and try again.'});}
    return publicRun(platform,record);
  });
}
export function pollAdapter(platform,runId) {
  return serial(platform,'run:'+runId,async()=>{
    let record=platform.world.get(runId);
    if(!record||record.archived||record.kind!=='adapter-run'||record.namespace!=='os')fail(404,'Transformation not found');
    const data=JSON.parse(record.body);
    if(data.status==='pending') {
      if(!publishedAdapters(platform.world.all()).some(a=>a.id===data.adapter.id&&a.releaseId===data.adapter.releaseId))fail(409,'The adapter release was replaced or removed');
      if(Date.now()-data.startedAt>30*60*1000)record=await changeRun(platform,record,{status:'failed',error:'Transformation timed out. Retry from Open with.'});
      else {
        // Transient polling failures leave the durable provider job intact.
        const result=await invoke(platform,data.adapter,'/adapter/runs/'+encodeURIComponent(data.jobId));
        record=await applyResult(platform,record,result);
      }
    }
    return publicRun(platform,record);
  });
}
