import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const execute=promisify(execFile),appId='1'.repeat(32),projectId='2'.repeat(32),releaseId='3'.repeat(32),managedCommit='4'.repeat(40),oldCommit='5'.repeat(40),repository='https://github.com/example/legacy-javascript',token='fixture-javascript-deploy-token';
const hash=b=>createHash('sha256').update(b).digest('hex');
const cleanEnv=()=>({PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'});
async function fixture(t,{installed,artifactError,releases=[],statusResponse,runtimeImageEnvironment}={}){
 const root=await mkdtemp(join(tmpdir(),'ink-js-legacy-cli-')),source=join(root,'source'),seen=[],uploads=new Map();await mkdir(source);
 const server=createServer(async(request,response)=>{try{const chunks=[];let size=0;for await(const b of request){size+=b.length;if(size>4*1024*1024)throw Error('Fixture request limit');chunks.push(b);}const raw=Buffer.concat(chunks),path=request.url,method=request.method,body=request.headers['content-type']?.includes('application/json')&&raw.length?JSON.parse(raw):undefined;seen.push({path,method,body,authorization:request.headers.authorization});assert.equal(request.headers.authorization,'Bearer '+token);const reply=(value,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
  if(method==='GET'&&path==='/api/v1/apps')return reply(installed?[{id:appId,body:JSON.stringify(installed)}]:[]);
  if(method==='GET'&&path==='/api/v1/apps/'+appId+'/status')return reply(statusResponse===undefined?{app:{id:appId,body:JSON.stringify(installed)},releases}:statusResponse);
  if(method==='POST'&&(path==='/api/v1/projects/import'||path==='/api/v1/projects/'+projectId+'/snapshot'))return reply({id:projectId,commit:managedCommit});
  if(method==='POST'&&path==='/api/v1/apps')return reply({id:appId,body:JSON.stringify(body)});
  if(method==='GET'&&path==='/api/v1/apps/'+appId+'/artifacts')return reply([]);
  if(method==='PUT'&&path.startsWith('/api/v1/apps/'+appId+'/artifacts/')){const digest=path.split('/').at(-1);assert.equal(hash(raw),digest);if(artifactError)return reply({error:artifactError},401);uploads.set(digest,raw);return reply({id:'6'.repeat(32),sha256:digest,bytes:raw.length});}
  if(method==='POST'&&path==='/api/v1/apps/'+appId+'/releases')return reply({id:releaseId});
  if(method==='POST'&&path==='/api/v1/apps/'+appId+'/releases/'+releaseId+'/publish')return reply({body:JSON.stringify({url:'https://example.invalid/fixture'})});
  reply({error:'Unexpected fixture route'},404);
 }catch(error){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:'Fixture request rejected'}));}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeIdleConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});});
 const cli=async(...args)=>new Promise((done,reject)=>{const child=spawn(process.execPath,['cli/bin/ink-os.mjs','deploy',source,...args],{cwd:new URL('..',import.meta.url),env:{...cleanEnv(),INK_OS_URL:url,INK_OS_TOKEN:token,INK_OS_CONFIG:join(root,'no-saved-config.json'),...(runtimeImageEnvironment===undefined?{}:{INK_OS_APP_RUNTIME_IMAGE:runtimeImageEnvironment})},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>{assert.ok(!stdout.includes(token)&&!stderr.includes(token));done({code,stdout,stderr});});});
 const manifest=async value=>writeFile(join(source,'ink-app.json'),JSON.stringify({slug:'legacy-javascript-fixture',title:'JavaScript deploy fixture',directory:'dist',entry:'index.html',...value}));
 const git=async(...args)=>(await execute('git',['-C',source,...args],{env:cleanEnv()})).stdout.trim();
 const commit=async()=>{await git('add','--all');await git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath='+join(source,'.git/no-hooks'),'commit','-m','Commit explicit fixture source');return git('rev-parse','HEAD');};
 const initialize=async()=>git('init','-b','main');
 const release=()=>seen.find(r=>r.method==='POST'&&r.path==='/api/v1/apps/'+appId+'/releases')?.body;
 const asset=(path)=>{const files=JSON.parse(Buffer.from(release().files.find(f=>f.path==='ink-assets.json').base64,'base64')).files,file=files.find(f=>f.path===path);return Buffer.concat(file.chunks.map(part=>uploads.get(part.sha256).subarray(part.offset,part.offset+part.length)));};
 return{root,source,seen,uploads,cli,manifest,git,commit,initialize,release,asset};
}
const writes=f=>f.seen.filter(r=>r.method!=='GET');
async function staged(f,text='<!doctype html><p>Staged built output</p>'){await mkdir(join(f.source,'dist'),{recursive:true});await writeFile(join(f.source,'dist/index.html'),text);}

test('legacy repository deploy accepts an explicit staged directory outside Git and retains repository/full-commit provenance',async t=>{
 const f=await fixture(t);await f.manifest({repository,sourceCommit:oldCommit,backend:{entry:'server.mjs'}});await staged(f);await writeFile(join(f.source,'dist/server.mjs'),'export default ()=>({legacy:true});');const result=await f.cli();assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{appId,releaseId,url:'https://example.invalid/fixture'});assert.ok(!f.seen.some(r=>r.path.includes('/projects')));const created=f.seen.find(r=>r.method==='POST'&&r.path==='/api/v1/apps').body;assert.equal(created.repository,repository);assert.equal(created.sourceCommit,oldCommit);assert.equal(created.projectId,undefined);assert.deepEqual(f.release().source,{repository,commit:oldCommit});assert.equal(f.asset('index.html').toString(),'<!doctype html><p>Staged built output</p>');assert.equal(Buffer.from(f.release().files.find(file=>file.path==='server.mjs').base64,'base64').toString(),'export default ()=>({legacy:true});');
});
test('legacy committed repository still permits ignored generated dist output and an explicitly selected full revision',async t=>{
 const f=await fixture(t);await f.manifest({repository});await writeFile(join(f.source,'.gitignore'),'dist/\n');await writeFile(join(f.source,'source.mjs'),'export const original=true;');await f.initialize();const origin=await f.commit();await staged(f,'<!doctype html><p>Generated after source commit</p>');const result=await f.cli('--commit',origin,'--preview-only');assert.equal(result.code,0,result.stderr);assert.deepEqual(f.release().source,{repository,commit:origin});assert.equal(f.asset('index.html').toString(),'<!doctype html><p>Generated after source commit</p>');assert.ok(!f.seen.some(r=>r.path.includes('/projects')));assert.ok(!f.seen.some(r=>r.path.endsWith('/publish')));
});
test('explicit --project for a new JavaScript app snapshots actual clean Git instead of stale manifest repository/commit',async t=>{
 const f=await fixture(t);await f.manifest({repository,sourceCommit:oldCommit,desktop:{entry:'app',icon:'code'},capabilities:['world.read'],commands:[]});await staged(f,'<p>Current committed app</p>');await writeFile(join(f.source,'run.sh'),'#!/bin/sh\ntrue\n');await chmod(join(f.source,'run.sh'),0o755);await f.initialize();const origin=await f.commit(),result=await f.cli('--project='+projectId,'--preview-only');assert.equal(result.code,0,result.stderr);const snapshot=f.seen.find(r=>r.path==='/api/v1/projects/'+projectId+'/snapshot');assert.equal(snapshot.body.originCommit,origin);assert.match(snapshot.body.tree,/^[a-f0-9]{40}$/);assert.equal(snapshot.body.files.find(file=>file.path==='run.sh').mode,'100755');assert.equal(Buffer.from(snapshot.body.files.find(file=>file.path==='dist/index.html').base64,'base64').toString(),'<p>Current committed app</p>');assert.ok(!f.seen.some(r=>r.path==='/api/v1/projects/import'));const created=f.seen.find(r=>r.path==='/api/v1/apps'&&r.method==='POST').body;assert.equal(created.projectId,projectId);assert.equal(created.repository,undefined);assert.equal(created.sourceCommit,managedCommit);assert.deepEqual(created.capabilities,['world.read']);assert.deepEqual(f.release().source,{projectId,commit:managedCommit,originCommit:origin});
});
test('different explicit project cannot rebind either a legacy repository app or an existing managed app',async t=>{
 for(const installed of[{slug:'legacy-javascript-fixture',repository,sourceCommit:oldCommit},{slug:'legacy-javascript-fixture',projectId,sourceCommit:managedCommit}]){const f=await fixture(t,{installed});await f.manifest({repository,sourceCommit:oldCommit});await staged(f);const result=await f.cli('--app',appId,'--project','f'.repeat(32));assert.equal(result.code,1);assert.match(result.stderr,/existing source project/i);assert.equal(writes(f).length,0);assert.equal(f.uploads.size,0);}
});
test('explicit project mode rejects stale --commit and dirty source before importing, creating apps or uploading artifacts',async t=>{
 for(const dirty of[false,true]){const f=await fixture(t);await f.manifest({repository,sourceCommit:oldCommit});await staged(f);await f.initialize();await f.commit();if(dirty)await writeFile(join(f.source,'dist/index.html'),'Uncommitted content');const result=await f.cli('--project',projectId,...(dirty?[]:['--commit',oldCommit]));assert.equal(result.code,1);assert.match(result.stderr,dirty?/Commit source changes/i:/selected commit must match/i);assert.equal(writes(f).length,0);assert.equal(f.uploads.size,0);}
});

