import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { World, hash } from '../server/world.mjs';
import { Storage } from '../server/storage.mjs';
import { Platform } from '../server/platform.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { Code } from '../server/code.mjs';
import { Workflows } from '../server/workflows.mjs';
import { Schedules } from '../server/schedules.mjs';
import { Projects } from '../server/projects.mjs';
import { NativeJobs } from '../server/native-jobs.mjs';
import { RuntimePool } from '../server/runtime-pool.mjs';
import { LocalProvider } from '../infra/local-provider.mjs';
import { createMaintenanceHostAdapter } from '../server/maintenance-host.mjs';
import { maintenanceActivityFields } from '../server/maintenance.mjs';
import { validateCommands } from '../shared/app-commands.mjs';
import { SharedState } from '../shared/state.mjs';

const from='registry.invalid/runtime@sha256:'+'a'.repeat(64),target='registry.invalid/runtime@sha256:'+'b'.repeat(64),custom='registry.invalid/custom@sha256:'+'c'.repeat(64),appId='d'.repeat(32),releaseId='e'.repeat(32);
const request={retireRuntimeImage:true,fromImages:{runtime:from},targetImages:{runtime:target}};
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function setup(t){
  const directory=await mkdtemp(join(tmpdir(),'ink-maintenance-host-')),world=await new World(directory).open(),storage=await new Storage(directory,{env:{}}).open(),provider=new LocalProvider();
  const platform=await new Platform({root:directory,directory,world,storage,origin:'http://127.0.0.1',provider,adminToken:'fixture-private-admin'}).open();
  platform.collaboration=new Collaboration({directory,world,storage});await platform.collaboration.recover();platform.projects=await new Projects(directory).open();
  platform.workflows=await new Workflows({directory,platform}).open();platform.schedules=await new Schedules({directory,platform}).open();
  const native={tail:Promise.resolve(),compilations:new Map(),compatibility:async()=>({compatibilityKey:'a'.repeat(64),artifact:{manifest:{core_sha256:'c'.repeat(64)}}}),plan:async()=>({id:'b'.repeat(64),compatibilityKey:'a'.repeat(64),artifact:{manifest:{core_sha256:'c'.repeat(64)}}}),record:async()=>({sourceIdentity:'c'.repeat(64)}),build:async()=>({id:'b'.repeat(64),sourceIdentity:'c'.repeat(64),cached:false})};
  platform.nativeJobs=await new NativeJobs(join(directory,'native'),{native,source:async()=> 'module fixture;',enabled:true}).open();
  const code=platform.code=new Code(directory,join(directory,'code'),world),requests=new Set(),responses=new Set(),gate={closed:false},owners=[],refs={sockets:undefined};
  const adapter=createMaintenanceHostAdapter({platform,world,storage,code,requests,responses,sockets:()=>refs.sockets,externalClosed:()=>gate.closed});
  t.after(async()=>{for(const release of owners)release();platform.workflows.close();platform.schedules.close();while(platform.workflows.active.size||platform.workflows.pumping||platform.workflows.runs.some(run=>run.status==='queued')){await platform.workflows.pump();await Promise.all([...platform.workflows.active.values()].map(marker=>marker.promise).filter(Boolean));await new Promise(resolve=>setImmediate(resolve));}await platform.workflows.projectPending();await platform.workflows.tail;await world.tail;await platform.nativeJobs.close();await platform.collaboration.close();if(platform.provider?.pool)await platform.provider.pool.close();provider.servers.clear();await provider.close();await rm(directory,{recursive:true,force:true});});
  return{directory,world,storage,platform,provider,code,requests,responses,gate,adapter,owners,native,refs};
}
function zero(value){assert.deepEqual(Object.keys(value).sort(),[...maintenanceActivityFields].sort());assert.ok(Object.values(value).every(number=>number===0),JSON.stringify(value));}
async function emptyPool(f){const pool=await new RuntimePool({directory:f.directory,provider:{},runtime:f.platform.runtime,environment:f.platform.environment,origin:f.platform.origin}).open({sweep:false});f.platform.provider={pooled:true,pool};return pool;}
async function close(f,options){f.gate.closed=true;f.adapter.closeAdmission(options);}
async function releaseRecord(f,{override,legacy}={}){
  await f.world.put({id:releaseId,namespace:'os',kind:'release',body:JSON.stringify({appId,backend:override?{entry:'server.mjs',runtimeImage:override}:null,deployment:legacy||{provider:'pool'}})},{writer:'os'});
  await f.world.put({id:appId,namespace:'os',kind:'app',body:JSON.stringify({slug:'fixture',releaseId})},{writer:'os'});
}

