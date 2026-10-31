import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm,stat,chmod,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

const instanceId='a'.repeat(32),otherId='b'.repeat(32),saved='fixture-saved-private-token',explicit='fixture-explicit-private-token';
function json(response,value,status=200){response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));}
async function fixture(t,{health={ok:true,engine:'Ink',instanceId},route}={}){
 const directory=await mkdtemp(join(tmpdir(),'ink-cli-connections-')),configPath=join(directory,'config.json'),seen=[];
 const server=createServer((request,response)=>{seen.push({path:request.url,authorization:request.headers.authorization});if(route?.(request,response))return;if(request.url==='/api/health')return json(response,health);if(request.url?.startsWith('/api/v1/'))return json(response,{accountId:'standalone',scopes:['world:read']});json(response,{error:'not found'},404);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 async function config(value={url,token:saved,instanceId}){await writeFile(configPath,JSON.stringify(value),{mode:0o600});}
 async function cli(args,{token,url:environmentURL}={}){const env={...process.env,INK_OS_CONFIG:configPath};delete env.INK_OS_TOKEN;delete env.INK_OS_URL;if(token!==undefined)env.INK_OS_TOKEN=token;if(environmentURL!==undefined)env.INK_OS_URL=environmentURL;return await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['cli/bin/ink-os.mjs',...args],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});}
 return{directory,configPath,seen,url,config,cli};
}
const auth=f=>f.seen.filter(r=>r.authorization);
const noTokens=result=>{assert.ok(!result.stdout.includes(saved)&&!result.stderr.includes(saved));assert.ok(!result.stdout.includes(explicit)&&!result.stderr.includes(explicit));};

