import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, readdir, rm, lstat, chmod, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { initializeInstance } from '../server/instance.mjs';
import { Projects } from '../server/projects.mjs';
import { AppEnvironment } from '../server/app-environment.mjs';
import { World } from '../server/world.mjs';
import { createBackup } from '../server/backup-store.mjs';
import { assertOfflineInstance, createStoppedBackup, recoverBackup } from '../server/backup-recovery.mjs';
import { backupCLI } from '../cli/bin/backup.mjs';
import { Readable } from 'node:stream';

const password = 'disposable recovery integration password';
const hostStops = new WeakMap();
const refused = async () => { throw Object.assign(Error('refused'), { cause: { code: 'ECONNREFUSED' } }); };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-recovery-test-')));
  if (!hostStops.has(t)) hostStops.set(t, []);
  t.after(async () => { for (const stop of hostStops.get(t)) await stop(); await rm(root, { recursive: true, force: true }); });
  const source = join(root, 'original'), archive = join(root, 'private.backup'), target = join(root, 'relocated');
  const identity = await initializeInstance({ directory: source });
  const projects = await new Projects(source, { environmentKey: identity.environmentKey }).open();
  const files = [
    { path: 'main.ink', mode: '100644', base64: Buffer.from('module recovery;\r\n').toString('base64') },
    { path: 'bytes.bin', mode: '100644', base64: Buffer.from([0, 255, 13, 10, 128]).toString('base64') },
    { path: 'scripts/run', mode: '100755', base64: Buffer.from('#!/bin/sh\nprintf fixture\n').toString('base64') },
  ];
  const project = await projects.snapshot({ title: 'Recovery source', files, settings: { source: { provider: 'github', github: { owner: 'fixture', repository: 'private-source' } } } });
  return { root, source, archive, target, identity, projects, project, files };
}
async function clean(root) { assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.ink-recovery-') || name.startsWith('.ink-restore-')), []); }
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }

async function host(t, directory) {
  const hostPort = await port(), url = 'http://127.0.0.1:' + hostPort;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
  Object.assign(env, { PORT: String(hostPort), INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR: directory, INK_OS_NATIVE: '0', NODE_ENV: 'production' });
  const child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = '', stopped = false;
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const stop = async () => { if (stopped) return; stopped = true; if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); const [code, signal] = await exited; assert.equal(code, 0, output); assert.equal(signal, null); };
  hostStops.get(t).push(stop); t.after(stop);
  for (let n = 0; n < 150; n++) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
    try { const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(500) }); const health = await response.json(); if (response.ok) return { url, health, stop }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('Disposable restored host failed to start: ' + output);
}