test('release path preflight blocks directory escapes, top symlinks and backend escapes before any mutable HTTP request',async t=>{
 for(const mode of['outside-directory','top-directory-symlink','directory-is-file','backend-parent','backend-absolute','backend-backslash','backend-symlink']){
  const f=await fixture(t),privateDirectory=join(f.root,'private');await mkdir(privateDirectory);await writeFile(join(privateDirectory,'index.html'),'synthetic private sibling content');await writeFile(join(privateDirectory,'secret.mjs'),'synthetic private backend content');let directory='dist',backend;
  if(mode==='outside-directory')directory='../private';
  else if(mode==='top-directory-symlink')await symlink(privateDirectory,join(f.source,'dist'),'dir');
  else if(mode==='directory-is-file'){directory='not-a-directory';await writeFile(join(f.source,directory),'not a directory');}
  else await staged(f);
  if(mode==='backend-parent'){backend={entry:'../secret.mjs'};await writeFile(join(f.source,'secret.mjs'),'synthetic out-of-assets backend');}
  if(mode==='backend-absolute')backend={entry:join(privateDirectory,'secret.mjs')};
  if(mode==='backend-backslash')backend={entry:'..\\secret.mjs'};
  if(mode==='backend-symlink'){backend={entry:'server.mjs'};await symlink(join(privateDirectory,'secret.mjs'),join(f.source,'dist/server.mjs'),'file');}
  await f.manifest({repository,sourceCommit:oldCommit,directory,...(backend?{backend}:{})});
  const result=await f.cli();assert.equal(result.code,1,mode+': '+result.stderr);assert.equal(writes(f).length,0,mode+' must reject before project import, app creation, artifact upload or release creation');assert.equal(f.uploads.size,0,mode);
 }
});

