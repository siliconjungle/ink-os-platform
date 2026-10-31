import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createServer} from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createClient} from '../sdk/src/server.js';
const execute=promisify(execFile);
const image=n=>'registry.example/runtime@sha256:'+n.repeat(64);

test('real host gate preserves admitted HTTP work, closes new entries and transports, cancels safely and survives a target boot', {timeout:60000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ink-maintenance-api-')),data=join(directory,'data');
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
 Object.assign(env,{PORT:String(port),INK_OS_DATA_DIR:data,INK_OS_CONFIG:join(data,'client.json'),NODE_ENV:'production',INK_OS_NATIVE:'0',INK_OS_INSTANCE_ID:'a'.repeat(32),INK_OS_IMAGE_PIN:image('1'),INK_OS_RUNTIME_IMAGE:image('2')});
 const url='http://127.0.0.1:'+port;let child,logs='',held,events;
 async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}}
 t.after(async()=>{held?.destroy();await events?.body?.cancel().catch(()=>{});await stop();await rm(directory,{recursive:true,force:true});});
 async function start(){logs='';child=spawn(process.execPath,['scripts/start.mjs'],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let n=0;n<300;n++){if(child.exitCode!==null||child.signalCode!==null)assert.fail(logs);try{if((await fetch(url+'/api/health')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,30));}assert.fail(logs);}
 await start();const config=JSON.parse(await readFile(env.INK_OS_CONFIG)),sdk=createClient({url,token:config.token});
 const cli=async(...args)=>JSON.parse((await execute(process.execPath,['cli/bin/ink-os.mjs',...args],{env})).stdout);
 const member=await sdk.request('accounts',{method:'POST',body:{name:'Maintenance member',scopes:['world:read','world:write','computer']}}),memberSDK=createClient({url,token:member.key.token});
 const inspection=await sdk.maintenance.inspect();assert.equal(inspection.admissionClosed,false);assert.equal(inspection.instanceId,env.INK_OS_INSTANCE_ID);assert.equal(inspection.images.os,env.INK_OS_IMAGE_PIN);await assert.rejects(memberSDK.maintenance.inspect(),{status:403});
 const fromImages={os:image('1'),runtime:image('2')},targetImages={os:image('3'),runtime:image('2')};
 const request={format:'ink-os-maintenance-request-v1',instanceId:env.INK_OS_INSTANCE_ID,operationId:'b'.repeat(32),challenge:'c'.repeat(64),fromImages,targetImages,retireRuntimeImage:false};
 await assert.rejects(memberSDK.maintenance.prepare(request),{status:403});
 events=await fetch(url+'/api/v1/events',{headers:{authorization:'Bearer '+config.token}});assert.equal(events.status,200);
 const bytes=Buffer.from(JSON.stringify({kind:'note',title:'Admitted before gate',body:'Exact committed value'}));
 const completed=new Promise((resolve,reject)=>{held=http.request(url+'/api/v1/data',{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json','content-length':bytes.length}},response=>{const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>resolve({status:response.statusCode,value:JSON.parse(Buffer.concat(chunks))}));});held.on('error',reject);held.write(bytes.subarray(0,1));});
 await new Promise(resolve=>setTimeout(resolve,50));
 const initial=await sdk.maintenance.prepare(request);assert.equal(initial.state,'draining');
 await assert.rejects(sdk.data.create({kind:'note',title:'Must wait'}),{status:503});
 await assert.rejects(memberSDK.maintenance.get(request.operationId),{status:403});
 held.end(bytes.subarray(1));const committed=await completed;assert.equal(committed.status,201);
 async function waitFor(id,state){let result;for(let n=0;n<150;n++){result=await sdk.maintenance.get(id);if(result.state===state)return result;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail(JSON.stringify(result));}
 const quiescent=await waitFor(request.operationId,'quiescent');assert.ok(Object.values(quiescent.activity).every(n=>n===0));assert.equal(quiescent.pool.admissionClosed,true);
 const eventBytes=await events.text();assert.match(eventBytes,/ready/);events=null;
 const cancellation=await sdk.maintenance.cancel(request.operationId,{challenge:request.challenge});assert.equal(cancellation.state,'cancelled');assert.equal((await sdk.maintenance.cancel(request.operationId,{challenge:request.challenge})).state,'cancelled');assert.equal((await sdk.data.get(committed.value.id)).body,'Exact committed value');
 const next={...request,operationId:'d'.repeat(32),challenge:'e'.repeat(64)},input=join(directory,'prepare.json');await writeFile(input,JSON.stringify(next),{mode:0o600});
 assert.equal((await cli('maintenance','prepare','--file',input)).state,'draining');await waitFor(next.operationId,'quiescent');
 const previousBoot=(await cli('maintenance','status',next.operationId)).bootId;const sealed=await sdk.maintenance.seal(next.operationId,{challenge:next.challenge,bootId:previousBoot,fromImages,targetImages});assert.equal(sealed.stopAuthorized,true);await assert.rejects(sdk.maintenance.cancel(next.operationId,{challenge:next.challenge}),{status:409});await stop();env.INK_OS_IMAGE_PIN=targetImages.os;await start();
 const restarted=await sdk.maintenance.get(next.operationId);assert.equal((await sdk.maintenance.inspect()).bootId,restarted.bootId);assert.equal(restarted.state,'restarted');assert.notEqual(restarted.bootId,previousBoot);
 await assert.rejects(sdk.data.create({kind:'note',title:'Gate persists'}),{status:503});
 await assert.rejects(sdk.maintenance.complete(next.operationId,{challenge:'f'.repeat(64),targetImages}),{status:409});
 const done=await sdk.maintenance.complete(next.operationId,{challenge:next.challenge,targetImages});assert.equal(done.state,'complete');assert.equal(done.admissionClosed,false);assert.deepEqual(await sdk.maintenance.complete(next.operationId,{challenge:next.challenge,targetImages}),done);
 assert.equal((await sdk.data.get(committed.value.id)).body,'Exact committed value');assert.equal((await cli('maintenance','status',next.operationId)).state,'complete');
 const post=await sdk.data.create({kind:'note',title:'After upgrade',body:'Shared data still usable'});assert.equal(post.title,'After upgrade');
});
