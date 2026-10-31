import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm, lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { initializeInstance } from '../server/instance.mjs';
import { World } from '../server/world.mjs';
import { Storage } from '../server/storage.mjs';
import { Platform } from '../server/platform.mjs';
import { Projects } from '../server/projects.mjs';
import { AppEnvironment } from '../server/app-environment.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { LocalProvider } from '../infra/local-provider.mjs';
import { createMaintenanceHostAdapter } from '../server/maintenance-host.mjs';
import { SnapshotGate,createLiveBackup } from '../server/snapshot-gate.mjs';
import { recoverBackup } from '../server/backup-recovery.mjs';
import { createBackup,restoreBackup } from '../server/backup-store.mjs';
import { createClient } from '../sdk/src/server.js';
import { activateRecoveredStorage,activateRecoveredRuntimes } from '../server/provider-recovery-host.mjs';
import { recoveryHash,readRecoveryPlan } from '../server/provider-recovery.mjs';
import { unboundDeployment } from '../server/provider-bindings.mjs';

const execute=promisify(execFile),password='Disposable provider recovery password';
const ownedHosts=new WeakMap();
async function store(t,kind='r2'){
  const objects=new Map(),calls=[];let losePut=false;
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://fixture.invalid').pathname;calls.push({method:req.method,path});
    if(kind==='r2')assert.equal(req.headers.authorization,'Bearer fixture-object-token');else assert.match(req.headers.authorization,/^AWS4-HMAC-SHA256 Credential=fixture-access\//);
    if(req.method==='PUT'){const parts=[];for await(const part of req)parts.push(part);objects.set(path,Buffer.concat(parts));if(losePut){losePut=false;res.destroy();return;}res.end();return;}
    const bytes=objects.get(path);res.writeHead(bytes?200:404,bytes?{'Content-Length':String(bytes.length)}:{});res.end(bytes);
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const endpoint='http://127.0.0.1:'+server.address().port;
  return{objects,calls,loseNextPut:()=>losePut=true,env:kind==='r2'?{INK_OS_R2_URL:endpoint,INK_OS_R2_TOKEN:'fixture-object-token',INK_OS_R2_BUCKET:'destination-bucket'}:{INK_OS_S3_ENDPOINT:endpoint,INK_OS_S3_BUCKET:'destination-bucket',INK_OS_STORAGE_PREFIX:'target/prefix',AWS_ACCESS_KEY_ID:'fixture-access',AWS_SECRET_ACCESS_KEY:'fixture-secret',AWS_REGION:'auto'}};
}
async function source(t,{large=false,aliases=0}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ink-provider-recovery-'))),directory=join(root,'source'),archive=join(root,'private.inkbak');
  await writeFile(join(root,'storage-retention.json'),JSON.stringify({keep:{source:'Active owned provider-recovery source and exact Git input.'},safe_to_remove:{}}));
  if(!ownedHosts.has(t))ownedHosts.set(t,[]);let sourcePlatform,snapshot;
  t.after(async()=>{for(const stop of ownedHosts.get(t))await stop();await snapshot?.catch(()=>{});await sourcePlatform?.provider.close();await sourcePlatform?.collaboration.close();const allowed=new Set(['source','private.inkbak','local','host-r2','host-s3','large','resume','storage-retention.json',...['corrupt','missing','location','duplicate'].flatMap(kind=>['raw-'+kind,kind+'.inkbak','refused-'+kind])]);const names=await readdir(root);if(names.some(name=>!allowed.has(name)))throw Error('Preserve unexpected recovery fixture inputs for review.');await writeFile(join(root,'storage-retention.json'),JSON.stringify({keep:{},safe_to_remove:Object.fromEntries(names.filter(name=>name!=='storage-retention.json').map(name=>[name,'Completed owned generated validation data; all host/read/write handles settled, exact reproduction inputs remain in this test.']))}));await rm(root,{recursive:true});});
  const remote=await store(t),identity=await initializeInstance({directory});
  await writeFile(join(directory,'client.json'),JSON.stringify({url:'https://source.invalid',instanceId:identity.id,token:identity.adminToken}),{mode:0o600});
  const world=await new World(directory).open(),storage=await new Storage(directory,{env:remote.env}).open(),provider=new LocalProvider(),platform=await new Platform({root:directory,directory,world,storage,provider,origin:'http://127.0.0.1',adminToken:identity.adminToken,environmentKey:identity.environmentKey}).open();
  platform.collaboration=new Collaboration({directory,world,storage});await platform.collaboration.recover();
  sourcePlatform=platform;
  const app=await platform.createApp({slug:'restored-app',title:'Restored app'}),release=await platform.createRelease(app.id,{entry:'index.html',files:[{path:'index.html',base64:Buffer.from('<p>Recovered isolated frontend</p>').toString('base64')}]});await platform.publish(app.id,release.id);
  const record=world.get(release.id),meta=JSON.parse(record.body);await world.update(release.id,{body:JSON.stringify({...meta,deployment:{provider:'pool',url:'https://old-app.source.invalid'}})},{writer:'os'});
  const appRecord=world.get(app.id);await world.update(app.id,{body:JSON.stringify({...JSON.parse(appRecord.body),url:'https://old-app.source.invalid'})},{writer:'os'});
  const bytes=large?Buffer.alloc(25*1024*1024+1,37):Buffer.from([0,255,13,10,33]),blob=await storage.put(bytes),file=await world.create({namespace:'os',kind:'file',title:'Retained remote bytes',location:blob.location,body:JSON.stringify({mime:'application/octet-stream',bytes:bytes.length})},{writer:'os'});
  const note=await world.create({namespace:app.id,kind:'note',title:'Keep app data',body:'Exact app state\r\n'},{writer:app.id});
  await platform.environment.mutate(app.id,{RESTORED_SECRET:'private fixture value'},[]);
  const projects=await new Projects(directory,{environmentKey:identity.environmentKey}).open(),project=await projects.snapshot({title:'Retained source',files:[{path:'index.html',mode:'100644',base64:Buffer.from('committed source\r\n').toString('base64')},{path:'run',mode:'100755',base64:Buffer.from('#!/bin/sh\nexit 0\n').toString('base64')}]});
  if(aliases)await storage.installAliases({operation:'retained-aliases',inputDigest:recoveryHash('source cut'),aliases:Object.fromEntries(Array.from({length:aliases},(_,i)=>['s3://former-bucket/p'+i+'/objects/'+blob.digest,blob.location]))});
  const oldConfig=Buffer.from('{"bucket":"former-bucket","secretAccessKey":"fixture-previous-secret"}\n');await writeFile(join(directory,'storage.json'),oldConfig,{mode:0o600});
  const oldPool=Buffer.from(JSON.stringify({version:1,slots:[{id:'a'.repeat(32),status:'ready',appId:app.id,releaseId:release.id,leaseId:'b'.repeat(32),holds:[{id:'source-only'}],deployment:{provider:'fly',app:'former-worker',machineId:'former-machine'}}]}));await writeFile(join(directory,'runtime-pool.json'),oldPool,{mode:0o600});
  let gate;const adapter=createMaintenanceHostAdapter({platform,requests:new Set(),responses:new Set(),externalClosed:()=>!!gate?.closed});gate=new SnapshotGate({directory,adapter,otherClosed:()=>false,pollMs:1});
  snapshot=createLiveBackup({gate,world,storage,remoteAssets:true,archive,password,signal:t.signal});
  const saved=await snapshot;await provider.close();await platform.collaboration.close();await world.tail;
  return{root,directory,archive,identity,remote,app,release,file,note,project,bytes,blob,saved,oldConfig,oldPool};
}
async function boot(t,directory,extra={}){
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const preload=join(directory,'deny-external-test.mjs');await writeFile(preload,"const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(input.url||input);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Unexpected external transport in recovery fixture');return original(input,init);};\n",{mode:0o600});
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|HOME|LANG|LC_ALL|TMPDIR)$/.test(key))),NODE_ENV:'production',PORT:String(port),INK_OS_NATIVE:'0',INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR:directory,NODE_OPTIONS:'--import='+pathToFileURL(preload).href,...extra};
  const child=spawn(process.execPath,['scripts/start.mjs'],{env,stdio:['ignore','pipe','pipe']});const exited=once(child,'exit');let output='',stopped=false;child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
  const stop=async()=>{if(stopped)return;stopped=true;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const[code]=await exited;assert.equal(code,0,output.slice(-2000));assert.ok(!output.includes('Unexpected external transport'));};ownedHosts.get(t).push(stop);t.after(stop);
  const url='http://127.0.0.1:'+port;
  for(let i=0;i<500;i++){if(child.exitCode!==null||child.signalCode!==null)assert.fail(output.slice(-2000));try{if((await fetch(url+'/api/health')).ok){const client=JSON.parse(await readFile(join(directory,'client.json')));return{sdk:createClient({url,token:client.token,continuation:null}),stop,url};}}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Restored host did not start: '+output.slice(-2000));
}

