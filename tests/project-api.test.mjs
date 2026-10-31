import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '../sdk/src/server.js';

test('project API/SDK/CLI keep credentials private across restart and enforce scoped access', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-project-api-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DATA_DIR: directory, INK_OS_CONFIG: join(directory, 'client.json'), NODE_ENV: 'production', INK_OS_NATIVE: '0', INK_OS_INSTANCE_ID: randomBytes(16).toString('hex'), INK_OS_ADMIN_TOKEN: randomBytes(32).toString('base64url'), INK_OS_ENV_KEY: randomBytes(32).toString('base64') });
  let child, output = '';
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + port;
  async function start() {
    output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
      try { const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(output);
  }
  async function cli(args, stdin = '') {
    const process = spawn(globalThis.process.execPath, ['cli/bin/ink-os.mjs', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.on('data', bytes => stdout += bytes); process.stderr.on('data', bytes => stderr += bytes);
    process.stdin.end(stdin);
    const [code] = await once(process, 'exit');
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  }
  await start();
  assert.equal((await (await fetch(url + '/api/health')).json()).instanceId, env.INK_OS_INSTANCE_ID);
  const identity = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'));
  assert.equal(identity.adminToken, env.INK_OS_ADMIN_TOKEN);
  assert.equal(identity.environmentKey, env.INK_OS_ENV_KEY);
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG, 'utf8')), sdk = createClient({ url, token: config.token });
  assert.deepEqual(await sdk.apps.list(), []);
  const project = await sdk.projects.import({ title: 'Source', files: [{ path: 'main.ink', base64: Buffer.from('module source;').toString('base64') }], settings: { source: { provider: 'github', github: { owner: 'example-team', repository: 'source', visibility: 'private' } } } });
  const secret = randomBytes(32).toString('base64url');
  const status = await cli(['projects', 'credentials', project.id, '--stdin'], secret + '\n');
  assert.equal(status.matchesProject, true);
  assert.ok(!JSON.stringify(status).includes(secret));
  const limitedKey = await sdk.account.keys.create({ name: 'Source access', scopes: ['apps:read', 'apps:deploy'], expiresInDays: 1 });
  const limited = createClient({ url, token: limitedKey.token });
  assert.equal((await limited.projects.list()).length, 1);
  await assert.rejects(limited.projects.credentials.status(project.id), { status: 403 });
  await assert.rejects(limited.projects.credentials.set(project.id, secret), { status: 403 });
  await assert.rejects(limited.projects.credentials.remove(project.id), { status: 403 });
  const copy = await sdk.projects.duplicate(project.id);
  assert.equal(copy.source.provider, 'local');
  assert.equal((await sdk.projects.credentials.status(copy.id)).configured, false);
  assert.ok(!JSON.stringify(await sdk.projects.get(project.id)).includes(secret));
  assert.ok(!JSON.stringify(await sdk.data.query({})).includes(secret));
  await stop(); await start();
  assert.equal((await sdk.projects.credentials.status(project.id)).matchesProject, true);
  assert.equal((await cli(['projects', 'publication', project.id])).publication, null);
  assert.deepEqual(await sdk.apps.list(), []);
  assert.deepEqual(await cli(['projects', 'credentials', project.id, '--clear']), { configured: false });
  assert.equal((await sdk.projects.credentials.status(project.id)).configured, false);
});
