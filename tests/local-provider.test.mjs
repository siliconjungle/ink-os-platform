import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { LocalProvider } from '../infra/local-provider.mjs';
import { sign } from '../server/platform.mjs';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import http from 'node:http';
import { proofHTTP } from '../scripts/proof-http.mjs';
import { mkdtemp, writeFile, rm, symlink, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('local releases use separate origins, require launch grants, and hide server source', async t => {
  const provider = new LocalProvider(); t.after(() => provider.close());
  const key = randomBytes(32).toString('base64url'), appId = 'a'.repeat(32), releaseId = 'b'.repeat(32);
  const files = [{ path: 'index.html', base64: Buffer.from('<p>local</p>').toString('base64') }, { path: 'server/private.mjs', base64: Buffer.from('private').toString('base64') }];
  provider.attach({ bundle: async () => ({ entry: 'index.html', files }) });
  const first = await provider.deploy({ appId, releaseId, key, origin: 'http://127.0.0.1:4318' });
  const second = await provider.deploy({ appId, releaseId: 'c'.repeat(32), key, origin: 'http://127.0.0.1:4318' });
  assert.notEqual(first.url, second.url);
  assert.equal((await fetch(first.url)).status, 401);
  const ticket = sign({ appId, releaseId, exp: Date.now() + 60000 }, key);
  const launch = await fetch(first.url + '/_ink/launch?ticket=' + ticket, { redirect: 'manual' });
  assert.equal(launch.status, 302);
  const cookie = launch.headers.get('set-cookie').split(';')[0];
  assert.equal(await (await fetch(first.url, { headers: { cookie } })).text(), '<p>local</p>');
  assert.equal((await fetch(first.url + '/server/private.mjs', { headers: { cookie } })).status, 404);
  assert.equal((await fetch(second.url, { headers: { cookie } })).status, 401);
  const preconnect = createConnection({ host: '127.0.0.1', port: Number(new URL(second.url).port) });
  preconnect.on('error', error => assert.equal(error.code, 'ECONNRESET'));
  t.after(() => preconnect.destroy()); await once(preconnect, 'connect');
  const ended = new Promise(resolve => preconnect.once('close', resolve));
  await provider.retire(second); await ended;
  assert.equal(provider.available(second.releaseId), false);
});

test('backend source remains hidden even when its file path shares the backend API prefix', async t => {
  const provider = new LocalProvider(); t.after(() => provider.close());
  const key = randomBytes(32).toString('base64url'), appId = 'a'.repeat(32), releaseId = 'd'.repeat(32);
  await provider.attach({ bundle: async () => ({ entry: 'index.html', backend: { entry: 'backend/private.mjs' }, files: [{ path: 'index.html', base64: Buffer.from('frontend').toString('base64') }, { path: 'backend/private.mjs', base64: Buffer.from('private source').toString('base64') }] }) });
  const deployment = await provider.deploy({ appId, releaseId, key, origin: 'http://127.0.0.1:4318' }), ticket = sign({ appId, releaseId, exp: Date.now() + 60000 }, key), launch = await fetch(deployment.url + '/_ink/launch?ticket=' + ticket, { redirect: 'manual' }), cookie = launch.headers.get('set-cookie').split(';')[0];
  for (const path of ['/backend/private.mjs', '/%62ackend%2fprivate.mjs']) assert.equal((await fetch(deployment.url + path, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(deployment.url + '/backend/health', { headers: { Cookie: cookie } })).status, 503);
  assert.equal(await (await fetch(deployment.url, { headers: { Cookie: cookie } })).text(), 'frontend');
});

test('virtual-host gateway preserves release authentication and rejects absolute proxy targets', async t => {
  let provider;
  const gateway = http.createServer((req, res) => { if (!provider?.route(req, res)) res.end('OS'); });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const address = 'http://127.0.0.1:' + gateway.address().port;
  provider = new LocalProvider({ originTemplate: 'http://__RELEASE__.apps.ink.localhost:' + gateway.address().port });
  t.after(async () => { await provider.close(); await new Promise(resolve => gateway.close(resolve)); });
  const key = randomBytes(32).toString('base64url'), appId = 'a'.repeat(32), releaseId = 'b'.repeat(32);
  await provider.attach({ bundle: async () => ({ entry: 'index.html', files: [{ path: 'index.html', base64: Buffer.from('App').toString('base64') }, { path: 'server/private.mjs', base64: Buffer.from('private').toString('base64') }] }) });
  const deployment = await provider.deploy({ appId, releaseId, key, origin: address });
  const host = new URL(deployment.url).host;
  assert.equal((await proofHTTP(address, '/', { host })).status, 401);
  const ticket = sign({ appId, releaseId, exp: Date.now() + 60000 }, key);
  const opened = await proofHTTP(address, '/_ink/launch?ticket=' + ticket, { host });
  assert.equal(opened.status, 302);
  const cookie = opened.headers.get('set-cookie').split(';')[0];
  assert.equal(await (await proofHTTP(address, '/', { host, headers: { Cookie: cookie } })).text(), 'App');
  assert.equal((await proofHTTP(address, '/server/private.mjs', { host, headers: { Cookie: cookie } })).status, 404);
  const rejected = await new Promise((resolve, reject) => {
    const request = http.request(address, { path: '//outside.invalid/', headers: { Host: host } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(rejected, 400);
});

test('an unavailable local executor is certified inactive only under closed admission and an absent or idle private journal',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'ink-local-inactive-'))),provider=new LocalProvider();
  await writeFile(join(directory,'storage-retention.json'),JSON.stringify({keep:{},safe_to_remove:{'runtime-pool.json':'Generated inactive/active/corrupt journal fixture.','outside.json':'Generated symlink target fixture.'}}));
  t.after(async()=>{await provider.close();await rm(directory,{recursive:true});});
  await provider.attach({directory});let closed=false;provider.bindAdmission(()=>closed);
  assert.equal(await provider.snapshotBackendsInactive(),false);closed=true;assert.equal(await provider.snapshotBackendsInactive(),true);
  const path=join(directory,'runtime-pool.json');
  await writeFile(path,JSON.stringify({version:1,slots:[{status:'ready',appId:'a'.repeat(32),releaseId:'b'.repeat(32),leaseId:'c'.repeat(32),holds:[]}]}));assert.equal(await provider.snapshotBackendsInactive(),false);
  await writeFile(path,JSON.stringify({version:1,slots:[{status:'idle',appId:null,releaseId:null,leaseId:null,holds:[]}]}));assert.equal(await provider.snapshotBackendsInactive(),true);
  await writeFile(path,'broken JSON');assert.equal(await provider.snapshotBackendsInactive(),false);
  await unlink(path);await writeFile(join(directory,'outside.json'),JSON.stringify({version:1,slots:[]}));await symlink(join(directory,'outside.json'),path);assert.equal(await provider.snapshotBackendsInactive(),false);
});