test('CLI local recovery preserves keys, Git, app data and secrets while launching a new isolated frontend without source-provider access',{timeout:30000},async t=>{
  const f=await source(t),target=join(f.root,'local'),before=f.remote.calls.length;
  const result=JSON.parse((await execute(process.execPath,['cli/bin/ink-os.mjs','backup','restore','--offline','--directory',target,'--input',f.archive,'--storage','local','--runtime','local','--password-env','RECOVERY_FIXTURE_PASSWORD'],{env:{...process.env,RECOVERY_FIXTURE_PASSWORD:password},timeout:20000})).stdout);
  assert.equal(result.recovery.providerBindings.storage.verifiedObjects,f.saved.assets.objects);
  const audit=join(target,result.recovery.providerBindings.auditDirectory);assert.deepEqual(await readFile(join(audit,'storage.json')),f.oldConfig);assert.deepEqual(await readFile(join(audit,'runtime-pool.json')),f.oldPool);
  const host=await boot(t,target,{...f.remote.env,FLY_API_TOKEN:'fixture-cloud-token-must-be-ignored',INK_OS_HOSTING:'pool'});
  assert.equal(JSON.parse((await host.sdk.apps.status(f.app.id)).app.body).url,undefined);
  const {vector,...publicNote}=f.note;assert.deepEqual(await host.sdk.data.get(f.note.id),publicNote);assert.deepEqual(Buffer.from(await host.sdk.assets.get(f.file.id)),f.bytes);
  const launch=await host.sdk.request('apps/'+f.app.id+'/launch',{method:'POST',body:{}});assert.equal(new URL(launch.origin).hostname,'127.0.0.1');assert.notEqual(launch.origin,'https://old-app.source.invalid');
  const grant=await fetch(launch.url,{redirect:'manual'}),cookie=grant.headers.get('set-cookie').split(';')[0];assert.equal(grant.status,302);assert.match(await(await fetch(new URL('/index.html',launch.origin),{headers:{cookie}})).text(),/Recovered isolated frontend/);
  assert.equal(JSON.parse((await host.sdk.apps.status(f.app.id)).app.body).url,launch.origin);
  const files=await host.sdk.projects.files(f.project.id);assert.equal(files.find(file=>file.path==='run').mode,'100755');assert.equal(Buffer.from(files.find(file=>file.path==='index.html').base64,'base64').toString(),'committed source\r\n');
  const identity=JSON.parse(await readFile(join(target,'instance.json')));assert.equal(identity.environmentKey,f.identity.environmentKey);assert.equal((await new AppEnvironment(target,identity.environmentKey).open()).values(f.app.id).RESTORED_SECRET,'private fixture value');
  assert.equal(f.remote.calls.length,before);await host.stop();
});

