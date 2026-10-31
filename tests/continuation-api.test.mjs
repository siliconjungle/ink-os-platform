import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeInstance } from '../server/instance.mjs';
import { World } from '../server/world.mjs';
import { Storage } from '../server/storage.mjs';
import { Platform, sign } from '../server/platform.mjs';
import { Projects } from '../server/projects.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { LocalProvider } from '../infra/local-provider.mjs';
import { RuntimePool } from '../server/runtime-pool.mjs';
import { platformRouter } from '../server/platform-router.mjs';
import { requestJSON } from '../server/request-body.mjs';
import { createMaintenanceHostAdapter } from '../server/maintenance-host.mjs';
import { SnapshotGate } from '../server/snapshot-gate.mjs';
import { createBackup, restoreBackup } from '../server/backup-store.mjs';
import { createClient } from '../sdk/src/server.js';
import { CONTINUATION_HEADER } from '../shared/continuation.mjs';
import { httpConnections } from '../server/http-connections.mjs';
import { drainHost } from '../server/shutdown.mjs';

const execute=promisify(execFile),deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const scopes=['apps:read','apps:deploy','apps:invoke','world:read','world:write'];
async function fixture(t,{withPool=true}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'ink-continuation-api-'))),directory=join(root,'data');
  await writeFile(join(root,'storage-retention.json'),JSON.stringify({keep:{data:'Active generated continuation host fixture.'},safe_to_remove:{}}));
  const identity=await initializeInstance({directory}),world=await new World(directory).open(),storage=await new Storage(directory,{env:{}}).open(),provider=new LocalProvider();
  const platform=await new Platform({root:resolve('.'),directory,world,storage,provider,origin:'http://127.0.0.1',adminToken:identity.adminToken,environmentKey:identity.environmentKey}).open();
  platform.projects=await new Projects(directory,{environmentKey:identity.environmentKey}).open();platform.collaboration=new Collaboration({directory,world,storage});await platform.collaboration.recover();
  const app=await platform.createApp({slug:'continuation-agent',title:'Continuation agent'}),release=await platform.createRelease(app.id,{entry:'index.html',files:[{path:'index.html',base64:Buffer.from('<p>agent fixture</p>').toString('base64')}]});await platform.publish(app.id,release.id);
  const leaseId='c'.repeat(32),slotId='d'.repeat(32);let stopped=false,stops=0,toolFinished=false,pool;
  const status=slot=>({appId:slot.appId,releaseId:slot.releaseId,leaseId:slot.leaseId,activeRequests:0,resources:0,startPinned:false,draining:false});
  // Real pool/credential/store/HTTP logic with a controlled provider. Docker
  // and production worker lifecycle acceptance remain separate evidence.
  const worker={poolStopped:async()=>stopped,poolStatus:async slot=>status(slot),drainPoolSlot:async slot=>({...status(slot),draining:true,idle:true}),stopPoolSlot:async()=>{assert.equal(toolFinished,true);assert.ok(pool.slots.every(slot=>!slot.holds.length));stops++;stopped=true;return true;}};
  if(withPool){pool=await new RuntimePool({directory,provider:worker,runtime:platform.runtime,environment:platform.environment,origin:platform.origin}).open({sweep:false});
  await pool.change(()=>pool.slots.push({id:slotId,kind:'module',status:'ready',appId:app.id,releaseId:release.id,leaseId,holds:[],allowIdle:true,deployment:{appId:app.id,releaseId:release.id,leaseId}}));
  provider.pool=pool;platform.runtime.leaseActive=(...args)=>pool.active(...args);}
  const token=platform.runtime.leaseToken(app.id,release.id,leaseId),issued=await platform.apiKeys.create({name:'Scoped coding fixture',scopes},'owner');
  const requests=new Set(),responses=new Set(),lifecycle={draining:false,sealed:false,stopped:false};let gate;
  const adapter=createMaintenanceHostAdapter({platform,requests,responses,externalClosed:()=>!!gate?.closed||lifecycle.draining});gate=new SnapshotGate({directory,adapter,otherClosed:()=>lifecycle.draining,pollMs:2});
  const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));},api=platformRouter(platform,{send,body:requestJSON});
  const server=createServer(async(req,res)=>{
    let finish;const task=new Promise(done=>finish=done);requests.add(task);responses.add(res);res.once('close',()=>responses.delete(res));
    try{const url=new URL(req.url,'http://fixture.invalid');if(lifecycle.sealed)return send(res,503,{error:'Host stopped'});if(url.pathname==='/api/health')return send(res,200,{ok:true,engine:'Ink',instanceId:identity.id});const principal=platform.principal(req);if((gate.closed||lifecycle.draining)&&!platform.canContinueAdmission(principal))return send(res,503,{error:'Snapshot admission is closed'});await api(req,res,url,principal);}catch(error){send(res,error.status||500,{error:error.message});}finally{requests.delete(task);finish();}
  });const connections=httpConnections(server);server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;platform.origin=url;
  const continuation={url,token},sdk=createClient({url,token:issued.token,continuation}),ordinary=createClient({url,token:issued.token,continuation:null}),runtime=createClient({url,token,continuation:null});
  const controllers=[],snapshots=[],unblocks=[];
  t.after(async()=>{
    for(const unblock of unblocks)unblock();for(const controller of controllers)controller.abort();for(const pending of snapshots){const snapshot=await pending.catch(()=>null);await snapshot?.release();}
    await new Promise(done=>server.close(done));if(!lifecycle.stopped){await provider.close();await platform.collaboration.close();}await world.tail;
    await writeFile(join(root,'storage-retention.json'),JSON.stringify({keep:{},safe_to_remove:{data:'Completed generated private host and source data; owned servers/handles closed.',source:'Completed generated committed app source.',restored:'Completed generated raw restore.','live.inkbackup':'Completed encrypted fixture archive.'}}));await rm(root,{recursive:true});
  });
  const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name))),INK_OS_URL:url,INK_OS_TOKEN:issued.token,INK_OS_CONFIG:join(root,'absent.json'),INK_OS_CONTINUATION_URL:url,INK_OS_CONTINUATION_TOKEN:token};
  const cli=async args=>JSON.parse((await execute(process.execPath,['cli/bin/ink-os.mjs',...args],{env,timeout:30000,maxBuffer:2*1024*1024})).stdout);
  const shutdown=async()=>{lifecycle.draining=true;await drainHost({server,connections,platform,world,requests,responses,sockets:{clients:new Set()},admission:adapter,stopAdmission:()=>{lifecycle.sealed=true;}});lifecycle.stopped=true;};
  return{root,directory,platform,world,storage,pool,gate,app,release,leaseId,token,issued,url,sdk,ordinary,runtime,cli,env,controllers,snapshots,unblocks,lifecycle,shutdown,stops:()=>stops,finishTools:()=>{toolFinished=true;}};
}

