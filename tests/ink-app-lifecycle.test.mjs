import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../sdk/src/server.js';
import { Projects } from '../server/projects.mjs';

const execute = promisify(execFile);
test('an empty OS installs Ink source from local Git, runs exact commands and workflows, forks state, and recovers after restart', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-app-lifecycle-')), data = join(directory, 'data'), source = join(directory, 'source');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DATA_DIR: data, NODE_ENV: 'production', INK_OS_CONFIG: join(data, 'client.json') });
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
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG, 'utf8'));
  const sdk = createClient({ url, token: config.token });
  assert.deepEqual(await sdk.apps.list(), []);
  await cli('init', source, '--slug', 'local-ink');
  const manifest = JSON.parse(await readFile(join(source, 'ink-app.json'), 'utf8'));
  manifest.exports.push('echo'); await writeFile(join(source, 'ink-app.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'main.ink'), (await readFile(join(source, 'main.ink'), 'utf8')) + '\nfn echo(value:u64)->u64{return value;}\n');
  const git = new Projects(source);
  await git.git(source, ['add', '.']);
  await git.git(source, ['-c', 'user.name=Ink test', '-c', 'user.email=ink@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Add exact command']);
  const build = await cli('build', source);
  assert.deepEqual(build.commands, ['ink.add', 'ink.total', 'ink.echo']);
  const deployment = await cli('deploy', source), appId = deployment.appId;
  assert.equal((await sdk.apps.list()).length, 1);
  assert.equal((await sdk.projects.get(deployment.projectId)).source.provider, 'local');
  assert.equal((await sdk.apps.ink.describe(appId)).spec.view, 'view');
  const command = await sdk.commands.get(appId, 'ink.add');
  assert.equal(command.effect, 'write');
  assert.equal(command.inputs[0].type, 'json');
  const commands = (await sdk.commands.query({ appId })).commands.filter(command => command.handler.type === 'ink');
  const forged = commands.map(command => ({ ...command, effect: 'read' }));
  await assert.rejects(sdk.request('apps/' + appId, { method: 'PATCH', body: { commands: forged } }), { status: 400 });
  await assert.rejects(sdk.apps.ink.run(appId, 'missing'), { status: 403 });
  assert.equal((await sdk.commands.run(appId, 'ink.add', { arg0: '7' })).data.valueWire, '7');
  assert.equal((await sdk.commands.run(appId, 'ink.echo', { arg0: '18446744073709551615' })).data.valueWire, '18446744073709551615');
  assert.equal((await sdk.apps.ink.run(appId, 'view')).value.children[1].value, 7);
  const workflow = await sdk.workflows.save({ title: 'Exact command chain', inputs: [], steps: [
    { id: 'first', appId, commandId: 'ink.echo', bindings: { arg0: { source: 'literal', value: '18446744073709551615' } } },
    { id: 'second', appId, commandId: 'ink.echo', bindings: { arg0: { source: 'step', stepId: 'first', path: 'valueWire' } } },
  ] });
  const preview = await sdk.workflows.preview(workflow.id);
  const run = await sdk.workflows.run(workflow.id, {}, { fingerprint: preview.fingerprint });
  let finished;
  for (let attempt = 0; attempt < 100; attempt++) {
    finished = await sdk.workflows.runs({ runId: run.id });
    if (['failed', 'succeeded'].includes(finished.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(finished?.status, 'succeeded', JSON.stringify(finished));
  assert.equal(finished.steps[1].output.valueWire, '18446744073709551615');
  const copy = await sdk.apps.duplicate(appId);
  assert.notEqual(JSON.parse(copy.body).projectId, deployment.projectId);
  assert.equal((await sdk.apps.ink.run(copy.id, 'total')).valueWire, '7');
  await sdk.apps.ink.run(copy.id, 'add', '[3]');
  assert.equal((await sdk.apps.ink.run(appId, 'total')).valueWire, '7');
  assert.equal((await sdk.apps.ink.run(copy.id, 'total')).valueWire, '10');
  await stop(); await start();
  assert.equal((await sdk.apps.ink.run(appId, 'total')).valueWire, '7');
  assert.equal((await sdk.apps.ink.run(copy.id, 'total')).valueWire, '10');
  const repeated = await cli('deploy', source);
  assert.equal(repeated.appId, appId);
  assert.equal((await sdk.apps.ink.run(appId, 'total')).valueWire, '7');
  const priorRelease = repeated.releaseId;
  await writeFile(join(source, 'main.ink'), (await readFile(join(source, 'main.ink'), 'utf8')) + '\nfn extra()->u32{return 1;}\nchange migrate_count(value:u32)->u32 writes(Count){Count=value;return Count;}\n');
  manifest.exports.push('migrate_count'); await writeFile(join(source, 'ink-app.json'), JSON.stringify(manifest));
  await git.git(source, ['add', '.']);
  await git.git(source, ['-c', 'user.name=Ink test', '-c', 'user.email=ink@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Change source identity']);
  const changed = await cli('deploy', source);
  assert.notEqual(changed.releaseId, priorRelease);
  await assert.rejects(sdk.apps.ink.run(appId, 'total'), { status: 409 });
  await assert.rejects(sdk.apps.ink.run(appId, 'total', '[]', { releaseId: priorRelease }), { status: 409 });
  await sdk.apps.publish(appId, priorRelease);
  assert.equal((await sdk.apps.ink.run(appId, 'total')).valueWire, '7');
  await sdk.apps.publish(appId, changed.releaseId);
  const checkpoint = await sdk.apps.ink.checkpoint(appId);
  assert.equal(checkpoint.releaseId, changed.releaseId);
  const migration = { fromReleaseId: priorRelease, toReleaseId: changed.releaseId, query: 'total', change: 'migrate_count', expectedAppRevision: checkpoint.appRevision, expectedCheckpointRevision: checkpoint.checkpointRevision };
  await assert.rejects(sdk.apps.ink.migrate(appId, { ...migration, expectedAppRevision: checkpoint.appRevision - 1 }), { status: 409 });
  const migrationFile = join(directory, 'migration.json'); await writeFile(migrationFile, JSON.stringify(migration));
  const migrated = await cli('ink', 'migrate', appId, '--file', migrationFile);
  assert.equal(migrated.exportValueWire, '7');
  assert.equal(migrated.valueWire, '7');
  assert.equal((await cli('ink', 'checkpoint', appId)).checkpointRevision, migrated.revision);
  assert.equal((await sdk.apps.ink.run(appId, 'total')).valueWire, '7');
  await stop(); await start();
  assert.equal((await sdk.apps.ink.run(appId, 'total')).valueWire, '7');
});