for(const kind of ['r2','s3'])test('host recovery copies verified content only to the new '+kind+' store before serving apps and does not repeat the completed copy',{timeout:30000},async t=>{
  const f=await source(t),destination=await store(t,kind),target=join(f.root,'host-'+kind),before=f.remote.calls.length;
  await recoverBackup({directory:target,archive:f.archive,password,offline:true,storage:'host',runtime:'host'});
  const host=await boot(t,target,destination.env);assert.deepEqual(Buffer.from(await host.sdk.assets.get(f.file.id)),f.bytes);
  const launch=await host.sdk.request('apps/'+f.app.id+'/launch',{method:'POST',body:{}});assert.equal(new URL(launch.origin).hostname,'127.0.0.1');assert.equal(f.remote.calls.length,before);
  assert.ok(destination.calls.some(call=>call.method==='PUT'));if(kind==='s3')assert.ok(destination.calls.every(call=>call.path.startsWith('/destination-bucket/target/prefix/objects/')));
  const puts=destination.calls.filter(call=>call.method==='PUT').length;await host.stop();const restarted=await boot(t,target,destination.env);assert.deepEqual(Buffer.from(await restarted.sdk.assets.get(f.file.id)),f.bytes);assert.equal(destination.calls.filter(call=>call.method==='PUT').length,puts);await restarted.stop();
});