test('an admitted scoped account CLI/SDK task finishes under closed snapshot admission before verified idle pool release', {timeout:30000},async t=>{
  const f=await fixture(t),hold=await f.runtime.compute.hold('Admitted coding task');
  const controller=new AbortController();f.controllers.push(controller);const pending=f.gate.acquireSnapshot({signal:controller.signal,timeoutMs:20000});f.snapshots.push(pending);pending.catch(()=>{});
  assert.equal(f.gate.closed,true);await assert.rejects(f.ordinary.data.create({kind:'note',title:'New activity'}),{status:503});
  const note=await f.sdk.data.create({kind:'note',title:'Admitted tool',body:'complete before snapshot'});assert.equal(note.namespace,'os');
  assert.equal((await f.cli(['whoami'])).accountId,'owner');
  const source=join(f.root,'source');await mkdir(source);await writeFile(join(source,'ink-app.json'),JSON.stringify({slug:'continued-tool-app',title:'Continued tool app',entry:'index.html'}));await writeFile(join(source,'index.html'),'<p>deployed during admitted work</p>');
  await execute('git',['init','-b','main',source]);await execute('git',['-C',source,'add','.']);await execute('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','commit','-m','Fixture source']);
  const deployed=await f.cli(['deploy',source]);assert.equal(f.platform.app(deployed.appId).title,'Continued tool app');assert.ok(f.world.all().some(row=>row.namespace===deployed.appId&&row.tags.includes('app-artifact')));
  const readOnly=await f.platform.apiKeys.create({name:'Read only context',scopes:['world:read']},'owner'),readOnlySDK=createClient({url:f.url,token:readOnly.token,continuation:{url:f.url,token:f.token}});
  await assert.rejects(readOnlySDK.data.create({kind:'note',title:'Scope bypass'}),{status:403});assert.equal((await readOnlySDK.data.get(note.id)).body,'complete before snapshot');
  assert.equal(f.stops(),0);f.finishTools();await hold.release();const snapshot=await pending;
  assert.equal(f.stops(),1);assert.equal(f.gate.inspect().phase,'reading');
  const archive=join(f.root,'live.inkbackup');await createBackup({directory:f.directory,archive,password:'disposable admitted task backup password',acquireSnapshot:async()=>snapshot});
  assert.equal(f.gate.closed,false);await assert.rejects(f.sdk.data.create({kind:'note',title:'Expired context'}),{status:401});
  assert.equal((await f.ordinary.data.get(note.id)).body,'complete before snapshot');
  const target=join(f.root,'restored');await restoreBackup({directory:target,archive,password:'disposable admitted task backup password'});const restored=await new World(target).open();assert.equal(restored.get(note.id).body,'complete before snapshot');assert.ok(restored.get(deployed.appId));
});

