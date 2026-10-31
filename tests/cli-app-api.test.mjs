import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {World} from '../server/world.mjs';
import {Platform} from '../server/platform.mjs';
import {platformRouter} from '../server/platform-router.mjs';
import {DesktopActions} from '../server/desktop-actions.mjs';
import {appCaller} from '../server/app-caller.mjs';

const token='private-cli-app-api-fixture',instanceId='e'.repeat(32),appId='a'.repeat(32),clientId='12345678-1234-1234-1234-123456789abc';
const routes=[{name:'record',path:'/records/:id',methods:['GET']},{name:'message',path:'/messages/:id',methods:['POST']}];
function send(response,status,value){response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));}
async function fixture(t,handler){
 const directory=await mkdtemp(join(tmpdir(),'ink-cli-app-api-')),config=join(directory,'client.json'),seen=[];
 const server=createServer(async(request,response)=>{try{const chunks=[];for await(const chunk of request){chunks.push(chunk);if(chunks.reduce((n,b)=>n+b.length,0)>100000)throw Error('Oversized fixture input');}const text=Buffer.concat(chunks).toString();const input=text?JSON.parse(text):undefined;seen.push({path:request.url,method:request.method,authorization:request.headers.authorization,input});if(request.url==='/api/health')return send(response,200,{ok:true,engine:'Ink',instanceId});await handler({request,response,input,url:new URL(request.url,'http://fixture')});}catch(error){send(response,error.status||500,{error:error.message});}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 await writeFile(config,JSON.stringify({url,token,instanceId}),{mode:0o600});
 t.after(async()=>{server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 async function cli(args,extra={}){
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));Object.assign(env,{INK_OS_CONFIG:config},extra);
  return await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['cli/bin/ink-os.mjs',...args],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
 }
 return{directory,config,seen,url,cli};
}
const value=result=>{assert.equal(result.code,0,result.stderr);return JSON.parse(result.stdout);};
const authenticated=f=>f.seen.filter(row=>row.authorization);

test('CLI named reads/messages map parameters and raw calls preserve method, path, body and response',async t=>{
 const f=await fixture(t,async({request,response,input})=>{
  if(request.url.endsWith('/api'))return send(response,200,{appId,routes});
  if(request.url.endsWith('/call'))return send(response,200,{status:200,body:{received:input}});
  send(response,404,{error:'Unexpected fixture route'});
 });
 assert.deepEqual(value(await f.cli(['apps','api',appId])),{appId,routes});
 assert.deepEqual(value(await f.cli(['apps','read',appId,'record','--body',JSON.stringify({id:'row_1',q:'two words&more',limit:3})])),{received:{path:'/records/row_1?q=two+words%26more&limit=3',method:'GET'}});
 assert.deepEqual(value(await f.cli(['apps','send',appId,'message','--body','{"id":"row-2","text":"keep","nested":{"v":2}}'])),{received:{path:'/messages/row-2',method:'POST',body:{text:'keep',nested:{v:2}}}});
 assert.deepEqual(value(await f.cli(['call',appId,'/messages/direct?mode=one','--method','patch','--body','{"text":"raw"}'])),{received:{path:'/messages/direct?mode=one',method:'PATCH',body:{text:'raw'}}});
 assert.ok(authenticated(f).every(row=>row.authorization==='Bearer '+token));assert.equal(f.seen.filter(row=>row.path==='/api/health').length,4);assert.ok(f.seen.filter(row=>row.path==='/api/health').every(row=>row.authorization===undefined));
});

test('CLI invalid and unknown interactions refuse without writes; nested backend credential errors are redacted',async t=>{
 const f=await fixture(t,async({request,response})=>{if(request.url.endsWith('/api'))return send(response,200,{appId,routes});return send(response,200,{status:401,body:{error:'Rejected '+token}});});
 const before=await readFile(f.config);
 for(const args of[['apps','unrecognized'],['apps',token],['apps','api','../private'],['apps','action','not-an-action'],['apps','send',appId,'message','--body','not json'],['apps','send',appId,'message','--body','[]'],['apps','read',appId,'record','--body','{}'],['apps','read',appId,'record','--body','{"id":"../escape"}'],['apps','read',appId,'missing','--body','{}'],['apps','open',appId,'--data','{'],['apps','open',appId,'--data',JSON.stringify('x'.repeat(65536))],['call',appId,'https://other.invalid/'],['call',appId,'//other.invalid/'],['call',appId,'/path#fragment'],['call',appId,'/path','--method','CONNECT']]){
  const result=await f.cli(args);assert.equal(result.code,1,JSON.stringify(args));assert.ok(!result.stderr.includes(token));
 }
 assert.ok(f.seen.every(row=>row.method==='GET'));assert.deepEqual(await readFile(f.config),before);
 assert.equal((await f.cli(['apps','open',appId],{INK_OS_UI_CLIENT_ID:'../other'})).code,1);assert.equal((await f.cli(['apps','open',appId],{INK_OS_APP_ID:'../other'})).code,1);assert.ok(f.seen.every(row=>row.method==='GET'));
 const result=await f.cli(['call',appId,'/messages/direct','--method','POST','--body','{}']);assert.equal(result.code,1);assert.match(result.stderr,/Rejected \[redacted\]/);assert.ok(!result.stderr.includes(token)&&!result.stdout.includes(token));
});

test('new app interaction dispatch preserves origin/identity and redirect fences before forwarding credentials',async t=>{
 const sink=await fixture(t,async({response})=>send(response,200,{routes}));
 const f=await fixture(t,async({response})=>{response.writeHead(307,{location:sink.url+'/api/v1/apps/'+appId+'/api'});response.end();});
 for(const args of[['apps','api',appId,'--url',sink.url],['call',appId,'/records/one','--url',sink.url]]){const result=await f.cli(args);assert.equal(result.code,1);assert.match(result.stderr,/different origin/);}
 assert.equal(sink.seen.length,0);assert.equal(f.seen.length,0);
 await writeFile(f.config,JSON.stringify({url:f.url,token,instanceId:'f'.repeat(32)}));assert.equal((await f.cli(['apps','api',appId])).code,1);assert.equal(authenticated(f).length,0);
 await writeFile(f.config,JSON.stringify({url:f.url,token,instanceId}));assert.equal((await f.cli(['apps','api',appId])).code,1);assert.equal(sink.seen.length,0);assert.equal(authenticated(f).length,1);
});

test('CLI uses actual server exported routes and signed owner/app caller permissions; desktop open is an acknowledged owner handoff',async t=>{
 let route,platform,backendCalls=0;
 const f=await fixture(t,async({request,response,input,url})=>route(request,response,url,platform.principal(request),input));
 const world=await new World(join(f.directory,'world')).open();platform=await new Platform({directory:join(f.directory,'platform'),world,adminToken:token,environmentKey:Buffer.alloc(32,7),origin:f.url}).open();
 platform.desktopActions=await new DesktopActions(join(f.directory,'actions')).open();
 const target=await platform.createApp({slug:'api-target'}),source=await platform.createApp({slug:'api-source',capabilities:['apps.invoke']});
 for(const app of[target,source]){const release=await platform.createRelease(app.id,{files:[{path:'index.html',base64:Buffer.from('<p>API fixture</p>').toString('base64')},{path:'server.mjs',base64:Buffer.from('export default ()=>{}').toString('base64')}],backend:{entry:'server.mjs',api:routes}});await world.update(app.id,{body:JSON.stringify({...JSON.parse(world.get(app.id).body),releaseId:release.id})},{writer:'os'});await platform.runtime.prepare(app.id);}
 const targetPrincipal=platform.runtime.principal(platform.runtime.token(target.id));
 platform.invoke=async(id,input)=>{assert.equal(id,target.id);backendCalls++;const {__inkCaller,...payload}=input.body||{};return{status:200,body:{path:input.path,method:input.method,payload,...(input.method==='GET'?{}:{caller:appCaller(platform,targetPrincipal,id,{assertion:__inkCaller,path:input.path,method:input.method,body:input.body})})}};};
 const actual=platformRouter(platform,{send,body:async request=>request.fixtureInput});route=async(request,response,url,principal,input)=>{request.fixtureInput=input;await actual(request,response,url,principal);};
 assert.equal(value(await f.cli(['apps','api',target.id])).releaseId,JSON.parse(world.get(target.id).body).releaseId);
 const owner=value(await f.cli(['apps','send',target.id,'message','--body','{"id":"one","text":"owner","__inkCaller":"forged"}']));assert.equal(owner.caller.accountId,'owner');assert.equal(owner.payload.text,'owner');assert.equal(owner.payload.__inkCaller,undefined);
 const readKey=await platform.apiKeys.create({name:'Read-only fixture',scopes:['apps:read']});assert.equal(value(await f.cli(['apps','api',target.id],{INK_OS_TOKEN:readKey.token})).appId,target.id);const beforeDenied=backendCalls;const scopeDenied=await f.cli(['apps','send',target.id,'message','--body','{"id":"one"}'],{INK_OS_TOKEN:readKey.token});assert.equal(scopeDenied.code,1);assert.match(scopeDenied.stderr,/apps:invoke/);assert.equal(backendCalls,beforeDenied);
 const computerKey=await platform.apiKeys.create({name:'Computer fixture',scopes:['computer']});assert.equal(value(await f.cli(['apps','send',target.id,'message','--body','{"id":"computer"}'],{INK_OS_TOKEN:computerKey.token})).caller.accountId,'owner');
 const appToken=await platform.serviceToken(source.id),appResult=value(await f.cli(['apps','send',target.id,'message','--body','{"id":"two","text":"app"}'],{INK_OS_TOKEN:appToken}));assert.deepEqual(appResult.caller,{type:'app',appId:source.id,name:source.title});
 const calls=backendCalls;assert.equal((await f.cli(['call',target.id,'/not-exported','--method','POST','--body','{}'])).code,1);assert.equal(backendCalls,calls);
 await world.update(source.id,{body:JSON.stringify({...JSON.parse(world.get(source.id).body),capabilities:[]})},{writer:'os'});const denied=await f.cli(['apps','send',target.id,'message','--body','{"id":"three"}'],{INK_OS_TOKEN:appToken});assert.equal(denied.code,1);assert.match(denied.stderr,/apps.invoke/);assert.equal(backendCalls,calls);
 const opened=value(await f.cli(['apps','open',target.id,'--data','{"record":"one"}'],{INK_OS_UI_CLIENT_ID:clientId,INK_OS_APP_ID:source.id}));assert.equal(opened.status,'queued');assert.equal(value(await f.cli(['apps','action',opened.id])).status,'queued');
 const ownerPrincipal=platform.principal({headers:{authorization:'Bearer '+token}}),claimed=await platform.desktopActions.claim(ownerPrincipal,clientId);assert.equal(claimed.id,opened.id);assert.deepEqual(claimed.handoff.data,{record:'one'});assert.equal(claimed.handoff.source.appId,source.id);
 await platform.desktopActions.ack(ownerPrincipal,opened.id,clientId,{status:'opened'});assert.equal(value(await f.cli(['apps','action',opened.id])).status,'opened');
 const actions=platform.desktopActions.actions.length;assert.equal((await f.cli(['apps','open',target.id],{INK_OS_TOKEN:appToken})).code,1);assert.equal(platform.desktopActions.actions.length,actions);
 await Promise.all([world.tail,platform.keysTail,platform.apiKeys.tail,platform.runtime.tail,platform.desktopActions.tail]);
});

test('existing apps catalog defaults and explicit list retain archived selection',async t=>{
 const f=await fixture(t,async({request,response})=>send(response,200,{path:request.url}));
 assert.equal(value(await f.cli(['apps'])).path,'/api/v1/apps');assert.equal(value(await f.cli(['apps','list','--include-deleted'])).path,'/api/v1/apps?archived=true');
});
