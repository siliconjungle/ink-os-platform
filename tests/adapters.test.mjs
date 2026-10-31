import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../server/world.mjs';
import { Storage } from '../server/storage.mjs';
import { uploadFiles,saveText } from '../server/files.mjs';
import { adapterManifest,acceptsAdapter,adapterGroup,defaultAdapters,publishedAdapters } from '../shared/adapters.mjs';
import { installedApps } from '../shared/app-desktop.mjs';
import { adapterSettings,adaptersFor,activateAdapter,setAdapterDefault,startAdapter,pollAdapter } from '../server/adapters.mjs';

const contract=()=>adapterManifest({operation:'transcribe',name:'Example method',input:{fileTypes:['audio/*']},output:{label:'Transcript',mime:'text/plain',extension:'.txt'}});
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'ink-adapter-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const world=await new World(directory).open(),storage=await new Storage(directory,{env:{}}).open();
  const platform={world,storage,environment:{records:{}},calls:[],invoke:async()=>({status:200,body:{configured:true}})};
  async function install(seed='a',adapter=contract()) {return world.create({id:seed.repeat(32),namespace:'os',kind:'app',title:'Example '+seed,body:JSON.stringify({slug:'adapter-'+seed,adapter,releaseId:seed==='a'?'1'.repeat(32):'2'.repeat(32),installedAt:seed.charCodeAt(0)})},{writer:'os'});}
  const file=(await uploadFiles(platform,{files:[{name:'speech.wav',mime:'audio/wav',base64:Buffer.from('source bytes').toString('base64')}]})).objects[0];
  return{platform,world,storage,install,file};
}
test('fresh core has no adapters; input contracts match file types and required JSON field types',async t=>{
  const {platform,file}=await fixture(t);
  assert.deepEqual(adapterSettings(platform),{adapters:[],defaults:{}});
  assert.deepEqual(adaptersFor(platform,file.id).adapters,[]);
  assert.equal(acceptsAdapter(contract(),file),true);
  assert.equal(acceptsAdapter(contract(),{...file,source:'x.txt',body:'{"mime":"text/plain"}'}),false);
  const structured=adapterManifest({operation:'render',name:'Example renderer',input:{kind:'character',shape:{name:'string',traits:'array'}},output:{label:'Character',mime:'application/json',extension:'.json',shape:{name:'string'}}});
  assert.equal(acceptsAdapter(structured,{kind:'character',body:'{"name":"Ada","traits":[]}'}),true);
  assert.equal(acceptsAdapter(structured,{kind:'character',body:'{"name":12,"traits":[]}'}),false);
  assert.throws(()=>adapterManifest({operation:'bad',name:'Invalid',input:{},output:{}}));
});
test('only activated adapters match; installing a method preserves the prior default and keeps adapters out of apps',async t=>{
  const {platform,world,install,file}=await fixture(t),first=await install();
  assert.equal(publishedAdapters(world.all()).length,1);
  assert.equal(installedApps(world.all()).length,0);
  assert.equal(adaptersFor(platform,file.id).adapters.length,0);
  await activateAdapter(platform,first.id);
  const next=await install('b',{...contract(),name:'Another provider'});await activateAdapter(platform,next.id);
  assert.equal(adaptersFor(platform,file.id).adapters[0].id,first.id);
  await setAdapterDefault(platform,next.id);
  assert.equal(adaptersFor(platform,file.id).adapters[0].id,next.id);
  await activateAdapter(platform,next.id,false);
  assert.equal(adaptersFor(platform,file.id).adapters[0].id,first.id);
  platform.invoke=async()=>({status:200,body:{configured:false}});
  await assert.rejects(activateAdapter(platform,next.id),e=>e.status===409);
  const candidates=publishedAdapters(world.all());
  const different={...candidates[1],output:{...candidates[1].output,mime:'application/json',extension:'.json'}};
  assert.equal(defaultAdapters([candidates[0],different]).length,2);
});
test('durable transformations deduplicate concurrent opens, resume polling, and preserve original and edited result',async t=>{
  const {platform,world,storage,install,file}=await fixture(t),app=await install();await activateAdapter(platform,app.id);
  let starts=0;platform.invoke=async(_id,input)=>({status:200,body:input.path==='/adapter/run'?(starts++,{status:'pending',jobId:'example-job'}):{status:'completed',output:{text:'A transcript'}}});
  const group=adapterGroup(adaptersFor(platform,file.id).adapters[0]);
  const [first,other]=await Promise.all([startAdapter(platform,{sourceId:file.id,group},{owner:true}),startAdapter(platform,{sourceId:file.id,group},{owner:true})]);
  assert.equal(first.id,other.id);assert.equal(starts,1);assert.equal(first.status,'pending');
  delete platform.adapterTasks;
  const done=await pollAdapter(platform,first.id);assert.equal(done.status,'completed');assert.notEqual(done.object.id,file.id);
  assert.equal((await storage.get(file.location)).toString(),'source bytes');assert.equal(world.get(file.id).revision,file.revision);
  assert.equal(JSON.parse(done.object.body).adaptation.sourceRevision,file.revision);
  await saveText(platform,done.object.id,{text:'My edited transcript',expected:done.object.revision},{owner:true});
  assert.equal(JSON.parse(world.get(done.object.id).body).adaptation.sourceId,file.id);
  const reused=await startAdapter(platform,{sourceId:file.id,group},{owner:true});assert.equal(reused.object.id,done.object.id);
  assert.equal((await storage.get(reused.object.location)).toString(),'My edited transcript');assert.equal(starts,1);
  await world.update(file.id,{title:'Updated recording'},{writer:'os'});
  const revised=await startAdapter(platform,{sourceId:file.id,group},{owner:true});assert.notEqual(revised.id,first.id);assert.equal(starts,2);
});
test('configuration changes invalidate readiness and cache; failed methods never overwrite a source',async t=>{
  const {platform,world,install,file}=await fixture(t),app=await install();await activateAdapter(platform,app.id);
  platform.environment.records[app.id]={metadata:{CREDENTIAL:{updatedAt:'changed'}}};
  assert.equal(adaptersFor(platform,file.id).adapters.length,0);
  await activateAdapter(platform,app.id);
  const before=world.get(file.id);
  platform.invoke=async()=>({status:200,body:{status:'completed',output:{text:123}}});
  const failed=await startAdapter(platform,{sourceId:file.id,adapterId:app.id},{owner:true});assert.equal(failed.status,'failed');
  assert.equal(world.get(file.id).location,before.location);assert.equal(world.get(file.id).revision,before.revision);
  await assert.rejects(async()=>startAdapter(platform,{sourceId:file.id,adapterId:'f'.repeat(32)},{owner:true}),e=>e.status===400);
});

test('disabling discovery does not suspend a previously submitted transformation',async t=>{
 const {platform,install,file}=await fixture(t),app=await install();await activateAdapter(platform,app.id);
 platform.invoke=async(_id,input)=>({status:200,body:input.path==='/adapter/run'?{status:'pending',jobId:'accepted-job'}:{status:'completed',output:{text:'Completed after disabling'}}});
 const run=await startAdapter(platform,{sourceId:file.id,adapterId:app.id},{owner:true});
 await activateAdapter(platform,app.id,false);assert.equal(adaptersFor(platform,file.id).adapters.length,0);
 assert.equal((await pollAdapter(platform,run.id)).status,'completed');
});