test('close is synchronous, ends SSE only, preserves active jobs, and resume restores user-facing timers',async t=>{
  const f=await setup(t);f.platform.workflows.start();f.platform.schedules.start();const sse=new ServerResponse({method:'GET'}),ordinary=new ServerResponse({method:'GET'});sse.setHeader('content-type','text/event-stream');ordinary.setHeader('content-type','application/json');f.responses.add(sse);f.responses.add(ordinary);f.platform.workflows.active.set('owned',{promise:Promise.resolve()});
  f.gate.closed=true;const result=f.adapter.closeAdmission({poolClosed:false});assert.equal(result,undefined);assert.equal(sse.writableEnded,true);assert.equal(ordinary.writableEnded,false);assert.equal(f.platform.workflows.active.size,1);assert.equal(f.platform.workflows.timer,null);assert.equal(f.platform.schedules.timer,undefined);assert.equal(f.platform.nativeJobs.accepting,true);
  f.platform.workflows.active.clear();ordinary.end();assert.throws(()=>f.adapter.resumeAdmission(),{code:'MAINTENANCE_ADMISSION_MISMATCH'});f.gate.closed=false;f.adapter.resumeAdmission();assert.ok(f.platform.workflows.timer);assert.ok(f.platform.schedules.timer);assert.equal(f.platform.nativeJobs.accepting,true);
});

test('settled retained promises do not count as permanent activity; actual delayed tasks and all nine fields are observed',async t=>{
  const f=await setup(t);f.code.compilations.set('cached',Promise.resolve({artifact:true}));f.platform.releaseTails.set('historical',Promise.resolve());f.native.compilations.set('cached',Promise.resolve({artifact:true}));await new Promise(resolve=>setImmediate(resolve));zero(await f.adapter.activity());
  const held=deferred();f.owners.push(held.resolve);f.requests.add(held.promise);f.platform.publishTail=held.promise;f.platform.releaseTails.set('live',held.promise);f.platform.projects.operations.set('live',held.promise);f.platform.keysTail=held.promise;f.storage.aliases.tail=held.promise;f.platform.runtime.writers.set('runtime',1);f.platform.collaboration.activeMessages=1;
  const task=f.code.serializeState('fixture','state',async()=>{await held.promise;});const state=await f.adapter.activity();assert.ok(state.requests>0);assert.ok(state.writers>0);assert.ok(state.publications>0);assert.ok(state.codeTasks>0);
  held.resolve();await task;f.requests.clear();f.platform.projects.operations.clear();f.platform.runtime.writers.clear();f.platform.collaboration.activeMessages=0;zero(await f.adapter.activity());
});

test('private store and project mutation queues are individually probed instead of assumed idle',async t=>{
  const f=await setup(t),stores=[f.platform.apiKeys,f.platform.environment,f.platform.runtime,f.platform.projects,f.platform.projects.publisher,f.platform.projects.credentials.store,f.platform.nativeJobs,f.platform.workflows,f.platform.schedules,f.storage.aliases];
  for(const store of stores){const held=deferred(),original=store.tail;f.owners.push(held.resolve);store.tail=held.promise;assert.ok((await f.adapter.activity()).writers>0);held.resolve();await held.promise;store.tail=original;}
  const held=deferred();f.owners.push(held.resolve);const locked=f.storage.lockBlob('a'.repeat(64),()=>held.promise),blob=await f.storage.put(Buffer.from('retained fixture'),undefined,{retain:true});assert.ok((await f.adapter.activity()).writers>0);held.resolve();await locked;blob.release();zero(await f.adapter.activity());
});