test('managed-project deployment validates release paths before importing a clean source snapshot',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'private'));await writeFile(join(f.root,'private/index.html'),'synthetic private sibling data');await f.manifest({repository,sourceCommit:oldCommit,directory:'../private'});await writeFile(join(f.source,'source.mjs'),'export const clean=true;');await f.initialize();await f.commit();const result=await f.cli('--project',projectId);assert.equal(result.code,1);assert.equal(writes(f).length,0);assert.ok(!f.seen.some(r=>r.path.includes('/snapshot')||r.path.includes('/import')));assert.equal(f.uploads.size,0);
});

test('artifact upload 401 errors redact an echoed credential and stop without retrying or creating a release',async t=>{
 const f=await fixture(t,{artifactError:'Rejected artifact credential '+token});await f.manifest({repository,sourceCommit:oldCommit});await staged(f);const result=await f.cli();assert.equal(result.code,1);assert.match(result.stderr,/Rejected artifact credential \[redacted\]/);assert.ok(!result.stderr.includes(token));assert.ok(!result.stdout.includes(token));assert.equal(f.seen.filter(r=>r.method==='PUT'&&r.path.includes('/artifacts/')).length,1);assert.ok(!f.seen.some(r=>r.path.endsWith('/releases')||r.path.endsWith('/publish')));assert.equal(f.uploads.size,0);
});