test('captured objects above24MiB and more than20000 aliases recover locally within the shared capture bounds',{timeout:40000},async t=>{
  const f=await source(t,{large:true,aliases:20001}),target=join(f.root,'large');await recoverBackup({directory:target,archive:f.archive,password,offline:true,storage:'local'});
  const storage=await new Storage(target,{env:f.remote.env}).open();assert.ok(storage.aliases.aliases.size>20000);assert.equal(storage.r2,null);assert.deepEqual(await storage.get('s3://former-bucket/p20000/objects/'+f.blob.digest),f.bytes);
});

test('corrupt, missing and ambiguous authenticated asset payloads fail before recovery target publication',{timeout:30000},async t=>{
  const f=await source(t);
  for(const kind of ['corrupt','missing','location','duplicate']){
    const raw=join(f.root,'raw-'+kind);await restoreBackup({directory:raw,archive:f.archive,password});
    const path=join(raw,f.saved.assets.path),manifest=JSON.parse(await readFile(path));
    if(kind==='corrupt')await writeFile(join(raw,'blobs',f.blob.digest),Buffer.alloc(f.bytes.length,0));
    if(kind==='missing')await unlink(join(raw,'blobs',f.blob.digest));
    if(kind==='location')manifest.objects[0].locations[0]='r2://former-bucket/objects/'+'f'.repeat(64);
    if(kind==='duplicate')manifest.objects.push(manifest.objects[0]);
    if(['location','duplicate'].includes(kind))await writeFile(path,JSON.stringify(manifest));
    const archive=join(f.root,kind+'.inkbak');await createBackup({directory:raw,archive,password,acquireSnapshot:async()=>({directory:raw,sourceRoot:f.directory,assets:f.saved.assets,consistency:'snapshot',release:async()=>{}})});
    const target=join(f.root,'refused-'+kind);await assert.rejects(recoverBackup({directory:target,archive,password,offline:true,storage:'local'}));await assert.rejects(lstat(target),{code:'ENOENT'});
  }
  assert.ok(!(await readdir(f.root)).some(path=>path.startsWith('.ink-recovery-')||path.startsWith('.ink-restore-')));
});

test('an interrupted destination copy binds its store, resumes exact digest PUTs and never adopts former worker authority',{timeout:30000},async t=>{
  const f=await source(t),target=join(f.root,'resume'),destination=await store(t),other=await store(t);
  await recoverBackup({directory:target,archive:f.archive,password,offline:true,storage:'host',runtime:'local'});
  destination.loseNextPut();await assert.rejects(activateRecoveredStorage(await new Storage(target,{env:destination.env}).open()));
  assert.equal((await readRecoveryPlan(target)).storage.state,'copying');
  await assert.rejects(activateRecoveredStorage(await new Storage(target,{env:other.env}).open()),/store changed/);assert.equal(other.calls.length,0);
  const storage=await new Storage(target,{env:destination.env}).open();await activateRecoveredStorage(storage);assert.deepEqual(await storage.get(f.blob.location),f.bytes);
  const world=await new World(target).open();await activateRecoveredRuntimes(world);const version=world.version;await activateRecoveredRuntimes(world);assert.equal(world.version,version);assert.ok(unboundDeployment(JSON.parse(world.get(f.release.id).body).deployment));
  await assert.rejects(lstat(join(target,'runtime-pool.json')),{code:'ENOENT'});assert.deepEqual(world.get(f.note.id),f.note);
});