test('relocation recovers real Projects/files/status, commit/tree, app bytes and encrypted credentials across actual host restarts', { timeout: 30000 }, async t => {
  const { root, source, archive, target, identity, projects, project, files } = await fixture(t);
  const secret = randomBytes(32).toString('base64url'); await projects.setCredentials(project.id, secret);
  const environment = await new AppEnvironment(source, identity.environmentKey).open(); await environment.mutate('fixture-app', { RECOVERED_SECRET: secret });
  const credentialBytes = await readFile(join(source, 'project-credentials.json')), environmentBytes = await readFile(join(source, 'app-environment.json'));
  const world = await new World(source).open(); await world.persist();
  const appBytes = randomBytes(73); await mkdir(join(source, 'app-checkpoints')); await writeFile(join(source, 'app-checkpoints', 'fixture'), appBytes);
  await writeFile(join(project.directory, 'draft.txt'), 'uncommitted user work');
  const committedFiles = await projects.files(project.id);
  const status = await projects.status(project.id), tree = await projects.git(project.directory, ['rev-parse', 'HEAD^{tree}']);
  const external = join(root, 'external-project'); await mkdir(external); const externalProject = await projects.create({ title: 'External source', directory: external });
  await writeFile(join(external, 'keep.txt'), 'external data untouched');
  await createStoppedBackup({ directory: source, archive, password, offline: true, fetcher: refused });
  await rm(source, { recursive: true }); // Recovery cannot accidentally read the original managed checkout.
  const result = await recoverBackup({ directory: target, archive, password, offline: true, fetcher: refused });
  assert.deepEqual(result.recovery.rebasedProjects, [project.id]); assert.deepEqual(result.recovery.rebasedHooks, [project.id]);
  assert.deepEqual(result.recovery.externalProjects, [externalProject.id]); assert.equal(result.coverage.externalProjects, false);
  await assert.rejects(lstat(join(target, 'client.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(target, 'project-credentials.json')), credentialBytes); assert.deepEqual(await readFile(join(target, 'app-environment.json')), environmentBytes);
  assert.deepEqual(await readFile(join(target, 'app-checkpoints', 'fixture')), appBytes);
  const restarted = await initializeInstance({ directory: target, port: await port() });
  assert.equal(restarted.id, identity.id); assert.equal(restarted.environmentKey, identity.environmentKey); assert.equal(restarted.adminToken, identity.adminToken);
  const relocated = await new Projects(target, { environmentKey: restarted.environmentKey }).open();
  assert.equal(relocated.get(project.id).directory, join(target, 'projects', project.id));
  assert.equal(relocated.get(externalProject.id).directory, external);
  assert.equal((await relocated.status(project.id)).commit, status.commit); assert.equal((await relocated.status(project.id)).changes, status.changes);
  assert.equal(await relocated.git(relocated.get(project.id).directory, ['rev-parse', 'HEAD^{tree}']), tree);
  assert.deepEqual(await relocated.files(project.id), committedFiles);
  assert.equal(await relocated.git(relocated.get(project.id).directory, ['config', '--get', 'core.hooksPath']), join(target, 'projects', '.hooks'));
  assert.equal(relocated.credentials.token(relocated.get(project.id)), secret);
  assert.deepEqual((await new AppEnvironment(target, restarted.environmentKey).open()).values('fixture-app'), { RECOVERED_SECRET: secret });
  assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'external data untouched');
  assert.equal((await lstat(join(target, 'projects', project.id, 'scripts/run'))).mode & 0o777, 0o755);
  for (let n = 0; n < 2; n++) {
    const running = await host(t, target); assert.equal(running.health.instanceId, identity.id);
    const client = JSON.parse(await readFile(join(target, 'client.json'))); assert.equal(client.token, identity.adminToken); assert.equal(client.url, running.url); assert.equal(client.instanceId, identity.id);
    const response = await fetch(running.url + '/api/v1/projects/' + project.id + '/status', { headers: { authorization: 'Bearer ' + identity.adminToken } });
    assert.equal(response.status, 200); const remote = await response.json(); assert.equal(remote.project.directory, relocated.get(project.id).directory); assert.equal(remote.commit, status.commit);
    await running.stop();
    assert.equal((await new Projects(target, { environmentKey: identity.environmentKey }).open()).credentials.token(relocated.get(project.id)), secret);
    assert.deepEqual((await new AppEnvironment(target, identity.environmentKey).open()).values('fixture-app'), { RECOVERED_SECRET: secret });
  }
  await clean(root);
});

test('failed config rebasing or authenticated catalog mismatches leave empty/absent targets untouched and retire staging', async t => {
  for (const broken of ['config', 'catalog']) {
    const { root, source, archive, target, project } = await fixture(t);
    if (broken === 'config') await writeFile(join(project.directory, '.git/config'), '[invalid git syntax');
    else { const path = join(source, 'projects.json'), records = JSON.parse(await readFile(path)); records[project.id].id = 'not-the-authenticated-id'; await writeFile(path, JSON.stringify(records)); }
    await createBackup({ directory: source, archive, password, offline: true }); await mkdir(target);
    await assert.rejects(recoverBackup({ directory: target, archive, password, offline: true, fetcher: refused }), /configuration|authenticated mapping/);
    assert.deepEqual(await readdir(target), []); await clean(root);
    await writeFile(join(target, 'keep'), 'preserved');
    await assert.rejects(recoverBackup({ directory: target, archive, password, offline: true, fetcher: refused }), /empty directory/);
    assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'preserved');
  }
});

test('generated hooks alone are rebased; custom paths and original restrictive modes remain exact', async t => {
  const { root, source, archive, target, projects, project } = await fixture(t);
  const custom = join(root, 'custom-hooks');
  await projects.git(project.directory, ['config', '--add', 'core.hooksPath', custom]);
  await chmod(join(project.directory, '.git/config'), 0o400); await chmod(join(source, 'projects.json'), 0o400);
  await createBackup({ directory: source, archive, password, offline: true });
  const result = await recoverBackup({ directory: target, archive, password, offline: true, fetcher: refused });
  assert.deepEqual(result.recovery.customHooks, [project.id]);
  const restarted = await new Projects(target).open(), path = restarted.get(project.id).directory;
  assert.deepEqual((await restarted.git(path, ['config', '--get-all', 'core.hooksPath'])).split('\n'), [join(target, 'projects/.hooks'), custom]);
  assert.equal((await lstat(join(target, 'projects.json'))).mode & 0o777, 0o400); assert.equal((await lstat(join(path, '.git/config'))).mode & 0o777, 0o400);
  await clean(root);
});

test('recovery refuses managed Git alternates instead of claiming external object storage is covered', async t => {
  const { root, source, archive, target, project } = await fixture(t);
  await writeFile(join(project.directory, '.git/objects/info/alternates'), join(root, 'external-objects') + '\n');
  await createBackup({ directory: source, archive, password, offline: true });
  await assert.rejects(recoverBackup({ directory: target, archive, password, offline: true, fetcher: refused }), /external object/);
  await assert.rejects(lstat(target), { code: 'ENOENT' }); await clean(root);
});

test('offline preflight refuses authoritative live identity and ambiguous hosts without credentials; stale PID alone is ignored', async t => {
  const { root, source, archive, target, identity } = await fixture(t);
  let headers, live = true;
  const server = createServer((request, response) => { headers = request.headers; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, instanceId: live ? identity.id : 'another-service' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const clientPath = join(source, 'client.json');
  await writeFile(clientPath, JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, instanceId: identity.id, hostPid: process.pid, token: identity.adminToken }));
  await assert.rejects(createStoppedBackup({ directory: source, archive, password, offline: true }), /still live/);
  assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined);
  await createBackup({ directory: source, archive, password, offline: true });
  await assert.rejects(recoverBackup({ directory: target, archive, password, offline: true }), /still live/); await assert.rejects(lstat(target), { code: 'ENOENT' }); await clean(root);
  live = false; await assert.rejects(assertOfflineInstance({ directory: source }), /another or unidentified/);
  assert.equal((await assertOfflineInstance({ directory: source, fetcher: refused })).status, 'saved-loopback-refused');
  await assert.rejects(assertOfflineInstance({ directory: source, fetcher: async () => { throw Error('timeout'); } }), /conclusively/);
  await assert.rejects(createStoppedBackup({ directory: source, archive, password }), /offline:true/);
});

test('CLI recovery relocates managed source using stdin/env password with fresh connection metadata', async t => {
  const { source, archive, target, project } = await fixture(t);
  await unlink(join(source, 'client.json')); // Deliberately stopped fixture without a saved endpoint.
  await backupCLI({ sub: 'create', options: { directory: source, output: archive, offline: true, 'password-stdin': true }, stdin: Readable.from([password + '\n']), print: () => {} });
  await backupCLI({ sub: 'restore', options: { directory: target, input: archive, offline: true }, env: { INK_OS_BACKUP_PASSWORD: password }, print: () => {} });
  const projects = await new Projects(target).open(); assert.equal(projects.get(project.id).directory, join(target, 'projects', project.id));
  assert.equal((await projects.status(project.id)).commit, project.commit);
});