const selectedReleaseId='7'.repeat(32),installedRuntime='example.invalid/fixture/custom-runtime@sha256:'+'8'.repeat(64),explicitRuntime='example.invalid/fixture/replacement-runtime@sha256:'+'9'.repeat(64),manifestRuntime='example.invalid/fixture/authored-runtime@sha256:'+'a'.repeat(64);
const moduleBackend={entry:'server.mjs',idleSafe:false,memoryMb:512};
async function moduleFixture(t,{authoredBackend=moduleBackend,installedBackend={...moduleBackend,runtimeImage:installedRuntime},statusResponse,releases,runtimeImageEnvironment}={}){
 const installed={slug:'legacy-javascript-fixture',projectId,sourceCommit:managedCommit,releaseId:selectedReleaseId},selected={id:selectedReleaseId,body:JSON.stringify({appId,backend:installedBackend})};
 const f=await fixture(t,{installed,releases:releases??[{id:'b'.repeat(32),body:JSON.stringify({appId,backend:{...moduleBackend,runtimeImage:explicitRuntime}})},selected],statusResponse,runtimeImageEnvironment});
 await f.manifest({repository,sourceCommit:oldCommit,backend:authoredBackend});await staged(f);await writeFile(join(f.source,'dist/server.mjs'),'export default ()=>({moduleFixture:true});');await f.initialize();const origin=await f.commit();return{...f,origin,installed,selected};
}
test('migrated project module preserves the selected release runtime image without embedding it in authored source',async t=>{
 for(const explicitApp of[true,false]){const f=await moduleFixture(t,{installedBackend:{...moduleBackend,memoryMb:256,runtimeImage:installedRuntime}}),result=await f.cli(...(explicitApp?['--app',appId]:[]),'--preview-only');assert.equal(result.code,0,result.stderr);assert.equal(f.release().backend.runtimeImage,installedRuntime);assert.equal(f.release().backend.memoryMb,512);assert.equal(f.release().backend.idleSafe,false);assert.deepEqual(f.release().source,{projectId,commit:managedCommit,originCommit:f.origin});const snapshot=f.seen.find(r=>r.path==='/api/v1/projects/'+projectId+'/snapshot'),manifest=JSON.parse(Buffer.from(snapshot.body.files.find(file=>file.path==='ink-app.json').base64,'base64'));assert.equal(manifest.backend.runtimeImage,undefined);assert.ok(f.seen.findIndex(r=>r.path.endsWith('/status'))<f.seen.indexOf(snapshot));assert.ok(!f.seen.some(r=>r.path==='/api/v1/apps'&&r.method==='POST'));}
});
test('runtime image flags/environment/default and explicit authored pins have their intended release payload precedence',async t=>{
 const cases=[{name:'explicit pin',args:['--runtime-image',explicitRuntime],expected:explicitRuntime},{name:'explicit default clears authored pin',args:['--runtime-image=default'],authored:manifestRuntime,expected:undefined},{name:'environment pin',environment:explicitRuntime,expected:explicitRuntime},{name:'environment default',environment:'default',expected:undefined},{name:'flag beats environment and authored pin',args:['--runtime-image',explicitRuntime],environment:installedRuntime,authored:manifestRuntime,expected:explicitRuntime},{name:'authored pin wins without override',authored:manifestRuntime,expected:manifestRuntime}];
 for(const c of cases){const f=await moduleFixture(t,{authoredBackend:{...moduleBackend,...(c.authored?{runtimeImage:c.authored}:{})},runtimeImageEnvironment:c.environment}),result=await f.cli('--app',appId,'--preview-only',...(c.args||[]));assert.equal(result.code,0,c.name+': '+result.stderr);assert.equal(f.release().backend.runtimeImage,c.expected,c.name);assert.equal(f.release().backend.entry,'server.mjs');assert.equal(f.release().backend.memoryMb,512);assert.equal(f.release().source.projectId,projectId);}
});
test('invalid runtime pins, missing module entries and mixed OCI/module configuration reject before any mutable request',async t=>{
 const cases=[{name:'unpinned flag',args:['--runtime-image','example.invalid/fixture/runtime:latest'],backend:moduleBackend},{name:'invalid authored pin',backend:{...moduleBackend,runtimeImage:'example.invalid/fixture/runtime@sha256:short'}},{name:'missing entry override',backend:{idleSafe:false},args:['--runtime-image',explicitRuntime]},{name:'OCI override',backend:{image:'example.invalid/fixture/standalone:latest',port:8080},args:['--runtime-image',explicitRuntime]},{name:'pin without entry',backend:{runtimeImage:explicitRuntime}},{name:'mixed authored module and OCI',backend:{...moduleBackend,image:'example.invalid/fixture/standalone:latest',port:8080,runtimeImage:explicitRuntime}}];
 for(const c of cases){const f=await moduleFixture(t,{authoredBackend:c.backend}),result=await f.cli('--app',appId,...(c.args||[]));assert.equal(result.code,1,c.name+': '+result.stderr);assert.equal(writes(f).length,0,c.name);assert.equal(f.uploads.size,0,c.name);assert.equal(f.release(),undefined,c.name);}
});
test('missing selected runtime metadata, invalid preserved pins and mismatched status identity fail before source import or upload',async t=>{
 const installed={slug:'legacy-javascript-fixture',projectId,sourceCommit:managedCommit,releaseId:selectedReleaseId},cases=[{name:'selected release missing',releases:[]},{name:'wrong selected release only',releases:[{id:'c'.repeat(32),body:JSON.stringify({appId,backend:{...moduleBackend,runtimeImage:installedRuntime}})}]},{name:'invalid installed pin',installedBackend:{...moduleBackend,runtimeImage:'not-pinned'}},{name:'foreign app status',statusResponse:{app:{id:'d'.repeat(32),body:JSON.stringify(installed)},releases:[]}},{name:'missing app status',statusResponse:{releases:[]}}];
 for(const c of cases){const f=await moduleFixture(t,c),result=await f.cli('--app',appId);assert.equal(result.code,1,c.name+': '+result.stderr);assert.equal(writes(f).length,0,c.name);assert.equal(f.uploads.size,0,c.name);assert.equal(f.release(),undefined,c.name);}
});
