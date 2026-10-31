import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World, hash } from '../server/world.mjs';
import { APIKeys } from '../server/api-keys.mjs';
import { Workflows } from '../server/workflows.mjs';
import { Schedules } from '../server/schedules.mjs';
import { AutomationMigrations } from '../server/automation-migrations.mjs';
import { workflowDefinition } from '../shared/workflows.mjs';
import { validateCommands } from '../shared/app-commands.mjs';

const appId='a'.repeat(32),workflowApp='b'.repeat(32),releaseId='c'.repeat(32),otherRelease='d'.repeat(32),operation='e'.repeat(32),definitionId='1'.repeat(32),jobId='2'.repeat(32),cancelledId='3'.repeat(32),sourceRelease='f'.repeat(32);
const principal={owner:true,admin:true,accountId:'owner',accountName:'Admin',namespace:'os'};
const command=validateCommands([{id:'advance',title:'Advance',handler:{type:'backend',path:'/advance'},effect:'write',idempotent:true}])[0];
function source(){
  const definition={...workflowDefinition({title:'Imported definition',steps:[{id:'one',appId,commandId:'advance',bindings:{}}]}),id:definitionId,appId:workflowApp,revision:3,createdAt:100,updatedAt:200,updatedBy:{type:'account',id:'source-member',name:'Source author'},archived:false};
  const runs=['succeeded','queued','running'].map((status,index)=>({id:String(index+4).repeat(32),executionId:String(index+4).repeat(32),requestId:'source-request-'+index,workflowId:definitionId,title:definition.title,workflowRevision:3,definition,inputs:{},fingerprint:'source-contract',actor:{type:'account',id:'source-member',name:'Source actor'},authority:{type:'account',accountId:'source-member',keyId:'source-private-key-id',scopes:['source-privilege']},status,createdAt:100,updatedAt:200,startedAt:status==='queued'?undefined:110,finishedAt:status==='succeeded'?200:null,steps:[{id:'one',appId,commandId:'advance',bindings:{},command,pollCommand:null,releaseId:sourceRelease,effect:'write',status:status==='succeeded'?'succeeded':status==='queued'?'pending':'running',...(status==='succeeded'?{output:{saved:true}}:{})}],artifacts:[]}));
  const jobs=[{id:jobId,appId,ownerType:'app',ownerId:appId,name:'Imported future work',path:'/job',method:'POST',body:{marker:'fixture'},everyMs:60000,nextAt:100,enabled:true,createdAt:100,updatedAt:200,cancelledAt:null},{id:cancelledId,appId,ownerType:'account',ownerId:'source-member',name:'Cancelled history',path:'/job',method:'POST',body:{},everyMs:null,nextAt:100,enabled:false,createdAt:100,updatedAt:200,cancelledAt:300}];
  const scheduledRuns=['running','succeeded','queued'].map((status,index)=>({id:String(index+7).repeat(32),jobId:index===1?cancelledId:jobId,appId,scheduledFor:100,startedAt:110,finishedAt:status==='succeeded'?200:null,status,manual:false,httpStatus:status==='succeeded'?200:undefined,releaseId:sourceRelease}));
  const wrap=value=>{const bytes=Buffer.from(JSON.stringify(value));return{bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')};};
  return{format:'ink-os-automation-export-v1',capturedAt:'2026-10-01T00:00:00.000Z',consistency:'individually-atomic-files-not-joint',sourceVersionCut:{id:'0'.repeat(32),manifestDigest:'a'.repeat(64)},files:{'workflows.json':wrap({version:1,definitions:[definition],runs}),'schedules.json':wrap({version:1,jobs,runs:scheduledRuns})}};
}
async function host(directory,{existing=false,fault,clock={now:1000000}}={}){
  const world=await new World(directory).open();if(!existing)for(const[id,slug]of[[appId,'backend'],[workflowApp,'workflows']])await world.put({id,namespace:'os',kind:'app',title:slug,body:JSON.stringify({slug,desktop:{entry:'app'},capabilities:['apps.invoke','world.read','world.write'],commands:[command]})},{writer:'os'});
  const apiKeys=await new APIKeys(directory).open(),calls=[];const platform={world,directory,apiKeys,adminToken:'fixture-target-private-token',apps:()=>world.all().filter(row=>row.kind==='app'&&!row.archived),app:id=>{const app=world.get(id);if(!app||app.kind!=='app'||app.archived)throw Object.assign(Error('Missing app'),{status:404});return app;}};
  const migrations=new AutomationMigrations({directory,world,fault,now:()=>clock.now});await migrations.recover();
  const workflows=await new Workflows({directory,platform,now:()=>clock.now,invoke:async(p,actor,input,options)=>{calls.push({kind:'workflow',actor,input,options});return{data:{saved:true}};},onError:error=>{throw error;}}).open();
  const schedules=await new Schedules({directory,platform,now:()=>clock.now,invoke:async(id,input)=>{calls.push({kind:'schedule',appId:id,input});return{status:200,body:{done:true}};},onError:error=>{throw error;}}).open();
  platform.workflows=workflows;platform.schedules=schedules;migrations.attach({platform,workflows,schedules});return{directory,world,platform,workflows,schedules,migrations,calls,clock};
}
async function setup(t,options={}){const directory=await mkdtemp(join(tmpdir(),'ink-automation-migration-')),target=await host(directory,options),owners=[target];t.after(async()=>{for(const owner of owners){owner.workflows.close();owner.schedules.close();}await rm(directory,{recursive:true,force:true});});const input={operation,source:source(),workflowIds:[definitionId],scheduleIds:[jobId,cancelledId],rebindToAuthenticatedAdmin:true};input.expected=(await target.migrations.plan(principal,input)).expected;return{target,input,directory,owners};}
async function publish(target,id=releaseId){await target.world.put({id,namespace:'os',kind:'release',title:'Current target release',body:JSON.stringify({appId,backend:{entry:'server.mjs'}})},{writer:'os'});const app=target.world.get(appId);await target.world.update(appId,{body:JSON.stringify({...JSON.parse(app.body),releaseId:id})},{writer:'os'});}
async function settled(target){for(let i=0;i<100;i++){if(!target.workflows.active.size&&!target.schedules.active.size&&!target.workflows.pumping)return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Fixture execution did not settle');}

test('authoritative import preserves IDs/history, rebinds admin and leaves unfinished work and schedules inert across restart',async t=>{
  const f=await setup(t),original=JSON.stringify(f.input.source),receipt=await f.target.migrations.apply(principal,f.input);
  assert.equal(receipt.jointCut,false);assert.equal(receipt.mode,'inert-history');assert.equal(f.target.workflows.definitions[0].id,definitionId);
  assert.deepEqual(f.target.workflows.runs.map(run=>run.status),['succeeded','interrupted','interrupted']);assert.deepEqual(f.target.schedules.runs.map(run=>run.status),['interrupted','succeeded','interrupted']);
  assert.ok(f.target.schedules.jobs.every(job=>!job.enabled&&job.ownerType==='account'&&job.ownerId==='owner'));assert.equal(f.target.schedules.jobs.find(job=>job.id===cancelledId).cancelledAt,300);
  assert.ok(f.target.workflows.runs.every(run=>run.authority.accountId==='owner'&&!run.authority.keyId&&!run.authority.scopes.includes('source-privilege')));
  assert.ok(!JSON.stringify(f.target.workflows.runs).includes('source-private-key-id'));assert.ok(f.target.workflows.runs.every(run=>run.steps[0].releaseId===sourceRelease));assert.equal(JSON.stringify(f.input.source),original);
  await f.target.workflows.pump();await f.target.schedules.tick();assert.equal(f.target.calls.length,0);
  f.target.workflows.close();f.target.schedules.close();const reopened=await host(f.directory,{existing:true,clock:f.target.clock});f.owners.splice(0,1,reopened);await reopened.workflows.pump();await reopened.schedules.tick();assert.equal(reopened.calls.length,0);assert.equal((await reopened.migrations.apply(principal,f.input)).replayed,true);
  const projection=JSON.parse(reopened.world.get(f.target.workflows.runs[1].id).body);assert.equal(projection.authority,undefined);assert.equal(projection.status,'interrupted');
});

test('imported workflow retry is rejected; ordinary current preview/approval creates a fresh target run',async t=>{
  const f=await setup(t);await f.target.migrations.apply(principal,f.input);await publish(f.target);
  await assert.rejects(f.target.workflows.retry(principal,{runId:'5'.repeat(32),approved:true,requestId:'fresh-retry-request'}),{status:409});
  const preview=f.target.workflows.preview(principal,{id:definitionId,inputs:{}});assert.equal(preview.requiresApproval,true);
  await assert.rejects(f.target.workflows.run(principal,{id:definitionId,inputs:{},fingerprint:preview.fingerprint,requestId:'fresh-normal-run'}),{status:409});
  await f.target.workflows.run(principal,{id:definitionId,inputs:{},fingerprint:preview.fingerprint,requestId:'fresh-normal-run',approved:true});await settled(f.target);
  assert.equal(f.target.calls.length,1);assert.equal(f.target.calls[0].options.releaseId,releaseId);assert.equal(f.target.calls[0].actor.accountId,'owner');
});

test('schedule review requires future time, approval and current backend/config; review remains disabled until normal explicit enable',async t=>{
  const f=await setup(t);await f.target.migrations.apply(principal,f.input);await publish(f.target);
  await assert.rejects(f.target.schedules.run(principal,appId,jobId),{status:409});await assert.rejects(f.target.schedules.update(principal,appId,jobId,{enabled:true}),{status:409});
  assert.throws(()=>f.target.migrations.previewScheduleReview(principal,{appId,jobId,at:1}),{status:400});
  const at=f.target.clock.now+10000,preview=f.target.migrations.previewScheduleReview(principal,{appId,jobId,at});
  await assert.rejects(f.target.migrations.reviewSchedule(principal,{appId,jobId,at,fingerprint:preview.fingerprint}),{status:409});
  const reviewed=await f.target.migrations.reviewSchedule(principal,{appId,jobId,at,fingerprint:preview.fingerprint,approved:true});assert.equal(reviewed.enabled,false);
  await f.target.schedules.update(principal,appId,jobId,{enabled:true});await f.target.schedules.run(principal,appId,jobId);await settled(f.target);assert.equal(f.target.calls.length,1);assert.equal(f.target.calls[0].input.releaseId,releaseId);
  await f.target.schedules.update(principal,appId,jobId,{body:{changed:true}});assert.equal(f.target.schedules.get(principal,appId,jobId).enabled,false);await assert.rejects(f.target.schedules.run(principal,appId,jobId),{status:409});
  assert.throws(()=>f.target.migrations.previewScheduleReview(principal,{appId,jobId:cancelledId,at}),{status:409});
});

test('already queued mutation callbacks reject and drain through the barrier without deadlocking either store',async t=>{
  const f=await setup(t);let release,called=0;const held=new Promise(resolve=>release=resolve);f.target.workflows.tail=held;f.target.schedules.tail=held;
  const workflowMutation=f.target.workflows.change(()=>{called++;}).catch(error=>error),scheduleMutation=f.target.schedules.change(()=>{called++;}).catch(error=>error);
  const applying=f.target.migrations.apply(principal,f.input);
  for(let i=0;i<100&&!f.target.workflows.migrationBlocked;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(f.target.workflows.migrationBlocked,true);release();
  assert.equal((await workflowMutation).status,503);assert.equal((await scheduleMutation).status,503);assert.equal((await applying).mode,'inert-history');assert.equal(called,0);
});

test('manual rescheduling invalidates approval while ordinary recurring execution can advance its next occurrence',async t=>{
  const f=await setup(t);await f.target.migrations.apply(principal,f.input);await publish(f.target);const at=f.target.clock.now+10000,preview=f.target.migrations.previewScheduleReview(principal,{appId,jobId,at});await f.target.migrations.reviewSchedule(principal,{appId,jobId,at,fingerprint:preview.fingerprint,approved:true});await f.target.schedules.update(principal,appId,jobId,{enabled:true});
  f.target.clock.now=at+1;await f.target.schedules.tick();await settled(f.target);assert.equal(f.target.calls.length,1);assert.equal(f.target.schedules.migrationReviewed(f.target.schedules.get(principal,appId,jobId)),true);
  await f.target.schedules.update(principal,appId,jobId,{at:f.target.clock.now+20000});assert.equal(f.target.schedules.get(principal,appId,jobId).enabled,false);await assert.rejects(f.target.schedules.run(principal,appId,jobId),{status:409});
});

test('persistence failure rolls back both files and World; retry then succeeds without duplicate records',async t=>{
  const f=await setup(t),persist=f.target.world.persist.bind(f.target.world);let failed=false;f.target.world.persist=async()=>{if(!failed){failed=true;throw Error('Fixture World persistence failure');}return persist();};
  await assert.rejects(f.target.migrations.apply(principal,f.input));assert.equal(f.target.workflows.definitions.length,0);assert.equal(f.target.schedules.jobs.length,0);assert.equal(f.target.world.get(definitionId),null);
  assert.equal((await f.target.migrations.apply(principal,f.input)).mode,'inert-history');assert.equal(f.target.workflows.definitions.length,1);assert.equal(f.target.schedules.jobs.length,2);
});

test('authoritative file aliases and store-size limits fail before replacing either store',async t=>{
  const f=await setup(t),outside=join(f.directory,'protected.json'),path=join(f.directory,'workflows.json');await writeFile(outside,JSON.stringify({version:1,definitions:[],runs:[]}),{mode:0o600});await symlink(outside,path);
  await assert.rejects(f.target.migrations.apply(principal,f.input),{status:409});assert.equal(await readFile(outside,'utf8'),JSON.stringify({version:1,definitions:[],runs:[]}));await unlink(path);
  f.target.migrations.limits.stagedBytes=1;await assert.rejects(f.target.migrations.apply(principal,f.input),{status:413});assert.equal(f.target.world.get(definitionId),null);
});

test('backend replacement invalidates review before automatic or manual execution',async t=>{
  const f=await setup(t);await f.target.migrations.apply(principal,f.input);await publish(f.target);const at=f.target.clock.now+10000,preview=f.target.migrations.previewScheduleReview(principal,{appId,jobId,at});await f.target.migrations.reviewSchedule(principal,{appId,jobId,at,fingerprint:preview.fingerprint,approved:true});await f.target.schedules.update(principal,appId,jobId,{enabled:true});
  await publish(f.target,otherRelease);f.target.clock.now=at+1;await f.target.schedules.tick();assert.equal(f.target.calls.length,0);assert.equal(f.target.schedules.get(principal,appId,jobId).enabled,false);await assert.rejects(f.target.schedules.run(principal,appId,jobId),{status:409});
});

for(const point of ['intent','workflows.json','schedules.json','decision'])test('crash at '+point+' is recovered before either authoritative store opens',async t=>{
  let fired=false;const f=await setup(t,{fault:stage=>{if(stage===point&&!fired){fired=true;throw Object.assign(Error('Fixture crash'),{simulateCrash:true});}}});
  await assert.rejects(f.target.migrations.apply(principal,f.input));assert.equal(f.target.migrations.ready,false);assert.throws(()=>f.target.workflows.list(principal),{status:503});assert.throws(()=>f.target.schedules.list(principal),{status:503});
  const reopened=await host(f.directory,{existing:true,clock:f.target.clock});f.owners.splice(0,1,reopened);
  if(point==='decision'){assert.equal(reopened.workflows.runs.length,3);assert.equal(reopened.schedules.runs.length,3);assert.equal((await reopened.migrations.apply(principal,f.input)).replayed,true);}
  else{assert.equal(reopened.workflows.runs.length,0);assert.equal(reopened.schedules.runs.length,0);assert.equal(reopened.world.get(definitionId),null);}
  await reopened.workflows.pump();await reopened.schedules.tick();assert.equal(reopened.calls.length,0);
});

test('busy, queued and pending-projection targets fail without changing stores or trapping mutation tails',async t=>{
  const f=await setup(t),before=f.target.world.version;
  for(const kind of['active','queued','projection']){
    if(kind==='active')f.target.schedules.active.set('busy',{});if(kind==='queued')f.target.workflows.runs.push({id:'0'.repeat(32),status:'queued'});if(kind==='projection')f.target.workflows.pendingProjection.add('0'.repeat(32));
    await assert.rejects(f.target.migrations.apply(principal,f.input),{status:409});assert.equal(f.target.world.version,before);assert.equal(f.target.workflows.migrationBlocked,false);assert.equal(f.target.schedules.migrationBlocked,false);
    f.target.schedules.active.clear();f.target.workflows.runs=[];f.target.workflows.pendingProjection.clear();
  }
  await f.target.schedules.change(draft=>{draft.jobs=[];});f.input.expected=(await f.target.migrations.plan(principal,f.input)).expected;assert.equal((await f.target.migrations.apply(principal,f.input)).mode,'inert-history');
});

test('raw secret-bearing authority envelope, nonadmin, source digest mutation and published app guards reject import',async t=>{
  const f=await setup(t),raw={...f.input,source:{...f.input.source,environmentKey:'private-fixture-key'}};await assert.rejects(f.target.migrations.apply(principal,raw),{status:400});
  await assert.rejects(f.target.migrations.apply({...principal,accountId:'member',admin:false},f.input),{status:403});
  const bad=structuredClone(f.input);bad.source.files['workflows.json'].sha256='0'.repeat(64);await assert.rejects(f.target.migrations.apply(principal,bad),{status:400});
  await publish(f.target);await assert.rejects(f.target.migrations.apply(principal,f.input),{status:409});assert.equal(f.target.workflows.runs.length,0);
});

test('uncertain outcomes become inert interrupted history and unknown secret-bearing store metadata is rejected',async t=>{
  const f=await setup(t),store=JSON.parse(Buffer.from(f.input.source.files['workflows.json'].base64,'base64'));store.runs[1].status='uncertain';store.runs[1].steps[0].status='uncertain';
  const wrap=value=>{const bytes=Buffer.from(JSON.stringify(value));return{bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')};};
  f.input.source.files['workflows.json']=wrap(store);f.input.expected=(await f.target.migrations.plan(principal,f.input)).expected;await f.target.migrations.apply(principal,f.input);assert.equal(f.target.workflows.runs[1].status,'interrupted');assert.equal(f.target.workflows.runs[1].migration.sourceStatus,'uncertain');assert.equal(f.target.calls.length,0);
  const g=await setup(t),bad=JSON.parse(Buffer.from(g.input.source.files['schedules.json'].base64,'base64'));bad.jobs[0].environmentKey='forbidden-fixture-field';g.input.source.files['schedules.json']=wrap(bad);await assert.rejects(g.target.migrations.apply(principal,g.input),{status:400});
});

test('baseline drift and projection identity collision refuse overwrite; completed receipt preserves later edits',async t=>{
  const f=await setup(t);await f.target.world.put({id:definitionId,namespace:'os',kind:'note',body:'owner data'},{writer:'os'});await assert.rejects(f.target.migrations.apply(principal,f.input),{status:409});f.input.expected=(await f.target.migrations.plan(principal,f.input)).expected;await assert.rejects(f.target.migrations.apply(principal,f.input),{status:409});assert.equal(f.target.world.get(definitionId).body,'owner data');
  const g=await setup(t);await g.target.migrations.apply(principal,g.input);const definition=g.target.workflows.get(principal,{id:definitionId});await g.target.workflows.save(principal,{id:definitionId,expected:definition.revision,definition:{...definition,title:'Target edited'}});assert.equal((await g.target.migrations.apply(principal,g.input)).replayed,true);assert.equal(g.target.workflows.get(principal,{id:definitionId}).title,'Target edited');
});

test('recovery refuses independently changed store bytes and leaves the private journal for review',async t=>{
  let fired=false;const f=await setup(t,{fault:point=>{if(point==='schedules.json'&&!fired){fired=true;throw Object.assign(Error('Fixture crash'),{simulateCrash:true});}}});
  await assert.rejects(f.target.migrations.apply(principal,f.input));const path=join(f.directory,'workflows.json'),changed='{"version":1,"definitions":[],"runs":[],"ownerNote":"preserve"}';await writeFile(path,changed,{mode:0o600});
  const world=await new World(f.directory).open(),recovery=new AutomationMigrations({directory:f.directory,world});await assert.rejects(recovery.recover(),{status:503});assert.equal(await readFile(path,'utf8'),changed);assert.ok((await readdir(join(f.directory,'automation-migrations'))).includes('pending.json'));assert.equal(recovery.ready,false);
});
