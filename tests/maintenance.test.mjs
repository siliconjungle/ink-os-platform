import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Maintenance,maintenanceActivityFields} from '../server/maintenance.mjs';
const owner={owner:true,accountId:'owner'}, instanceId='a'.repeat(32), firstBoot='b'.repeat(32), secondBoot='c'.repeat(32);
const image=n=>'registry.example/image@sha256:'+n.repeat(64), fromImages={os:image('1'),runtime:image('2')},targetImages={os:image('3'),runtime:image('4')};
const request={format:'ink-os-maintenance-request-v1',instanceId,operationId:'d'.repeat(32),challenge:'e'.repeat(64),fromImages,targetImages,retireRuntimeImage:true};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'ink-maintenance-'));const state={images:fromImages,activity:Object.fromEntries(maintenanceActivityFields.map(key=>[key,0])),closed:false,poolClosed:false,busyPool:false,flushFailure:false,quiesces:0,resumes:0};
  const adapter={continueDraining:async()=>{state.poolClosed=false;},closeAdmission:async({poolClosed})=>{state.closed=true;state.poolClosed=poolClosed;},resumeAdmission:async()=>{state.closed=false;state.poolClosed=false;state.resumes++;},activity:async()=>structuredClone(state.activity),quiescePool:async()=>{state.quiesces++;state.poolClosed=!state.busyPool;return{admissionClosed:state.poolClosed,active:state.busyPool?1:0,held:0,uncertain:0,oldRuntimeSlotsRemaining:0,incompatibleRuntimeOverrides:0,retired:[],customRuntimeImages:[]};},flush:async()=>{if(state.flushFailure)throw Error('Simulated disk flush failure');}};
  const instances=[];t.after(async()=>{for(const instance of instances)await instance.progressTask?.catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const host=async(bootId=firstBoot,fault)=>{const value=await new Maintenance({directory,instanceId,images:()=>state.images,adapter,bootId,fault}).open();instances.push(value);await value.activate();return value;};
  return{directory,state,host};
}
async function seal(host){return host.seal(owner,request.operationId,{challenge:request.challenge,bootId:firstBoot,fromImages,targetImages});}
async function progress(host){host.get(owner,request.operationId);await host.progressTask;return host.get(owner,request.operationId);}

test('busy host and worker continuations preserve open pool admission until both naturally finish',async t=>{
 const f=await fixture(t),host=await f.host();f.state.activity.workflows=1;
 assert.equal((await host.prepare(owner,request)).state,'draining');assert.equal(host.closed,true);await host.progressTask;
 assert.equal(f.state.quiesces,0);assert.equal(f.state.poolClosed,false);
 f.state.activity.workflows=0;f.state.busyPool=true;await progress(host);assert.equal(f.state.poolClosed,false);assert.equal(host.get(owner,request.operationId).state,'draining');
 f.state.busyPool=false;await host.progressTask;const done=await progress(host);assert.equal(done.state,'quiescent');assert.equal(done.pool.admissionClosed,true);assert.equal(f.state.closed,true);
 await assert.rejects(host.complete(owner,request.operationId,{challenge:request.challenge,targetImages}),{status:409});
});

test('target boot preserves the durable closed gate until exact restart/image-bound completion',async t=>{
 const f=await fixture(t),old=await f.host();await old.prepare(owner,request);await old.progressTask;assert.equal(old.get(owner,request.operationId).state,'quiescent');
 await seal(old);f.state.images=targetImages;const target=await f.host(secondBoot);assert.equal(target.closed,true);assert.equal(target.get(owner,request.operationId).state,'restarted');assert.equal(f.state.closed,true);
 await assert.rejects(target.complete(owner,request.operationId,{challenge:'f'.repeat(64),targetImages}),{status:409});assert.equal(f.state.closed,true);
 const result=await target.complete(owner,request.operationId,{challenge:request.challenge,targetImages:{runtime:targetImages.runtime,os:targetImages.os}});assert.equal(result.state,'complete');assert.equal(result.bootId,secondBoot);assert.equal(f.state.closed,false);assert.equal(f.state.poolClosed,false);
 const reopened=await f.host('f'.repeat(32));assert.equal(reopened.closed,false);assert.deepEqual(reopened.get(owner,request.operationId),result);
});

test('source-image restart does not impersonate a target upgrade; exact cancellation reopens without stopping work',async t=>{
 const f=await fixture(t),host=await f.host();f.state.activity.nativeJobs=1;await host.prepare(owner,request);await host.progressTask;
 const source=await f.host(secondBoot);assert.equal(source.closed,true);assert.equal(source.get(owner,request.operationId).state,'draining');await source.progressTask;
 await assert.rejects(source.complete(owner,request.operationId,{challenge:request.challenge,targetImages}),{status:409});
 const cancelled=await source.cancel(owner,request.operationId,{challenge:request.challenge});assert.equal(cancelled.state,'cancelled');assert.equal(f.state.activity.nativeJobs,1);assert.equal(f.state.closed,false);
 assert.equal((await source.cancel(owner,request.operationId,{challenge:request.challenge})).state,'cancelled');
});

test('administrator, immutable intent, image provenance and active-operation boundaries reject before unsafe admission changes',async t=>{
 const f=await fixture(t),host=await f.host();
 await assert.rejects(host.prepare({owner:true,accountId:'member'},request),{status:403});
 await assert.rejects(host.prepare(owner,{...request,fromImages:{...fromImages,os:image('9')}}),{status:409});assert.equal(f.state.closed,false);
 await assert.rejects(host.prepare(owner,{...request,secret:'not-permitted'}),{status:400});
 await host.prepare(owner,request);await host.progressTask;
 await assert.rejects(host.prepare(owner,{...request,challenge:'f'.repeat(64)}),{status:409});
 await assert.rejects(host.prepare(owner,{...request,operationId:'f'.repeat(32)}),{status:409});
 assert.throws(()=>host.get({appId:'f'.repeat(32)},request.operationId),{status:403});
 f.state.images={os:'latest',runtime:fromImages.runtime};await assert.rejects(f.host(secondBoot),{status:503});
});

test('failed persistence or flush never authorizes stopping and restart refuses corrupted/symlinked state',async t=>{
 const f=await fixture(t),host=await f.host();f.state.flushFailure=true;await host.prepare(owner,request);await host.progressTask.catch(()=>{});
 assert.equal(host.get(owner,request.operationId).state,'draining');await host.progressTask.catch(()=>{});assert.equal(host.closed,true);
 f.state.flushFailure=false;await progress(host);assert.equal(host.get(owner,request.operationId).state,'quiescent');
 const original=await readFile(join(f.directory,'maintenance.json'));const changed=JSON.parse(original);changed.operations[0].receipt.activity.requests=5;await writeFile(join(f.directory,'maintenance.json'),JSON.stringify(changed));await assert.rejects(f.host(secondBoot),{status:503});
 await writeFile(join(f.directory,'maintenance.json'),original,{mode:0o600});await rm(join(f.directory,'maintenance.json.next'),{force:true});await symlink(join(f.directory,'protected'),join(f.directory,'maintenance.json.next'));
 const next=await f.host();await assert.rejects(next.cancel(owner,request.operationId,{challenge:request.challenge}));assert.equal(next.closed,true);assert.equal(f.state.closed,true);
});

test('a lost post-commit completion reply recovers open admission and the same historical receipt',async t=>{
 const f=await fixture(t),source=await f.host();await source.prepare(owner,request);await source.progressTask;await seal(source);f.state.images=targetImages;
 const target=await f.host(secondBoot,phase=>{if(phase==='complete')throw Error('Lost reply after commit');});
 await assert.rejects(target.complete(owner,request.operationId,{challenge:request.challenge,targetImages}));
 assert.equal((await target.complete(owner,request.operationId,{challenge:request.challenge,targetImages})).state,'complete');assert.equal(f.state.closed,false);
 const reopened=await f.host('f'.repeat(32));assert.equal(reopened.closed,false);assert.equal(reopened.get(owner,request.operationId).state,'complete');
});

test('a failed admission-close callback cannot advertise a durable gate, and a late writer reopens only pool continuations',async t=>{
 const f=await fixture(t),adapter={closeAdmission:async()=>{throw Error('Admission setup failed');}};
 const broken=await new Maintenance({directory:join(f.directory,'broken'),instanceId,images:()=>fromImages,adapter,bootId:firstBoot}).open();
 await assert.rejects(broken.prepare(owner,request));assert.equal(broken.closed,true);assert.throws(()=>broken.get(owner,request.operationId),{status:503});
 const good=await f.host();const originalFlush=good.adapter.flush;good.adapter.flush=async()=>{f.state.activity.writers=1;};
 await good.prepare(owner,request);await good.progressTask;assert.equal(good.get(owner,request.operationId).state,'draining');await good.progressTask;assert.equal(f.state.closed,true);assert.equal(f.state.poolClosed,false);
 good.adapter.flush=originalFlush;f.state.activity.writers=0;await progress(good);assert.equal(good.get(owner,request.operationId).state,'quiescent');
});

test('flush late-activity signal permits continuations and regains target restart proof before release',async t=>{
 const f=await fixture(t),source=await f.host();await source.prepare(owner,request);await source.progressTask;await seal(source);f.state.images=targetImages;const host=await f.host(secondBoot);
 const flush=host.adapter.flush;host.adapter.flush=async()=>{throw Object.assign(Error('Late writer'),{status:409,code:'MAINTENANCE_ACTIVITY_CHANGED'});};
 await assert.rejects(host.complete(owner,request.operationId,{challenge:request.challenge,targetImages}),{code:'MAINTENANCE_ACTIVITY_CHANGED'});await host.progressTask;assert.equal(host.get(owner,request.operationId).state,'draining');await host.progressTask;assert.equal(f.state.poolClosed,false);assert.equal(f.state.closed,true);
 host.adapter.flush=flush;const result=await progress(host);assert.equal(result.state,'restarted');assert.equal((await host.complete(owner,request.operationId,{challenge:request.challenge,targetImages})).state,'complete');
});

test('concurrent status never exposes prepare or quiescent receipts before their durable write',async t=>{
 for(const phase of ['prepare','quiescent']){
  const f=await fixture(t),host=await f.host(),persist=host.persist.bind(host);let entered,release,failed=false;
  const entering=new Promise(resolve=>entered=resolve),held=new Promise((_resolve,reject)=>release=reject);
  host.persist=async()=>{const state=host.active()?.receipt.state;if(!failed&&(phase==='prepare'||state==='quiescent')){failed=true;entered();await held;}if(failed)throw Error('Disk write failed');return persist();};
  const preparing=host.prepare(owner,request);preparing.catch(()=>{});if(phase==='quiescent')await preparing;
  await entering;
  try{if(phase==='prepare')assert.throws(()=>host.get(owner,request.operationId),{status:404});else assert.equal(host.get(owner,request.operationId).state,'draining');}
  finally{release(Error('Disk write failed'));}
  if(phase==='prepare')await assert.rejects(preparing);else await host.progressTask.catch(()=>{});
  assert.throws(()=>host.get(owner,request.operationId),{status:503});assert.equal(host.closed,true);
 }
});

test('concurrent seal and completion status is the committed snapshot; cancellation cannot reopen a sealed stop',async t=>{
 const f=await fixture(t),source=await f.host();await source.prepare(owner,request);await source.progressTask;
 const original=source.persist.bind(source);let entered,release;const entering=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
 source.persist=async()=>{entered();await held;return original();};const sealing=seal(source);await entering;
 assert.equal(source.get(owner,request.operationId).stopAuthorized,false);const cancel=source.cancel(owner,request.operationId,{challenge:request.challenge});cancel.catch(()=>{});release();assert.equal((await sealing).stopAuthorized,true);await assert.rejects(cancel,{status:409});
 f.state.images=targetImages;const target=await f.host(secondBoot),persist=target.persist.bind(target);let completing,deny;const writing=new Promise(resolve=>completing=resolve),blocked=new Promise((_resolve,reject)=>deny=reject);
 target.persist=async()=>{completing();await blocked;return persist();};const completion=target.complete(owner,request.operationId,{challenge:request.challenge,targetImages});completion.catch(()=>{});await writing;
 assert.equal(target.get(owner,request.operationId).state,'restarted');assert.equal(target.get(owner,request.operationId).admissionClosed,true);deny(Error('Completion disk failure'));await assert.rejects(completion);
 assert.equal(target.get(owner,request.operationId).state,'restarted');assert.equal(target.closed,true);target.persist=persist;
 assert.equal((await target.complete(owner,request.operationId,{challenge:request.challenge,targetImages})).state,'complete');
});

test('cancellation winning serialization prevents any later stop authorization',async t=>{
 const f=await fixture(t),source=await f.host();await source.prepare(owner,request);await source.progressTask;
 assert.equal((await source.cancel(owner,request.operationId,{challenge:request.challenge})).state,'cancelled');await assert.rejects(seal(source),{status:409});assert.equal(f.state.closed,false);
});
