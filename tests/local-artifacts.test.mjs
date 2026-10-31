import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { validateArtifactReferences, managedArtifactBucket, ARTIFACT_CHUNK_BYTES } from '../server/artifacts.mjs';
import { LocalProvider } from '../infra/local-provider.mjs';
import { Storage } from '../server/storage.mjs';
import { sign } from '../server/platform.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), appId = 'a'.repeat(32), objectId = 'b'.repeat(32);
function reference(bytes, location, namespace = appId) { return { id: objectId, kind: 'file', namespace, archived: false, tags: ['app-artifact'], location, body: JSON.stringify({ sha256: hash(bytes), bytes: bytes.length }) }; }
function assets(bytes) { return new Map([['index.html', { path: 'index.html', bytes: bytes.length, sha256: hash(bytes), mime: 'text/html', objectId }]]); }

test('artifact validation permits only app-owned exact local/current R2/S3 content addresses and refuses foreign storage before reading', async () => {
  const bytes = Buffer.from('bounded artifact'), digest = hash(bytes); let reads = 0;
  const readAliasCurrent = async (_location, options) => { assert.equal(options.maxBytes, ARTIFACT_CHUNK_BYTES); assert.equal(options.allowMissing, true); reads++; return bytes; }, storage = { r2: { bucket: 'current-assets' }, readAliasCurrent };
  for (const [location, context] of [['blob:' + digest, { readAliasCurrent }], ['r2://current-assets/objects/' + digest, storage], ['s3://current-s3/owned/objects/' + digest, { config: { bucket: 'current-s3', prefix: 'owned/' }, readAliasCurrent }]]) {
    const world = { all: () => [reference(bytes, location)] }; assert.equal(validateArtifactReferences(world, assets(bytes), appId, context).size, 1);
    const bucket = managedArtifactBucket({ world, storage: context }, appId, assets(bytes).get('index.html')); const object = await bucket.get('objects/' + digest, { range: { offset: 2, length: 6 } }); assert.equal(object.size, bytes.length); assert.equal(await new Response(object.body).text(), bytes.subarray(2, 8).toString());
  }
  const before = reads;
  for (const [location, namespace] of [['r2://foreign-assets/objects/' + digest, appId], ['s3://current-s3/elsewhere/objects/' + digest, appId], ['blob:' + digest, appId], ['r2://current-assets/objects/' + digest, 'c'.repeat(32)], ['blob:' + 'f'.repeat(64), appId], ['r2://current-assets/objects/' + digest + '?query=1', appId]]) assert.throws(() => managedArtifactBucket({ world: { all: () => [reference(bytes, location, namespace)] }, storage }, appId, assets(bytes).get('index.html')), { status: 403 });
  assert.equal(reads, before); const world = { all: () => [reference(bytes, 'r2://current-assets/objects/' + digest)] }; assert.equal(validateArtifactReferences(world, assets(bytes), appId, 'current-assets').size, 1); assert.throws(() => validateArtifactReferences(world, assets(bytes), appId, 'other-assets'), { status: 403 });
  const bounded = managedArtifactBucket({ world, storage }, appId, assets(bytes).get('index.html')); await assert.rejects(bounded.get('objects/' + 'f'.repeat(64), { range: { offset: 0, length: 1 } }), { status: 403 }); assert.equal(reads, before);
  const tooLarge = { ...assets(bytes).get('index.html'), bytes: ARTIFACT_CHUNK_BYTES + 1 }; assert.throws(() => managedArtifactBucket({ world: { all: () => [reference(Buffer.alloc(1), 'blob:' + digest)] }, storage }, appId, tooLarge), { status: 403 });
});

