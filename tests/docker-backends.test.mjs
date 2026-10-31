import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../sdk/src/server.js';
import { DockerEngine } from '../infra/docker-engine.mjs';
import { proofHTTP } from '../scripts/proof-http.mjs';
import { recoverBackup } from '../server/backup-recovery.mjs';

const execute = promisify(execFile);
test('real Docker backends preserve held work across restart, isolate tenants, reuse idle slots and run OCI handlers', { skip: process.env.INK_TEST_DOCKER !== '1', timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-docker-proof-')), engine = new DockerEngine();
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|LANG|LC_ALL|TMPDIR|INK_OS_DOCKER_SOCKET)$/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_BIND: '0.0.0.0', INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR: directory, INK_OS_CONFIG: join(directory, 'client.json'), INK_OS_NATIVE: '0', INK_OS_BACKENDS: 'docker', INK_OS_DOCKER_OS_URL: 'http://host.docker.internal:' + port, INK_OS_DOCKER_IDLE_MS: '1000', HOST_ONLY_SECRET: 'host-only-canary', INK_OS_APP_ORIGIN_TEMPLATE: 'http://__RELEASE__.apps.ink.localhost:' + port });
  const url = 'http://127.0.0.1:' + port;
  let child, output = '', instanceId;
  async function stop({ abrupt = false } = {}) { if (child && child.exitCode === null && child.signalCode === null) { child.kill(abrupt ? 'SIGKILL' : 'SIGTERM'); await once(child, 'exit'); } }
  t.after(async () => {
    await stop();
    if (instanceId) {
      const containers = await engine.request('/containers/json?all=1&filters=' + encodeURIComponent(JSON.stringify({ label: ['ink.os.instance=' + instanceId] })));
      for (const container of containers) {
        const info = await engine.request('/containers/' + container.Id + '/json');
        assert.equal(info.State.Running, false, 'Validation leaves no live worker to clean up');
        await engine.request('/containers/' + container.Id, { method: 'DELETE' });
      }
      const networks = await engine.request('/networks?filters=' + encodeURIComponent(JSON.stringify({ label: ['ink.os.instance=' + instanceId] })));
      for (const network of networks) await engine.request('/networks/' + network.Id, { method: 'DELETE' });
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
      try { const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) }); const health = await response.json(); if (response.ok) { instanceId = health.instanceId; return; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(output);
  }
  await start();
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG, 'utf8')), sdk = createClient({ url, token: config.token });
  assert.deepEqual(await sdk.apps.list(), []);
  const encode = (path, text) => ({ path, base64: Buffer.from(text).toString('base64') });
  const module = await readFile(new URL('./fixtures/module-backend.mjs', import.meta.url), 'utf8');
  async function install(slug, backend) {
    const app = await sdk.apps.create({ slug, title: slug });
    const release = await sdk.request('apps/' + app.id + '/releases', { method: 'POST', body: { entry: 'index.html', files: [encode('index.html', '<p>' + slug + '</p>'), encode('server/main.mjs', module)], backend, desktop: { entry: 'app', icon: 'code' } } });
    await sdk.apps.publish(app.id, release.id);
    return { app, release };
  }
  const invoke = (app, path, method = 'GET') => sdk.request('apps/' + app.id + '/invoke', { method: 'POST', body: { path, method } });
  const runtimes = () => sdk.runtimes.list();
  const first = await install('module-first', { entry: 'server/main.mjs', idleSafe: true });
  await sdk.apps.env.set(first.app.id, { SAMPLE_SETTING: 'first-app-only' });
  const cli = JSON.parse((await execute(process.execPath, ['cli/bin/ink-os.mjs', 'invoke', first.app.id, '/count', '--method', 'POST'], { env })).stdout);
  assert.equal(cli.body.value.count, 1);
  assert.deepEqual((await invoke(first.app, '/inspect')).body, { setting: 'first-app-only', hostSecret: null, marker: false });
  const initial = (await runtimes()).slots.find(slot => slot.appId === first.app.id), savedPool = JSON.parse(await readFile(join(directory, 'runtime-pool.json')));
  const firstDeployment = savedPool.slots.find(slot => slot.id === initial.slotId).deployment;
  const initialContainer = await engine.request('/containers/' + firstDeployment.containerId + '/json');
  const oldToken = initialContainer.Config.Env.find(value => value.startsWith('INK_OS_APP_TOKEN=')).slice('INK_OS_APP_TOKEN='.length);
  assert.equal(initialContainer.HostConfig.ReadonlyRootfs, true);
  assert.equal(initialContainer.HostConfig.Init, true);
  assert.deepEqual(initialContainer.HostConfig.CapDrop, ['ALL']);
  assert.equal(initialContainer.Mounts.some(mount => mount.Source?.endsWith('docker.sock')), false);
  assert.equal((await invoke(first.app, '/work', 'POST')).body.started, true);
  assert.equal((await runtimes()).slots.find(slot => slot.slotId === initial.slotId).holds.length, 1);
  // Crash only the owned host process. Its separate held worker must survive
  // and rejoin the new host; graceful shutdown instead drains accepted work.
  await stop({ abrupt: true });
  assert.equal((await engine.request('/containers/' + firstDeployment.containerId + '/json')).State.Running, true);
  await start();
  const resumed = (await runtimes()).slots.find(slot => slot.slotId === initial.slotId);
  assert.equal(resumed.leaseId, initial.leaseId);
  let completed = false;
  for (let attempt = 0; attempt < 60; attempt++) { const result = (await invoke(first.app, '/done')).body; assert.equal(result.backgroundError, undefined, JSON.stringify(result.backgroundError)); if (result.value?.done) { completed = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(completed, true);
  const launch = await sdk.request('apps/' + first.app.id + '/launch', { method: 'POST', body: {} });
  const appHost = new URL(launch.origin).host;
  const opened = await proofHTTP(url, new URL(launch.url).pathname + new URL(launch.url).search, { host: appHost });
  assert.equal(opened.status, 302);
  const cookie = opened.headers.get('set-cookie').split(';')[0];
  assert.equal((await proofHTTP(url, '/server/main.mjs', { host: appHost, headers: { Cookie: cookie } })).status, 404);
  const backend = await proofHTTP(url, '/backend/count', { host: appHost, headers: { Cookie: cookie } });
  assert.equal((await backend.json()).value.count, 1);
  await new Promise(resolve => setTimeout(resolve, 2400));
  await sdk.runtimes.reap();
  assert.equal((await runtimes()).slots.find(slot => slot.slotId === initial.slotId).status, 'idle');
  const second = await install('module-second', { entry: 'server/main.mjs', idleSafe: true });
  assert.deepEqual((await invoke(second.app, '/inspect')).body, { setting: null, hostSecret: null, marker: false });
  const reused = (await runtimes()).slots.find(slot => slot.appId === second.app.id);
  assert.equal(reused.slotId, initial.slotId);
  assert.notEqual(reused.leaseId, initial.leaseId);
  assert.equal(await engine.request('/containers/' + firstDeployment.containerId + '/json', { missing: true }), null);
  assert.equal((await fetch(url + '/api/v1/runtime/bundle/' + second.release.id, { headers: { Authorization: 'Bearer ' + oldToken } })).status, 401);
  const service = await sdk.request('apps/' + first.app.id + '/token', { method: 'POST', body: {} });
  assert.equal((await fetch(url + '/api/v1/runtime/bundle/' + second.release.id, { headers: { Authorization: 'Bearer ' + service.token } })).status, 403);
  const oci = await install('oci-proof', { image: 'ink-os-oci-proof:local', port: 9000, idleSafe: true });
  await sdk.apps.env.set(oci.app.id, { SAMPLE_SETTING: 'oci-only' });
  assert.deepEqual((await invoke(oci.app, '/example')).body, { kind: 'oci', setting: 'oci-only', hostSecret: null, path: '/example' });
  await new Promise(resolve => setTimeout(resolve, 2400));
  await sdk.runtimes.reap();
  assert.ok((await runtimes()).slots.every(slot => slot.status === 'idle'));
  const accountKey = await sdk.account.keys.create({ name: 'Docker continuation proof', scopes: ['world:read', 'world:write'], expiresInDays: 1 });
  await sdk.apps.env.set(second.app.id, { PROOF_ACCOUNT_TOKEN: accountKey.token });
  assert.equal((await invoke(second.app, '/account-work', 'POST')).body.started, true);
  const backupOperation = 'a'.repeat(32), backupJob = await sdk.backups.create({ operation: backupOperation, password: 'Disposable Docker backup proof password', timeoutMs: 30000 });
  assert.ok(['queued', 'running'].includes(backupJob.status));
  let saved;
  for (let attempt = 0; attempt < 300; attempt++) { saved = await sdk.backups.get(backupOperation); if (!['queued', 'running'].includes(saved.status)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(saved.status, 'ready', JSON.stringify(saved));
  const encrypted = await sdk.backups.download(backupOperation), archiveParts=[]; let captured = 0; for await (const chunk of encrypted.chunks) {captured += chunk.length;assert.ok(captured<=16*1024*1024);archiveParts.push(chunk);} assert.equal(captured, saved.bytes);
  const archive=join(directory,'captured.inkbak');await writeFile(archive,Buffer.concat(archiveParts),{mode:0o600});
  await sdk.backups.delete(backupOperation);
  assert.equal((await invoke(second.app, '/account-work', 'POST')).body.started, true);
  const held = (await runtimes()).slots.find(slot => slot.appId === second.app.id);
  assert.equal(held.holds.length, 1);
  const deployment = JSON.parse(await readFile(join(directory, 'runtime-pool.json'))).slots.find(slot => slot.id === held.slotId).deployment;
  await stop();
  assert.equal((await engine.request('/containers/' + deployment.containerId + '/json')).State.Running, false);
  await start();
  const result = await sdk.state.get('continuation-proof', second.app.id);
  assert.equal(result.value?.done, true, JSON.stringify(result));
  assert.equal((await sdk.data.get(result.value.objectId)).title, 'Admitted account continuation');
  await sdk.account.keys.revoke(accountKey.id);
  await stop();
  const restored=join(directory,'restored');await recoverBackup({directory:restored,archive,password:'Disposable Docker backup proof password',offline:true,storage:'local',runtime:'local'});
  env.INK_OS_DATA_DIR=restored;env.INK_OS_CONFIG=join(restored,'client.json');await start();
  assert.equal((await invoke(first.app,'/count')).body.value.count,1);
  assert.equal((await invoke(first.app,'/count','POST')).body.value.count,2);
  assert.equal((await fetch(url+'/api/v1/runtime/bundle/'+first.release.id,{headers:{Authorization:'Bearer '+oldToken}})).status,401);
});
