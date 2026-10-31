import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { continuationContext, continuationFromEnvironment, continuationHeaders, CONTINUATION_HEADER } from '../shared/continuation.mjs';
import { createClient } from '../sdk/src/server.js';
import { uploadArtifact } from '../cli/bin/artifacts.mjs';

const execute=promisify(execFile),lease='ink3.'+'a'.repeat(32)+'.'+'b'.repeat(32)+'.'+'c'.repeat(32)+'.'+'x'.repeat(43),account='disposable-account-key';
async function endpoint(t,route){
  const calls=[],server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);calls.push({path:req.url,headers:req.headers,body:Buffer.concat(chunks)});if(route?.(req,res))return;if(req.url==='/api/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,engine:'Ink',instanceId:'f'.repeat(32)}));return;}if(req.url==='/api/v1/events'){res.setHeader('Content-Type','text/event-stream');res.end('data: {"kind":"fixture"}\n\n');return;}if(req.url.includes('/assets/')||req.url.includes('/files/')){res.end('fixture bytes');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accountId:'owner',id:'fixture-upload'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));return{url:'http://127.0.0.1:'+server.address().port,calls};
}
test('continuation context is exact-origin, transient and requires a full compute lease credential',()=>{
  const context=continuationContext({url:'https://host.invalid/',token:lease});assert.ok(Object.isFrozen(context));
  assert.deepEqual(continuationHeaders('https://host.invalid/api/v1/me',context),{[CONTINUATION_HEADER]:lease});
  for(const target of ['https://other.invalid/api/v1/me','http://host.invalid/api/v1/me','https://host.invalid:8443/api/v1/me'])assert.deepEqual(continuationHeaders(target,context),{});
  assert.equal(continuationFromEnvironment({}),null);
  for(const value of [{url:'https://host.invalid',token:'ink2.invalid'},{url:'https://host.invalid/path',token:lease},{url:'https://user:password@host.invalid',token:lease},{url:'https://host.invalid?query',token:lease},{url:'https://host.invalid',token:lease+'\r\nInjected: yes'}])assert.throws(()=>continuationContext(value));
  assert.throws(()=>continuationFromEnvironment({INK_OS_CONTINUATION_URL:'https://host.invalid'}));
});
test('SDK JSON, binary and event requests carry continuation only to its host and never follow credential redirects',async t=>{
  const foreign=await endpoint(t),own=await endpoint(t,(req,res)=>{if(req.url==='/api/v1/redirect'){res.writeHead(302,{Location:foreign.url+'/api/v1/me'});res.end();return true;}return false;});
  const continuation={url:own.url,token:lease},sdk=createClient({url:own.url,token:account,continuation});
  await sdk.account.me();assert.equal(Buffer.from(await sdk.assets.get('fixture')).toString(),'fixture bytes');const events=[];for await(const event of sdk.events())events.push(event);assert.deepEqual(events,[{kind:'fixture'}]);
  await assert.rejects(sdk.request('redirect'));assert.equal(foreign.calls.length,0);
  for(const call of own.calls){assert.equal(call.headers[CONTINUATION_HEADER],lease);assert.equal(call.headers.authorization,'Bearer '+account);}
  await createClient({url:foreign.url,token:'explicit-foreign-account',continuation}).account.me();assert.equal(foreign.calls[0].headers[CONTINUATION_HEADER],undefined);
  assert.ok(!JSON.stringify(sdk).includes(lease));
});
test('CLI API/download and binary upload preserve origin binding and redact both credentials from errors',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'ink-continuation-client-')));await writeFile(join(root,'storage-retention.json'),JSON.stringify({keep:{},safe_to_remove:{download:'Generated CLI download fixture.','absent.json':'Generated private login fixture; continuation credentials must not be persisted.'}}));t.after(()=>rm(root,{recursive:true}));
  const own=await endpoint(t,(req,res)=>{if(req.url==='/api/v1/error'){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:account+' '+lease}));return true;}return false;}),foreign=await endpoint(t),continuation={url:own.url,token:lease};
  const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('INK_'))),INK_OS_URL:own.url,INK_OS_TOKEN:account,INK_OS_CONFIG:join(root,'absent.json'),INK_OS_CONTINUATION_URL:own.url,INK_OS_CONTINUATION_TOKEN:lease};
  const cli=async args=>JSON.parse((await execute(process.execPath,['cli/bin/ink-os.mjs',...args],{env})).stdout);
  await cli(['whoami']);await cli(['files','download','a'.repeat(32),'--output',join(root,'download')]);assert.equal(await readFile(join(root,'download'),'utf8'),'fixture bytes');
  await uploadArtifact(new URL('/api/v1/artifact',own.url),Buffer.from('artifact'),{token:account,continuation});
  assert.ok(own.calls.every(call=>call.headers[CONTINUATION_HEADER]===lease));
  await cli(['whoami','--url',foreign.url]);assert.equal(foreign.calls[0].headers[CONTINUATION_HEADER],undefined);
  await execute(process.execPath,['cli/bin/ink-os.mjs','login','--url',own.url],{env});
  const saved=await readFile(env.INK_OS_CONFIG,'utf8');assert.ok(!saved.includes(lease));assert.ok(!saved.includes('continuation'));
  const health=own.calls.filter(call=>call.path==='/api/health');assert.ok(health.length>0);assert.ok(health.every(call=>call.headers[CONTINUATION_HEADER]===undefined&&call.headers.authorization===undefined));
  const sdk=createClient({url:own.url,token:account,continuation});
  for(const run of [()=>sdk.request('error'),()=>uploadArtifact(new URL('/api/v1/error',own.url),Buffer.from('x'),{token:account,continuation})])await assert.rejects(run(),error=>{assert.ok(!error.message.includes(account));assert.ok(!error.message.includes(lease));assert.match(error.message,/redacted/);return true;});
});