async function host(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ink-local-artifacts-'))), data = join(directory, 'data'), probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  await writeFile(join(directory, 'storage-retention.json'), JSON.stringify({ keep: { data: 'Owned local artifact HTTP host fixture until its graceful shutdown.', 'storage-retention.json': 'Transient fixture retention policy.' }, safe_to_remove: {} }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name))); Object.assign(env, { PORT: String(port), INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR: data, NODE_ENV: 'production', INK_OS_NATIVE: '0', INK_OS_HOSTING: 'local' }); let child, output = '', client;
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => { output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', bytes => output = (output + bytes).slice(-8192)); child.stderr.on('data', bytes => output = (output + bytes).slice(-8192)); for (let n = 0; n < 150; n++) { if (child.exitCode !== null || child.signalCode !== null) assert.fail(output); try { if ((await fetch('http://127.0.0.1:' + port + '/api/health')).ok) { client = JSON.parse(await readFile(join(data, 'client.json'))); return; } } catch {} await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail(output); };
  await start();
  const request = async (path, { method = 'GET', body, binary = false } = {}) => { const response = await fetch(client.url + '/api/v1/' + path, { method, headers: { Authorization: 'Bearer ' + client.token, 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) }); return { response, value: await response.json() }; };
  const ok = async (path, options) => { const result = await request(path, options); assert.ok(result.response.ok, JSON.stringify(result.value)); return result.value; };
  const upload = async (id, bytes) => ok('apps/' + id + '/artifacts/' + hash(bytes), { method: 'PUT', body: bytes, binary: true });
  const launch = async id => { const result = await ok('apps/' + id + '/launch', { method: 'POST', body: {} }), opened = await fetch(result.url, { redirect: 'manual' }); assert.equal(opened.status, 302); return { url: result.origin, cookie: opened.headers.get('set-cookie').split(';')[0], result }; };
  return { data, start, stop, request, ok, upload, launch };
}

test('actual local HTTP artifact upload, release, publish and launch serve direct/pack/cross-chunk ranges, protect source and recover after restart', { timeout: 30000 }, async t => {
  const f = await host(t), app = await f.ok('apps', { method: 'POST', body: { slug: 'local-artifact-proof', title: 'Local artifact proof', commands: [] } }), foreign = await f.ok('apps', { method: 'POST', body: { slug: 'foreign-artifact-proof', commands: [] } });
  const first = Buffer.from('<!doctype html><p>first chunk · '), second = Buffer.from('second chunk · end</p>'), page = Buffer.concat([first, second]), pack = Buffer.from('prefix-PACKED-BODY-suffix'), direct = Buffer.from('exact direct asset');
  const a = await f.upload(app.id, first), b = await f.upload(app.id, second), p = await f.upload(app.id, pack), d = await f.upload(app.id, direct), other = await f.upload(foreign.id, first); assert.equal(a.location, 'blob:' + hash(first)); assert.notEqual(a.id, other.id);
  const part = (object, bytes, offset = 0, length = bytes.length) => ({ objectId: object.id, sha256: hash(bytes), bytes: bytes.length, offset, length });
  const descriptors = [{ path: 'index.html', mime: 'text/html; charset=utf-8', bytes: page.length, sha256: hash(page), chunks: [part(a, first), part(b, second)] }, { path: 'pack.bin', mime: 'application/octet-stream', bytes: 11, sha256: hash(pack.subarray(7, 18)), objectId: p.id, pack: { sha256: hash(pack), bytes: pack.length, offset: 7 } }, { path: 'direct.txt', mime: 'text/plain', bytes: direct.length, sha256: hash(direct), objectId: d.id }, { path: 'server/private.mjs', mime: 'text/javascript', bytes: direct.length, sha256: hash(direct), objectId: d.id }, { path: 'server.mjs', mime: 'text/javascript', bytes: direct.length, sha256: hash(direct), objectId: d.id }];
  const bundle = { entry: 'index.html', commands: [], backend: { entry: 'server.mjs' }, files: [{ path: 'ink-assets.json', base64: Buffer.from(JSON.stringify({ version: 1, files: descriptors })).toString('base64') }, { path: 'server.mjs', base64: Buffer.from('export default {fetch(){return new Response("private backend")}}').toString('base64') }, { path: 'inline.txt', base64: Buffer.from('inline fallback').toString('base64') }] };
  const forbidden = structuredClone(bundle), manifest = JSON.parse(Buffer.from(forbidden.files[0].base64, 'base64')); manifest.files[0].chunks[0].objectId = other.id; forbidden.files[0].base64 = Buffer.from(JSON.stringify(manifest)).toString('base64'); assert.equal((await f.request('apps/' + app.id + '/releases', { method: 'POST', body: forbidden })).response.status, 403);
  const release = await f.ok('apps/' + app.id + '/releases', { method: 'POST', body: bundle }); await f.ok('apps/' + app.id + '/releases/' + release.id + '/publish', { method: 'POST', body: {} }); let opened = await f.launch(app.id);
  const get = (path = '/', options = {}) => fetch(opened.url + path, { ...options, headers: { Cookie: opened.cookie, ...options.headers }, signal: AbortSignal.timeout(5000) });
  assert.equal((await fetch(opened.url)).status, 401); assert.deepEqual(Buffer.from(await (await get()).arrayBuffer()), page); assert.deepEqual(Buffer.from(await (await get('/client/route')).arrayBuffer()), page);
  const range = await get('/', { headers: { Range: 'bytes=' + (first.length - 3) + '-' + (first.length + 4) } }); assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes ${first.length - 3}-${first.length + 4}/${page.length}`); assert.deepEqual(Buffer.from(await range.arrayBuffer()), page.subarray(first.length - 3, first.length + 5));
  const head = await get('/', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(page.length)); assert.equal(await head.text(), ''); assert.equal(head.headers.get('etag'), '"' + hash(page) + '"');
  const rangedHead = await get('/', { method: 'HEAD', headers: { Range: 'bytes=-6' } }); assert.equal(rangedHead.status, 206); assert.equal(rangedHead.headers.get('content-length'), '6'); assert.equal(await rangedHead.text(), ''); assert.deepEqual(Buffer.from(await (await get('/', { headers: { Range: 'bytes=-6' } })).arrayBuffer()), page.subarray(-6));
  assert.deepEqual(Buffer.from(await (await get('/pack.bin')).arrayBuffer()), pack.subarray(7, 18)); assert.equal(await (await get('/pack.bin', { headers: { Range: 'bytes=2-5' } })).text(), pack.subarray(9, 13).toString()); assert.equal(await (await get('/direct.txt')).text(), direct.toString()); assert.equal(await (await get('/inline.txt')).text(), 'inline fallback');
  for (const path of ['/server/private.mjs', '/server.mjs', '/%73erver/private.mjs', '/_ink/private']) assert.equal((await get(path)).status, 404, path); assert.equal((await get('/', { method: 'POST' })).status, 405); assert.equal((await get('/', { headers: { Range: 'bytes=99999-' } })).status, 416);
  const foreignRelease = await f.ok('apps/' + foreign.id + '/releases', { method: 'POST', body: { entry: 'index.html', files: [{ path: 'index.html', base64: Buffer.from('other app').toString('base64') }] } }); await f.ok('apps/' + foreign.id + '/releases/' + foreignRelease.id + '/publish', { method: 'POST', body: {} }); const foreignOpened = await f.launch(foreign.id); assert.equal((await fetch(foreignOpened.url, { headers: { Cookie: opened.cookie } })).status, 401);
  await writeFile(join(f.data, 'blobs', hash(first)), Buffer.alloc(first.length, 88)); const tampered = await get(); assert.equal(tampered.status, 502); assert.ok(!(await tampered.text()).includes(f.data)); await writeFile(join(f.data, 'blobs', hash(first)), first);
  await unlink(join(f.data, 'blobs', hash(second))); const missing = await get('/', { headers: { Range: 'bytes=' + first.length + '-' } }); assert.equal(missing.status, 503); assert.ok(!(await missing.text()).includes(f.data)); const interrupted = await get(); await assert.rejects(interrupted.arrayBuffer()); await writeFile(join(f.data, 'blobs', hash(second)), second, { mode: 0o600 });
  await f.stop(); await f.start(); opened = await f.launch(app.id); assert.deepEqual(Buffer.from(await (await get()).arrayBuffer()), page); assert.equal(await (await get('/direct.txt')).text(), direct.toString());
});

test('provider retirement waits for an already admitted artifact read and requires no compute backend', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ink-artifact-drain-'))), storage = await new Storage(directory, { env: {} }).open(), bytes = Buffer.from('active artifact read completes'); const blob = await storage.put(bytes), digest = hash(bytes), object = reference(bytes, blob.location); let began, release; const started = new Promise(resolve => { began = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  await writeFile(join(directory, 'storage-retention.json'), JSON.stringify({ keep: { blobs: 'Owned artifact drain fixture until admitted response and provider retirement finish.', 'storage-retention.json': 'Transient fixture retention policy.' }, safe_to_remove: {} }));
  const read = storage.readAliasCurrent.bind(storage); storage.readAliasCurrent = async (...args) => { began(); await barrier; return read(...args); };
  const manifest = { version: 1, files: [{ path: 'index.html', mime: 'text/html', bytes: bytes.length, sha256: digest, objectId }] }, provider = new LocalProvider(); t.after(async () => { release(); await provider.close(); await rm(directory, { recursive: true, force: true }); });
  await provider.attach({ storage, world: { all: () => [object] }, bundle: async () => ({ entry: 'index.html', files: [{ path: 'ink-assets.json', base64: Buffer.from(JSON.stringify(manifest)).toString('base64') }] }) });
  const key = randomBytes(32).toString('base64url'), releaseId = 'd'.repeat(32), deployment = await provider.deploy({ appId, releaseId, key, origin: 'http://127.0.0.1:4318' }), ticket = sign({ appId, releaseId, exp: Date.now() + 60000 }, key), launch = await fetch(deployment.url + '/_ink/launch?ticket=' + ticket, { redirect: 'manual' }), cookie = launch.headers.get('set-cookie').split(';')[0];
  const request = fetch(deployment.url, { headers: { Cookie: cookie } }).then(response => response.text()); await started; let retired = false; const retiring = provider.retire(deployment).then(() => { retired = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(retired, false); release(); assert.equal(await request, bytes.toString()); await retiring; assert.equal(provider.available(releaseId), false); assert.equal(provider.pool, undefined);
});