test('explicit flag and environment origins cannot inherit a saved credential; matching selected remote config can',async t=>{
 const local=await fixture(t),remote=await fixture(t);await local.config();const before=await readFile(local.configPath);
 for(const input of[{args:['whoami','--url',remote.url]},{args:['whoami','--url='+remote.url]},{args:['whoami'],env:{url:remote.url}},{args:['files','download','x','--output',join(local.directory,'download'),'--url',remote.url]}]){const result=await local.cli(input.args,input.env);assert.equal(result.code,1);assert.match(result.stderr,/different origin/);noTokens(result);}
 assert.equal(remote.seen.length,0);assert.equal(local.seen.length,0);assert.deepEqual(await readFile(local.configPath),before);
 await local.config({url:remote.url,token:saved,instanceId});assert.equal((await local.cli(['whoami','--url',remote.url])).code,0);assert.equal(auth(remote)[0].authorization,'Bearer '+saved);
});
test('same-origin saved credentials require one exact unauthenticated Ink identity proof per command context',async t=>{
 const f=await fixture(t);await f.config({url:f.url+'/',token:saved,instanceId});const result=await f.cli(['env','unset','c'.repeat(32),'ONE','TWO','--url',f.url]);assert.equal(result.code,0,result.stderr);assert.equal(f.seen.filter(r=>r.path==='/api/health').length,1);assert.equal(f.seen[0].authorization,undefined);assert.equal(auth(f).length,3);assert.ok(auth(f).every(r=>r.authorization==='Bearer '+saved));noTokens(result);
});
test('wrong, missing, malformed or foreign-engine health identity never receives the saved token',async t=>{
 for(const health of[{ok:true,engine:'Ink',instanceId:otherId},{ok:true,engine:'Ink'},{ok:true,engine:'Other',instanceId},{ok:true,engine:'Ink',instanceId:'not-an-id'},{ok:false,engine:'Ink',instanceId}]){const f=await fixture(t,{health});await f.config();const before=await readFile(f.configPath),result=await f.cli(['whoami']);assert.equal(result.code,1);assert.equal(auth(f).length,0);assert.equal(f.seen.length,1);assert.deepEqual(await readFile(f.configPath),before);noTokens(result);}
});
test('health redirects and oversized/non-JSON responses cannot authorize saved credentials',async t=>{
 const sink=await fixture(t);
 for(const mode of['redirect','large','invalid']){const f=await fixture(t,{route:(request,response)=>{if(request.url!=='/api/health')return false;if(mode==='redirect'){response.writeHead(302,{location:sink.url+'/api/health'});response.end();}else if(mode==='large'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({ok:true,engine:'Ink',instanceId,pad:'x'.repeat(70000)}));}else response.end('not json');return true;}});await f.config();const result=await f.cli(['whoami']);assert.equal(result.code,1);assert.equal(auth(f).length,0);noTokens(result);}
 assert.equal(sink.seen.length,0);
});
test('explicit environment token and selected URL express intent without inheriting saved identity or scopes',async t=>{
 const local=await fixture(t),remote=await fixture(t,{health:{ok:true,engine:'Other'}});await local.config();const result=await local.cli(['whoami','--url',remote.url],{token:explicit});assert.equal(result.code,0,result.stderr);assert.equal(local.seen.length,0);assert.equal(remote.seen.length,1);assert.equal(auth(remote)[0].authorization,'Bearer '+explicit);assert.deepEqual(JSON.parse(result.stdout).scopes,['world:read']);noTokens(result);
});
test('equals URL syntax selects the remote origin with its explicitly supplied credential',async t=>{
 const local=await fixture(t),remote=await fixture(t);await local.config();const result=await local.cli(['whoami','--url='+remote.url],{token:explicit});assert.equal(result.code,0,result.stderr);assert.equal(local.seen.length,0);assert.equal(remote.seen.length,1);assert.equal(auth(remote)[0].authorization,'Bearer '+explicit);noTokens(result);
});
test('login records the canonical URL, explicit token and actually advertised identity with private permissions',async t=>{
 const f=await fixture(t);await f.config({url:'http://127.0.0.1:1',token:saved,instanceId:otherId});await chmod(f.configPath,0o644);await chmod(f.directory,0o755);const result=await f.cli(['login','--url',f.url+'/'],{token:explicit});assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(await readFile(f.configPath)),{url:f.url,token:explicit,instanceId});assert.equal((await stat(f.configPath)).mode&0o777,0o600);assert.equal((await stat(f.directory)).mode&0o777,0o700);assert.deepEqual(f.seen.map(r=>r.authorization),[undefined,'Bearer '+explicit]);noTokens(result);
});
test('legacy manual login records origin-only credentials without fabricating a host identity',async t=>{
 const f=await fixture(t,{health:{ok:true,engine:'Ink'}});const result=await f.cli(['login','--url',f.url],{token:explicit});assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(await readFile(f.configPath)),{url:f.url,token:explicit});f.seen.length=0;assert.equal((await f.cli(['whoami'])).code,0);assert.equal(f.seen.length,1);assert.equal(auth(f)[0].authorization,'Bearer '+explicit);
});
test('failed login keeps the prior config unchanged and redacts echoed credential errors',async t=>{
 const f=await fixture(t,{route:(request,response)=>{if(request.url==='/api/v1/me'){json(response,{error:'Rejected '+explicit},401);return true;}}});await f.config();const before=await readFile(f.configPath),result=await f.cli(['login','--url',f.url],{token:explicit});assert.equal(result.code,1);assert.deepEqual(await readFile(f.configPath),before);noTokens(result);
});
test('ambiguous root URLs are rejected before any network or config mutation',async t=>{
 const f=await fixture(t);await f.config();const before=await readFile(f.configPath);for(const url of[f.url+'?q=x',f.url+'#fragment',f.url+'/prefix',f.url.replace('http://','http://user:password@'),f.url.replace('http://','http://@'),f.url.replace('http://','http:'),f.url+'\n',f.url+'?',f.url+'#','file:///tmp/host']){const result=await f.cli(['login','--url',url],{token:explicit});assert.equal(result.code,1);noTokens(result);}assert.equal(f.seen.length,0);assert.deepEqual(await readFile(f.configPath),before);
});
test('authenticated API and download redirects are not followed to another origin',async t=>{
 const sink=await fixture(t),f=await fixture(t,{route:(request,response)=>{if(request.url.startsWith('/api/v1/')){response.writeHead(307,{location:sink.url+request.url});response.end();return true;}}});await f.config();for(const args of[['whoami'],['files','download','file','--output',join(f.directory,'file')]]){const result=await f.cli(args);assert.equal(result.code,1);noTokens(result);}assert.equal(sink.seen.length,0);assert.equal(auth(f).length,2);
});
test('deploy artifact upload cannot bypass an origin or identity failure caught while listing prior artifacts',async t=>{
 for(const mismatch of['origin','identity']){const f=await fixture(t),remote=await fixture(t);await f.config({url:f.url,token:saved,instanceId:mismatch==='identity'?otherId:instanceId});const directory=join(f.directory,'app');await mkdir(directory);await writeFile(join(directory,'ink-app.json'),JSON.stringify({slug:'fixture',repository:'https://github.com/example/fixture',sourceCommit:'c'.repeat(40)}));await writeFile(join(directory,'index.html'),'fixture');const result=await f.cli(['deploy',directory,'--app','d'.repeat(32),'--url',mismatch==='origin'?remote.url:f.url]);assert.equal(result.code,1);assert.equal(auth(f).length,0);assert.equal(remote.seen.length,0);assert.ok(f.seen.every(r=>r.path==='/api/health'));noTokens(result);}
});
const desktopConfig=(url,overrides={})=>({format:'ink-os-desktop-client-v1',profileId:'e'.repeat(32),kind:'remote',url,mode:'instance',expectedInstanceId:instanceId,credentialVersion:0,token:saved,...overrides});
test('explicit desktop generation configs preserve their pinned instance check in the standalone CLI',async t=>{
 const wrong=await fixture(t,{health:{ok:true,engine:'Ink',instanceId:otherId}});await wrong.config(desktopConfig(wrong.url));const before=await readFile(wrong.configPath),rejected=await wrong.cli(['whoami']);assert.equal(rejected.code,1);assert.match(rejected.stderr,/identity does not match/);assert.deepEqual(wrong.seen,[{path:'/api/health',authorization:undefined}]);assert.deepEqual(await readFile(wrong.configPath),before);noTokens(rejected);
 const correct=await fixture(t);await correct.config(desktopConfig(correct.url));const accepted=await correct.cli(['whoami']);assert.equal(accepted.code,0,accepted.stderr);assert.deepEqual(correct.seen.map(r=>r.authorization),[undefined,'Bearer '+saved]);assert.deepEqual(JSON.parse(accepted.stdout).scopes,['world:read']);noTokens(accepted);
});
test('conflicting identity fields and malformed desktop binding metadata fail before any network',async t=>{
 const f=await fixture(t);for(const fields of[{instanceId:otherId},{mode:'origin-compatibility'},{mode:'invalid'},{expectedInstanceId:null},{expectedInstanceId:'bad'},{kind:'service'},{profileId:'bad'},{credentialVersion:64}]){await f.config(desktopConfig(f.url,fields));const before=await readFile(f.configPath),result=await f.cli(['whoami']);assert.equal(result.code,1);assert.equal(f.seen.length,0);assert.deepEqual(await readFile(f.configPath),before);noTokens(result);}
 await f.config(desktopConfig(f.url,{instanceId}));assert.equal((await f.cli(['whoami'])).code,0);assert.equal(auth(f).length,1);
});
test('desktop legacy origin compatibility probes without fabricating an ID and rejects an advertised identity upgrade',async t=>{
 const legacy=await fixture(t,{health:{ok:true,engine:'Ink'}});await legacy.config(desktopConfig(legacy.url,{mode:'origin-compatibility',expectedInstanceId:null}));const before=await readFile(legacy.configPath),result=await legacy.cli(['whoami']);assert.equal(result.code,0,result.stderr);assert.deepEqual(legacy.seen.map(r=>r.authorization),[undefined,'Bearer '+saved]);assert.deepEqual(await readFile(legacy.configPath),before);assert.equal(Object.hasOwn(JSON.parse(before),'instanceId'),false);noTokens(result);
 const upgraded=await fixture(t);await upgraded.config(desktopConfig(upgraded.url,{mode:'origin-compatibility',expectedInstanceId:null}));const rejected=await upgraded.cli(['whoami']);assert.equal(rejected.code,1);assert.match(rejected.stderr,/now advertises/);assert.equal(auth(upgraded).length,0);assert.equal(upgraded.seen.length,1);noTokens(rejected);
});
test('standalone origin-only service configurations and explicit token pairs retain their intended contract',async t=>{
 const f=await fixture(t);await f.config({url:f.url,token:saved});const result=await f.cli(['whoami']);assert.equal(result.code,0);assert.equal(f.seen.length,1);assert.equal(auth(f)[0].authorization,'Bearer '+saved);noTokens(result);f.seen.length=0;
 await f.config(desktopConfig(f.url,{expectedInstanceId:otherId}));const explicitResult=await f.cli(['whoami','--url',f.url],{token:explicit});assert.equal(explicitResult.code,0);assert.equal(f.seen.length,1);assert.equal(auth(f)[0].authorization,'Bearer '+explicit);noTokens(explicitResult);
});
test('optional desktop session metadata is accepted without substituting its account hash for host identity',async t=>{
 const f=await fixture(t);await f.config(desktopConfig(f.url,{credentialVersion:4,session:{accountHash:'f'.repeat(64),generation:2}}));const accepted=await f.cli(['whoami']);assert.equal(accepted.code,0,accepted.stderr);assert.deepEqual(f.seen.map(r=>r.authorization),[undefined,'Bearer '+saved]);noTokens(accepted);f.seen.length=0;
 await f.config(desktopConfig(f.url,{credentialVersion:4,expectedInstanceId:otherId,session:{accountHash:'f'.repeat(64),generation:2}}));const rejected=await f.cli(['whoami']);assert.equal(rejected.code,1);assert.match(rejected.stderr,/identity does not match/);assert.equal(auth(f).length,0);assert.equal(f.seen.length,1);noTokens(rejected);
});
test('malformed desktop session metadata is rejected before authentication or config mutation',async t=>{
 const f=await fixture(t);for(const session of[null,[],{}, {accountHash:'f'.repeat(64)}, {accountHash:'f'.repeat(64),generation:0,extra:true}, {accountHash:'bad',generation:0}, {accountHash:'F'.repeat(64),generation:0}, {accountHash:1,generation:0}, {accountHash:null,generation:0}, {accountHash:'f'.repeat(64),generation:-1}, {accountHash:'f'.repeat(64),generation:64}, {accountHash:'f'.repeat(64),generation:1}, {accountHash:'f'.repeat(64),generation:.5}]){await f.config(desktopConfig(f.url,{session}));const before=await readFile(f.configPath),result=await f.cli(['whoami']);assert.equal(result.code,1);assert.equal(f.seen.length,0);assert.deepEqual(await readFile(f.configPath),before);noTokens(result);}
 const anonymous=desktopConfig(f.url,{session:{accountHash:'f'.repeat(64),generation:0}});delete anonymous.token;await f.config(anonymous);const rejected=await f.cli(['whoami']);assert.equal(rejected.code,1);assert.equal(f.seen.length,0);noTokens(rejected);
});
