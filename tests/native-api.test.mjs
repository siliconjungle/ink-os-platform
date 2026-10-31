import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../sdk/src/server.js';

const execute = promisify(execFile);
test('native jobs survive a graceful host stop and share exact persistent app state with JavaScript through API, SDK and CLI', { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-native-api-')), data = join(directory, 'data'), source = join(directory, 'source');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DATA_DIR: data, NODE_ENV: 'production', INK_OS_CONFIG: join(data, 'client.json'), ...(process.env.INK_NATIVE_OFFLINE === '1' ? { INK_NATIVE_OFFLINE: '1' } : {}) });
  let child, output = '';
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  async function start() {
    output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
      try { if ((await fetch(url + '/api/health')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(output);
  }
  const cli = async (...args) => JSON.parse((await execute(process.execPath, ['cli/bin/ink-os.mjs', ...args], { env, maxBuffer: 4 * 1024 * 1024 })).stdout);
  await start();
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG, 'utf8')), sdk = createClient({ url, token: config.token });
  assert.equal((await sdk.native.status()).available, true);
  assert.deepEqual(await sdk.apps.list(), []);
  await cli('init', source, '--slug', 'native-proof');
  const deployment = await cli('deploy', source), appId = deployment.appId;
  assert.equal((await sdk.apps.ink.run(appId, 'add', '[2]', { backend: 'javascript' })).valueWire, '2');
  await assert.rejects(sdk.apps.ink.run(appId, 'total', '[]', { backend: 'native' }), { status: 409 });
  const building = await cli('native', 'build', appId, '--wait', '--timeout', '1');
  assert.ok(['queued', 'running', 'succeeded'].includes(building.status));
  if (building.status !== 'succeeded') assert.equal(building.observationTimedOut, true);
  await stop();
  assert.equal(child.exitCode, 0, output);
  const stored = JSON.parse(await readFile(join(data, 'native-jobs.json'), 'utf8')).jobs.find(job => job.id === building.id);
  assert.equal(stored.status, 'succeeded', JSON.stringify(stored) + output);
  env.INK_NATIVE_CARGO = 'ink-native-unavailable-cargo'; env.INK_NATIVE_RUSTC = 'ink-native-unavailable-rustc';
  await start();
  assert.equal((await sdk.native.status()).available, false);
  assert.equal((await sdk.apps.native.get(appId, building.id)).status, 'succeeded');
  assert.equal((await sdk.apps.native.build(appId)).id, building.id);
  const native = await sdk.apps.ink.run(appId, 'add', '[3]', { backend: 'native' });
  assert.equal(native.backend, 'native'); assert.equal(native.valueWire, '5');
  const javascript = await sdk.apps.ink.run(appId, 'add', '[4]', { backend: 'javascript' });
  assert.equal(javascript.backend, 'javascript'); assert.equal(javascript.valueWire, '9');
  const automatic = await sdk.apps.ink.run(appId, 'total');
  assert.equal(automatic.backend, 'native'); assert.equal(automatic.valueWire, '9');
  assert.equal((await cli('ink', 'run', appId, 'total', '--backend', 'native')).valueWire, '9');
  assert.equal((await cli('native', 'jobs', appId))[0].id, building.id);
  const copy = await sdk.apps.duplicate(appId);
  assert.equal((await sdk.apps.ink.run(copy.id, 'total')).backend, 'javascript');
  assert.equal((await sdk.apps.ink.run(copy.id, 'total')).valueWire, '9');
  await assert.rejects(sdk.apps.native.get(copy.id, building.id), { status: 404 });
});
