import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../sdk/src/server.js';
import { Projects } from '../server/projects.mjs';

const execute = promisify(execFile);
test('fresh HTTP host deploys a committed multi-module app with actual CLI, denies helpers and migrates exact state across restart', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-module-api-')), data = join(directory, 'data'), source = join(directory, 'source');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR: data, NODE_ENV: 'production', INK_OS_CONFIG: join(data, 'client.json'), INK_OS_NATIVE: '0' });
  let child, output = '';
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  async function start() {
    output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
      try { if ((await fetch(url + '/api/health')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(output);
  }
  const cli = async (...args) => JSON.parse((await execute(process.execPath, ['cli/bin/ink-os.mjs', ...args], { env, maxBuffer: 4 * 1024 * 1024 })).stdout);
  await start();
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG, 'utf8')), sdk = createClient({ url, token: config.token });
  assert.deepEqual(await sdk.apps.list(), []);
  await cli('init', source, '--slug', 'module-http-proof');
  const manifest = JSON.parse(await readFile(join(source, 'ink-app.json'), 'utf8'));
  delete manifest.ui;
  manifest.modules = { version: 1, root: 'main.ink', modules: [
    { path: 'main.ink', name: 'counter', dependencies: ['lib/math.ink'], exports: ['add', 'total'] },
    { path: 'lib/math.ink', name: 'library', dependencies: [], exports: ['bump'] },
  ] };
  await mkdir(join(source, 'lib'));
  await writeFile(join(source, 'main.ink'), 'module counter;state Total:u64=0;change add(n:u64)->u64 reads(Total) writes(Total){Total=Total+bump(n);return Total;}query total()->u64 reads(Total){return Total;}fn root_secret()->u64{return 4;}');
  await writeFile(join(source, 'lib/math.ink'), 'module library;fn bump(n:u64)->u64{return n+1;}fn secret()->u64{return 99;}');
  await writeFile(join(source, 'ink-app.json'), JSON.stringify(manifest));
  const git = new Projects(source);
  const commit = async message => {
    await git.git(source, ['add', '--', 'main.ink', 'lib/math.ink', 'ink-app.json']);
    await git.git(source, ['-c', 'user.name=Ink graph test', '-c', 'user.email=ink@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + join(source, '.git/no-hooks'), 'commit', '-m', message]);
  };
  await commit('Explicit checked module graph');
  const build = await cli('build', source); assert.deepEqual(build.commands, ['ink.add', 'ink.total']);
  const bundle = JSON.parse(await readFile(build.output, 'utf8'));
  assert.equal(bundle.files.filter(file => file.path.endsWith('.ink')).length, 2);
  const builtMetadata = JSON.parse(Buffer.from(bundle.files.find(file => file.path === 'app.json').base64, 'base64'));
  assert.deepEqual(builtMetadata.entries.map(entry => entry.name), ['add', 'total']);
  const first = await cli('deploy', source), appId = first.appId;
  const described = await sdk.apps.ink.describe(appId);
  assert.deepEqual(described.entries.map(entry => entry.name), ['add', 'total']);
  assert.equal(described.spec.modules.modules.length, 2);
  assert.equal(described.sourceIdentity.identity, builtMetadata.moduleGraph.identity);
  const max = '18446744073709551615';
  assert.equal((await sdk.apps.ink.run(appId, 'add', '[18446744073709551614]', { backend: 'javascript' })).valueWire, max);
  assert.equal((await sdk.commands.run(appId, 'ink.total', {})).data.valueWire, max);
  for (const entry of ['secret', 'bump', 'root_secret']) {
    await assert.rejects(sdk.apps.ink.run(appId, entry), { status: 403 });
    await assert.rejects(sdk.request('apps/' + appId + '/code/run', { method: 'POST', body: { entry } }), { status: 403 });
  }
  const checkpoint = await sdk.apps.ink.checkpoint(appId);
  assert.deepEqual(checkpoint.sourceIdentity, described.sourceIdentity);
  const project = await sdk.projects.get(first.projectId);
  assert.equal(project.originCommit, await git.git(source, ['rev-parse', 'HEAD']));
  await stop(); await start();
  assert.equal((await sdk.apps.ink.run(appId, 'total', '[]', { backend: 'javascript' })).valueWire, max);
  assert.deepEqual(await sdk.apps.ink.checkpoint(appId), checkpoint);
  await writeFile(join(source, 'main.ink'), 'module counter;state Current:u64=0;change initialize(n:u64)->u64 writes(Current){Current=n;return Current;}query current()->u64 reads(Current){return Current;}fn root_secret()->u64{return 4;}');
  manifest.exports = ['initialize', 'current']; manifest.modules.modules[0].exports = [...manifest.exports];
  await writeFile(join(source, 'ink-app.json'), JSON.stringify(manifest)); await commit('Explicit new state initializer');
  const next = await cli('deploy', source); assert.notEqual(next.releaseId, first.releaseId);
  await assert.rejects(sdk.apps.ink.run(appId, 'current'), { status: 409 });
  const stale = await sdk.apps.ink.checkpoint(appId);
  assert.equal(stale.checkpointRevision, checkpoint.checkpointRevision); assert.deepEqual(stale.sourceIdentity, checkpoint.sourceIdentity);
  const result = await sdk.apps.ink.migrate(appId, { fromReleaseId: first.releaseId, toReleaseId: next.releaseId, query: 'total', change: 'initialize', expectedAppRevision: stale.appRevision, expectedCheckpointRevision: stale.checkpointRevision });
  assert.equal(result.exportValueWire, max); assert.equal(result.valueWire, max);
  assert.notEqual(result.sourceIdentity.identity, checkpoint.sourceIdentity.identity);
  await stop(); await start();
  assert.equal((await sdk.apps.ink.run(appId, 'current', '[]', { backend: 'javascript' })).valueWire, max);
  assert.deepEqual((await sdk.apps.ink.checkpoint(appId)).sourceIdentity, result.sourceIdentity);
});
