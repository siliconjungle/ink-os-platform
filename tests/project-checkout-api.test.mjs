import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '../sdk/src/server.js';
import { Projects } from '../server/projects.mjs';

const execute = promisify(execFile);
const file = (path, bytes, mode = '100644') => ({ path, mode, base64: Buffer.from(bytes).toString('base64') });
test('actual API/SDK/CLI checked-out source edits deploy safely; stale conversations and concurrent CAS writes preserve the winner', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ink-checkout-api-')), data = join(root, 'data');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR: data, INK_OS_CONFIG: join(data, 'client.json'), NODE_ENV: 'production', INK_OS_NATIVE: '0' });
  const child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(root, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + port; let ready = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
    try { if ((await fetch(url + '/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 30));
  }
  assert.ok(ready, output);
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG)), sdk = createClient({ url, token: config.token });
  const cli = async (...args) => JSON.parse((await execute(process.execPath, ['cli/bin/ink-os.mjs', ...args], { env, maxBuffer: 4 * 1024 * 1024 })).stdout);
  const manifest = { slug: 'managed-checkout-fixture', title: 'Managed checkout fixture', directory: 'web', entry: 'index.html', desktop: { entry: 'app', icon: 'code' } };
  const initialFiles = [file('ink-app.json', JSON.stringify(manifest)), file('web/index.html', '<p>Original managed source</p>\r\n'), file('run.sh', '#!/bin/sh\ntrue\n', '100755'), file('data.bin', [0, 255, 13, 10]), file('.gitattributes', '* text eol=lf\n')];
  const project = await sdk.projects.import({ title: 'Managed source', files: initialFiles, originCommit: 'a'.repeat(40) });
  const app = await sdk.apps.create({ ...manifest, projectId: project.id, sourceCommit: project.commit });
  const a = join(root, 'conversation-a'), b = join(root, 'conversation-b');
  const checkoutA = await cli('projects', 'checkout', project.id, '--directory', a), checkoutB = await cli('projects', 'export', project.id, '--directory', b);
  assert.equal(checkoutA.tree, (await sdk.projects.status(project.id)).tree); assert.equal(checkoutB.commit, project.commit);
  assert.deepEqual(await readFile(join(a, 'data.bin')), Buffer.from([0, 255, 13, 10]));
  if (process.platform !== 'win32') assert.equal((await stat(join(a, 'run.sh'))).mode & 0o777, 0o755);
  const local = new Projects(root);
  const edit = async (directory, text) => {
    await writeFile(join(directory, 'web/index.html'), text);
    await local.git(directory, ['add', 'web/index.html']);
    await local.git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Edit checked-out source']);
  };
  await edit(a, '<p>Conversation A changed source</p>\r\n');
  const deployed = await cli('deploy', a, '--app', app.id, '--preview-only');
  const current = await sdk.projects.get(project.id), status = await sdk.apps.status(app.id);
  assert.notEqual(current.commit, project.commit); assert.equal(status.releases.length, 1);
  assert.equal(JSON.parse(status.releases[0].body).source.commit, current.commit);
  assert.equal(JSON.parse(status.app.body).projectId, project.id);
  assert.equal(JSON.parse(await readFile(join(a, '.git/ink-os-project.json'))).baseCommit, current.commit);
  // A second unchanged deployment remains usable and reuses the same release.
  assert.equal((await cli('deploy', a, '--app', app.id, '--preview-only')).releaseId, deployed.releaseId);
  await edit(b, '<p>Stale conversation B must not replace A</p>');
  await assert.rejects(cli('deploy', b, '--app', app.id), /changed since this checkout/);
  assert.equal((await sdk.projects.get(project.id)).commit, current.commit);
  assert.equal((await sdk.apps.status(app.id)).releases.length, 1);
  assert.equal(JSON.parse(await readFile(join(b, '.git/ink-os-project.json'))).baseCommit, project.commit);
  await assert.rejects(cli('projects', 'checkout', project.id, '--directory', a), /EEXIST/);
  assert.equal(await readFile(join(a, 'web/index.html'), 'utf8'), '<p>Conversation A changed source</p>\r\n');
  const currentFiles = await sdk.projects.files(project.id);
  const races = await Promise.allSettled(['first race', 'second race'].map(text => sdk.projects.snapshot(project.id, { files: currentFiles.map(f => f.path === 'web/index.html' ? file(f.path, text) : f) }, { expectedCommit: current.commit })));
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(races.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1);
  const winner = races.find(r => r.status === 'fulfilled').value;
  assert.equal((await sdk.projects.status(project.id)).commit, winner.commit);
  await assert.rejects(sdk.projects.snapshot(project.id, { files: currentFiles, expectedCommit: current.commit }), { status: 409 });
  assert.throws(() => sdk.projects.snapshot(project.id, { files: currentFiles, expectedCommit: current.commit }, { expectedCommit: winner.commit }), /Conflicting/);
  // The optional field preserves older API callers.
  assert.equal((await sdk.projects.snapshot(project.id, { files: await sdk.projects.files(project.id) })).commit, winner.commit);
});