test('an actual admitted WebSocket mutation completes while new admission is closed and remains counted until durable',async t=>{
  const f=await setup(t),server=createServer(),sockets=f.platform.collaboration.attach(server,()=>f.gate.closed?null:{owner:true,accountId:'owner',namespace:'os'});f.refs.sockets=sockets;server.listen(0,'127.0.0.1');await once(server,'listening');const client=new WebSocket('ws://127.0.0.1:'+server.address().port+'/api/v1/sync');await once(client,'open');
  t.after(async()=>{client.close();await new Promise(resolve=>sockets.close(resolve));await new Promise(resolve=>server.close(resolve));});
  const doc=await f.platform.collaboration.document('os','websocket-fixture','state'),held=deferred();f.owners.push(held.resolve);doc.tail=doc.tail.then(()=>held.promise);const state=new SharedState({actor:123n});client.send(JSON.stringify({type:'update',namespace:'os',key:'websocket-fixture',kind:'state',updates:state.set('/saved',{exact:9})}));
  for(let i=0;i<100&&!f.platform.collaboration.activeMessages;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(f.platform.collaboration.activeMessages,1);await close(f);assert.ok((await f.adapter.activity()).writers>0);held.resolve();
  for(let i=0;i<100&&f.platform.collaboration.activeMessages;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(f.platform.collaboration.activeMessages,0);assert.deepEqual(doc.replica.get('/saved'),{exact:9});
});

test('accepted native jobs finish during draining and new enqueue is sealed only at quiescence',async t=>{
  const f=await setup(t),held=deferred();f.owners.push(held.resolve);f.native.build=async()=>{await held.promise;return{id:'b'.repeat(64),sourceIdentity:'c'.repeat(64),cached:false};};
  await f.platform.nativeJobs.change(jobs=>jobs.push({id:'1'.repeat(32),appId,releaseId,compatibilityKey:'a'.repeat(64),status:'queued'}));await close(f);const activity=await f.adapter.activity();assert.ok(activity.nativeJobs>0);assert.equal(f.platform.nativeJobs.accepting,true);
  held.resolve();await f.platform.nativeJobs.pumping;assert.equal(f.platform.nativeJobs.jobs[0].status,'succeeded');zero(await f.adapter.activity());assert.equal((await f.adapter.quiescePool(request)).admissionClosed,true);assert.equal(f.platform.nativeJobs.accepting,false);await assert.rejects(f.platform.nativeJobs.enqueue(appId,releaseId),{status:503});
});

test('an admitted native enqueue remains durable when source preflight crosses external admission closure',async t=>{
  const f=await setup(t),held=deferred();f.owners.push(held.resolve);f.platform.nativeJobs.source=async()=>{await held.promise;return'module admitted;';};
  const enqueue=f.platform.nativeJobs.enqueue(appId,releaseId);f.requests.add(enqueue);enqueue.finally(()=>f.requests.delete(enqueue));await close(f);assert.equal(f.platform.nativeJobs.accepting,true);assert.ok((await f.adapter.activity()).requests>0);
  held.resolve();const accepted=await enqueue;assert.match(accepted.id,/^[a-f0-9]{32}$/);assert.equal(f.platform.nativeJobs.jobs.length,1);await f.platform.nativeJobs.pumping;assert.equal(f.platform.nativeJobs.jobs[0].status,'succeeded');
  await f.adapter.quiescePool(request);assert.equal(f.platform.nativeJobs.accepting,false);f.adapter.continueDraining();assert.equal(f.platform.nativeJobs.accepting,true);assert.equal(f.gate.closed,true);
});

test('already accepted queued workflows are pumped to completion after scheduler timers stop',async t=>{
  const f=await setup(t),held=deferred();f.owners.push(held.resolve);const app=await f.platform.createApp({slug:'maintenance-workflow',title:'Fixture workflow'}),commands=validateCommands([{id:'run',title:'Run',handler:{type:'backend',path:'/run'},effect:'write'}]);
  await f.world.update(app.id,{body:JSON.stringify({...JSON.parse(app.body),releaseId,commands})},{writer:'os'});
  const definition=await f.platform.workflows.save({owner:true,accountId:'owner'},{definition:{title:'Accepted work',steps:[{id:'one',appId:app.id,commandId:'run',bindings:{}}]}});
  const preview=f.platform.workflows.preview({owner:true,accountId:'owner'},{id:definition.id});f.platform.workflows.pumping=true;f.platform.workflows.invoke=async()=>{await held.promise;return{data:{done:true}};};
  await f.platform.workflows.run({owner:true,accountId:'owner'},{id:definition.id,fingerprint:preview.fingerprint,requestId:'accepted-maintenance-run',approved:true});assert.equal(f.platform.workflows.runs[0].status,'queued');f.platform.workflows.pumping=false;
  await close(f);assert.ok((await f.adapter.activity()).workflows>0);held.resolve();for(let i=0;i<100&&f.platform.workflows.runs[0].status!=='succeeded';i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.platform.workflows.runs[0].status,'succeeded');assert.equal(f.platform.workflows.timer,null);
});

test('pool pending/admission/request work is measured and continueDraining reopens only the pool under a closed external gate',async t=>{
  const f=await setup(t),pool=await emptyPool(f),held=deferred();f.owners.push(held.resolve);pool.pending.set('assign',held.promise);pool.admissions.add('admission');pool.requests.set('lease',2);await close(f,{poolClosed:true});assert.equal(pool.admissionClosed,true);
  const state=await f.adapter.activity();assert.ok(state.poolAssignments>=2);assert.equal(state.poolRequests,2);f.adapter.continueDraining();assert.equal(pool.admissionClosed,false);assert.equal(f.platform.nativeJobs.accepting,true);assert.equal(f.platform.schedules.timer,undefined);
  f.gate.closed=false;assert.throws(()=>f.adapter.continueDraining(),{code:'MAINTENANCE_ADMISSION_MISMATCH'});f.gate.closed=true;held.resolve();pool.pending.clear();pool.admissions.clear();pool.requests.clear();zero(await f.adapter.activity());
});

test('real empty RuntimePool proof is augmented with installed pins and same-image retirement blockers are normalized',async t=>{
  const f=await setup(t),pool=await emptyPool(f);await close(f);await releaseRecord(f,{override:custom});const proof=await f.adapter.quiescePool(request);assert.equal(proof.admissionClosed,true);assert.equal(proof.uncertain,0);assert.deepEqual(proof.customRuntimeImages,[custom]);assert.equal(proof.incompatibleRuntimeOverrides,0);
  const release=f.world.get(releaseId),meta=JSON.parse(release.body);meta.backend.runtimeImage=from;await f.world.update(releaseId,{body:JSON.stringify(meta)},{writer:'os'});pool.releaseMaintenance();const incompatible=await f.adapter.quiescePool(request);assert.equal(incompatible.incompatibleRuntimeOverrides,1);assert.equal(incompatible.admissionClosed,false);
  const original=pool.maintenanceQuiesce.bind(pool);pool.maintenanceQuiesce=async()=>({...await original({retireRuntimeImage:false,fromRuntimeImage:from,targetRuntimeImage:from}),oldRuntimeSlotsRemaining:3});const same=await f.adapter.quiescePool({retireRuntimeImage:false,fromImages:{runtime:from},targetImages:{runtime:from}});assert.equal(same.oldRuntimeSlotsRemaining,0);assert.equal(same.incompatibleRuntimeOverrides,0);assert.deepEqual(same.customRuntimeImages,[]);
});

test('historical callable runtime overrides block retirement even when selection is unpinned and the old release is parked or archived',async t=>{
  const f=await setup(t),pool=await emptyPool(f);await releaseRecord(f);await close(f);let probes=0;const inspect=pool.maintenanceQuiesce.bind(pool);pool.maintenanceQuiesce=(input)=>{probes++;return inspect(input);};
  const oldId='3'.repeat(32),old={appId,backend:{entry:'server.mjs',runtimeImage:from},deployment:{provider:'pool'}};await f.world.put({id:oldId,namespace:'os',kind:'release',body:JSON.stringify(old)},{writer:'os'});
  for(const flags of[{parked:false,archived:false},{parked:true,archived:false},{parked:true,archived:true}]){
    await f.world.update(oldId,{archived:flags.archived,body:JSON.stringify({...old,deployment:{provider:'pool',parked:flags.parked}})},{writer:'os'});
    const proof=await f.adapter.quiescePool(request);assert.equal(proof.incompatibleRuntimeOverrides,1);assert.equal(proof.admissionClosed,false);assert.equal(probes,0,'known incompatible pins must not cause a provider stop/probe');
  }
  await f.world.update(oldId,{body:JSON.stringify({...old,backend:{entry:'server.mjs',runtimeImage:custom}})},{writer:'os'});const inventory=await f.adapter.quiescePool(request);assert.deepEqual(inventory.customRuntimeImages,[custom]);assert.equal(inventory.incompatibleRuntimeOverrides,0);
});

test('real RuntimePool retirement is the only path that removes a verified stopped runtime slot',async t=>{
  const f=await setup(t),pool=await emptyPool(f),slotId='1'.repeat(32);let removed=0;
  pool.provider={poolStopped:async()=>true,removeStopped:async()=>{removed++;return{removed:true};}};pool.slots.push({id:slotId,kind:'module',status:'idle',appId:null,releaseId:null,leaseId:null,holds:[],deployment:{runtimeImage:from,appId,releaseId,leaseId:'2'.repeat(32),app:'fixture',machineId:'fixture'}});
  await close(f);const proof=await f.adapter.quiescePool(request);assert.equal(proof.admissionClosed,true);assert.equal(proof.oldRuntimeSlotsRemaining,0);assert.deepEqual(proof.retired,[slotId]);assert.equal(removed,1);assert.equal(pool.slots.length,0);
});

test('independent local servers, legacy deployment machines and unsupported pools remain explicit blockers without stops',async t=>{
  const f=await setup(t);await close(f);let stopped=0;f.provider.servers.set('independent',{server:{close:()=>stopped++},connections:{close:()=>stopped++}});let proof=await f.adapter.quiescePool(request);assert.ok(proof.uncertain>0);assert.ok(proof.diagnostics.some(row=>row.reason==='independent-local-release-server'));assert.equal(stopped,0);f.provider.servers.clear();
  await releaseRecord(f,{legacy:{provider:'pool',legacyBackend:true,legacy:{provider:'fly',url:'https://fixture.invalid'}}});proof=await f.adapter.quiescePool(request);assert.ok(proof.diagnostics.some(row=>row.reason==='unpooled-legacy-deployment'));assert.equal(stopped,0);
  await f.world.update(releaseId,{body:JSON.stringify({appId,deployment:{provider:'pool'},backend:null})},{writer:'os'});f.platform.provider={pooled:true,pool:{slots:[],admissionClosed:false}};proof=await f.adapter.quiescePool(request);assert.ok(proof.uncertain>0);assert.ok(proof.diagnostics.some(row=>row.reason==='pool-maintenance-unavailable'));delete f.platform.provider.pool;
});

test('backend deployment metadata cannot certify an empty host when its expected pool is missing',async t=>{
  const f=await setup(t);await releaseRecord(f,{override:custom});await close(f);const proof=await f.adapter.quiescePool(request);assert.ok(proof.uncertain>0);assert.ok(proof.diagnostics.some(row=>row.reason==='pooled-backend-without-pool'));assert.equal(proof.admissionClosed,false);
});

test('flush opens indexed documents, projects/checkpoints real causal state, and leaves journals usable after resume',async t=>{
  const f=await setup(t);await f.platform.collaboration.state({owner:true,namespace:'os'},'value','os',{exact:9},0,true);await f.platform.collaboration.close();
  const recordId=hash('os\0state\0value').slice(0,32);await f.world.update(recordId,{body:JSON.stringify({stale:true})},{writer:'os'});f.platform.collaboration=new Collaboration({directory:f.directory,world:f.world,storage:f.storage});await f.platform.collaboration.index();assert.equal(f.platform.collaboration.documents.size,0);
  await close(f);assert.equal((await f.adapter.quiescePool(request)).admissionClosed,true);zero(await f.adapter.activity());await f.adapter.flush();assert.deepEqual(JSON.parse(f.world.get(recordId).body),{exact:9});const doc=await f.platform.collaboration.document('os','state','state');assert.ok(doc.journal.fd>=0);assert.ok(JSON.parse(await readFile(join(doc.dir,'checkpoint.json'))).bytes);zero(await f.adapter.activity());
  f.gate.closed=false;f.adapter.resumeAdmission();const current=await f.platform.collaboration.state({owner:true},'value','os');await f.platform.collaboration.state({owner:true},'value','os',{exact:10},current.revision,true);assert.deepEqual((await f.platform.collaboration.state({owner:true},'value','os')).value,{exact:10});
});

test('late writer causes the explicit retry signal instead of blocking behind its SDK continuations',async t=>{
  const f=await setup(t),pool=await emptyPool(f);await close(f,{poolClosed:true});const held=deferred();f.owners.push(held.resolve);const writer=f.world.transact(async()=>held.promise);
  await assert.rejects(f.adapter.flush(),{code:'MAINTENANCE_ACTIVITY_CHANGED'});assert.equal(pool.admissionClosed,true);f.adapter.continueDraining();assert.equal(pool.admissionClosed,false);held.resolve();await writer;
});

test('pending migration WALs, gates and failed journal state cannot become quiescent',async t=>{
  const f=await setup(t);await close(f);await mkdir(join(f.directory,'namespace-migrations'));const path=join(f.directory,'namespace-migrations','pending.json');await writeFile(path,'{}',{mode:0o600});await assert.rejects(f.adapter.activity(),{code:'MAINTENANCE_PENDING_WAL'});await unlink(path);
  f.platform.namespaceMigrations={ready:false,tail:Promise.resolve()};await assert.rejects(f.adapter.activity(),{code:'MAINTENANCE_MIGRATION_UNREADY'});delete f.platform.namespaceMigrations;
  const doc=await f.platform.collaboration.document('os','fixture','state');doc.writeError=Error('fixture journal failure');await assert.rejects(f.adapter.activity(),{code:'MAINTENANCE_DOCUMENT_UNREADY'});doc.writeError=null;
});