test('forged, expired and non-lease contexts cannot supplement an account key or bypass its permissions',async t=>{
  const f=await fixture(t),headers=token=>({authorization:'Bearer '+f.issued.token,[CONTINUATION_HEADER]:token});
  const raw=async(token,bearer=f.issued.token)=>fetch(f.url+'/api/v1/me',{headers:{...headers(token),authorization:'Bearer '+bearer}});
  const bad=f.token.slice(0,-1)+(f.token.endsWith('a')?'b':'a');
  for(const token of[bad,f.platform.runtime.leaseToken(f.app.id,f.release.id,'e'.repeat(32)),f.platform.runtime.token(f.app.id)])assert.equal((await raw(token)).status,401);
  assert.equal((await raw(f.token,'not-an-account-key')).status,401);
  const member=await f.platform.apiKeys.createAccount({name:'Continuation member',scopes:['world:read']}),memberSDK=createClient({url:f.url,token:member.key.token,continuation:{url:f.url,token:f.token}});
  assert.equal((await memberSDK.account.me()).accountId,member.account.id);await assert.rejects(memberSDK.request('accounts'),{status:403});
  const cookie='ink_os_session='+sign({owner:true,keyId:f.issued.id,exp:Date.now()+60000},f.platform.adminToken),principal=f.platform.principal({headers:{cookie,[CONTINUATION_HEADER]:f.token}});
  assert.equal(principal.accountId,'owner');assert.equal(principal.namespace,'os');assert.equal(principal.leaseId,f.leaseId);assert.deepEqual(principal.scopes,scopes);
  await f.platform.apiKeys.revoke(f.issued.id);assert.equal((await raw(f.token)).status,401);
});

test('a supplemented owner World write keeps the originating lease fence when it expires behind a queued transaction',async t=>{
  const f=await fixture(t),principal=f.platform.principal({headers:{authorization:'Bearer '+f.issued.token,[CONTINUATION_HEADER]:f.token}}),blocked=deferred();f.unblocks.push(blocked.resolve);
  f.world.tail=f.world.tail.then(()=>blocked.promise);const write=f.platform.dataCreate(principal,{kind:'note',title:'Stale continuation write'});write.catch(()=>{});
  f.pool.slots[0].leaseId='f'.repeat(32);blocked.resolve();await assert.rejects(write,{status:409});assert.ok(!f.world.all().some(row=>row.title==='Stale continuation write'));
});

test('host shutdown keeps admitted account tool calls usable until their compute hold finishes and state is durable', {timeout:15000},async t=>{
  const f=await fixture(t),hold=await f.runtime.compute.hold('Task finishing during quit');let completed=false;
  const stopping=f.shutdown().then(()=>{completed=true;});stopping.catch(()=>{});
  await assert.rejects(f.ordinary.data.create({kind:'note',title:'New task during quit'}),{status:503});
  const note=await f.sdk.data.create({kind:'note',title:'Finishing tool',body:'saved before host closes'});assert.equal(completed,false);assert.equal(f.stops(),0);
  f.finishTools();await hold.release();await stopping;assert.equal(f.stops(),1);assert.equal(f.lifecycle.sealed,true);
  const persisted=await new World(f.directory).open();assert.equal(persisted.get(note.id).body,'saved before host closes');
});

test('frontend-only hosts can close with unavailable backend metadata when no private executor journal has an active lease', {timeout:15000},async t=>{
  const f=await fixture(t,{withPool:false}),app=await f.platform.createApp({slug:'unavailable-backend',title:'Unavailable backend'}),release=await f.platform.createRelease(app.id,{entry:'index.html',backend:{entry:'server/private.mjs'},files:[{path:'index.html',base64:Buffer.from('<p>frontend</p>').toString('base64')},{path:'server/private.mjs',base64:Buffer.from('export const fetch=()=>Response.json({ok:true});').toString('base64')}]});
  await f.platform.publish(app.id,release.id);await f.shutdown();assert.equal(f.lifecycle.stopped,true);assert.equal(f.stops(),0);
});
