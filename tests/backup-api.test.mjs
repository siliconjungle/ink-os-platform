import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, realpath, readFile, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '../sdk/src/server.js';
import { recoverBackup } from '../server/backup-recovery.mjs';
import { Backups } from '../server/backups.mjs';

const execute = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function finished(backups, operation) { for (let count = 0; count < 1000; count++) { const job = await backups.get(operation); if (!['queued', 'running'].includes(job.status)) return job; await pause(); } assert.fail('Backup did not finish'); }
async function host(t, storageEnv = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-backup-api-'))), directory = join(root, 'data');
  await writeFile(join(root, 'storage-retention.json'), JSON.stringify({ keep: { data: 'Active owned API backup validation instance.' }, safe_to_remove: {} }));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|LANG|LC_ALL|TMPDIR)$/.test(key))), NODE_ENV: 'production', PORT: String(port), INK_OS_DATA_DIR: directory, INK_OS_NATIVE: '0', ...storageEnv };
  const url = 'http://127.0.0.1:' + port; let child, output = '';
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0, output.slice(-2000)); } }
  async function start() {
    output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    for (let count = 0; count < 300; count++) {
      if (child.exitCode !== null) assert.fail(output.slice(-2000));
      try { if ((await fetch(url + '/api/health')).ok) return; } catch {}
      await pause();
    }
    assert.fail('Host did not start: ' + output.slice(-2000));
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true }); });
  await start(); const config = JSON.parse(await readFile(join(directory, 'client.json'))), sdk = createClient({ url, token: config.token, continuation: null });
  const cli = async (args, extra = {}) => JSON.parse((await execute(process.execPath, ['cli/bin/ink-os.mjs', 'backup', ...args], { env: { ...env, INK_OS_CONFIG: join(directory, 'client.json'), ...extra }, timeout: 20000 })).stdout);
  return { root, directory, url, sdk, cli, start, stop, token: config.token };
}

test('actual administrator API/CLI/SDK creates, streams, verifies and recovers an encrypted live backup across host restart', { timeout: 40000 }, async t => {
  const f = await host(t); assert.deepEqual(await f.sdk.apps.list(), []);
  const note = await f.sdk.data.create({ kind: 'note', title: 'Preserve this note', body: 'Exact backup bytes' });
  const asset = await f.sdk.assets.put(Buffer.from([0, 255, 10, 7]), { title: 'Backup bytes' });
  const operation = randomBytes(16).toString('hex'), password = randomBytes(32).toString('hex');
  const admitted = await f.cli(['create', '--operation', operation], { INK_OS_BACKUP_PASSWORD: password });
  assert.equal(admitted.id, operation); assert.ok(['queued', 'running'].includes(admitted.status));
  const ready = await finished(f.sdk.backups, operation); assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(ready.coverage.remoteAssets, true); assert.equal(ready.coverage.excludedBackupArchives, true);
  const jobJournal = await readFile(join(f.directory, 'backups/journal.json'), 'utf8'); assert.ok(!jobJournal.includes(password)); assert.ok(!jobJournal.includes(f.token)); assert.ok(!jobJournal.includes(f.directory));
  const download = await f.sdk.backups.download(operation), chunks = []; for await (const chunk of download.chunks) chunks.push(chunk);
  const bytes = Buffer.concat(chunks); assert.equal(sha(bytes), ready.sha256); assert.equal(bytes.length, ready.bytes); assert.ok(!bytes.includes(Buffer.from('Exact backup bytes')));
  const headers = { authorization: 'Bearer ' + f.token };
  const range = await fetch(f.url + '/api/v1/backups/' + operation + '/download', { headers: { ...headers, range: 'bytes=0-11' } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 12));
  const head = await fetch(f.url + '/api/v1/backups/' + operation + '/download', { method: 'HEAD', headers }); assert.equal(Number(head.headers.get('content-length')), bytes.length);
  const invalid = await fetch(f.url + '/api/v1/backups/' + operation + '/download', { headers: { ...headers, range: 'bytes=3-1' } }); assert.equal(invalid.status, 416);
  const output = join(f.root, 'download.inkbak'); const receipt = await f.cli(['download', operation, '--output', output]); assert.equal(receipt.sha256, ready.sha256); assert.equal((await lstat(output)).mode & 0o777, 0o600);
  await assert.rejects(f.cli(['download', operation, '--output', output])); assert.deepEqual(await readFile(output), bytes);
  await assert.rejects(recoverBackup({ directory: join(f.root, 'live-refused'), archive: output, password, offline: true }), /still live/);
  const replay = await f.sdk.backups.create({ operation, password: 'a different password supplied on replay', timeoutMs: ready.timeoutMs, remoteAssets: true }); assert.equal(replay.sha256, ready.sha256);
  await assert.rejects(f.sdk.backups.create({ operation, password, timeoutMs: 1 }), { status: 409 });
  await f.stop();
  const recovered = join(f.root, 'recovered'); await recoverBackup({ directory: recovered, archive: output, password, offline: true });
  assert.ok(!(await readdir(recovered)).includes('backups')); assert.deepEqual(await readFile(join(recovered, 'blobs', asset.sha256 || sha(Buffer.from([0, 255, 10, 7])))), Buffer.from([0, 255, 10, 7]));
  await f.start(); assert.equal((await f.cli(['status', operation])).sha256, ready.sha256); assert.equal((await f.sdk.data.get(note.id)).body, 'Exact backup bytes');
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1; await writeFile(join(f.directory, 'backups', operation + '.inkbak'), corrupt);
  const rejectedOutput = join(f.root, 'corrupt-download.inkbak'); await assert.rejects(f.cli(['download', operation, '--output', rejectedOutput]), /incomplete or corrupt/);
  await assert.rejects(lstat(rejectedOutput), { code: 'ENOENT' }); assert.ok(!(await readdir(f.root)).some(path => path.startsWith('.ink-backup-download-')));
  assert.equal((await f.cli(['list'])).length, 1); await f.cli(['delete', operation]); assert.deepEqual(await f.sdk.backups.list(), []);
});

test('private backup routes refuse missing, scoped and service credentials before parsing secrets', { timeout: 20000 }, async t => {
  const f = await host(t), scoped = await f.sdk.account.keys.create({ name: 'Read only backup fixture', scopes: ['world:read'], expiresInDays: 1 });
  const client = createClient({ url: f.url, token: scoped.token });
  await assert.rejects(client.backups.list(), { status: 403 });
  const response = await fetch(f.url + '/api/v1/backups'); assert.equal(response.status, 401);
  const app = await f.sdk.apps.create({ slug: 'backup-scope-proof', title: 'Backup scope proof' }), service = await f.sdk.request('apps/' + app.id + '/token', { method: 'POST', body: {} });
  await assert.rejects(createClient({ url: f.url, token: service.token }).backups.list(), { status: 403 });
  const extra = await fetch(f.url + '/api/v1/backups?password=forbidden', { headers: { authorization: 'Bearer ' + f.token } }); assert.equal(extra.status, 400);
  assert.deepEqual(await f.sdk.backups.list(), []);
});

test('real host shutdown waits for its active encrypted remote reader and admits no replacement backup', { timeout: 30000 }, async t => {
  const objects = new Map(); let release, enter;
  const reading = new Promise(resolve => enter = resolve), blocked = new Promise(resolve => release = resolve);
  const remote = httpServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer disposable-backup-reader-token');
    if (req.method === 'PUT') { const parts = []; for await (const part of req) parts.push(part); objects.set(req.url, Buffer.concat(parts)); res.end(); return; }
    enter(); await blocked; const bytes = objects.get(req.url); res.writeHead(bytes ? 200 : 404); res.end(bytes);
  });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  t.after(async () => { release(); await new Promise(resolve => remote.close(resolve)); });
  const f = await host(t, { INK_OS_R2_URL: 'http://127.0.0.1:' + remote.address().port, INK_OS_R2_TOKEN: 'disposable-backup-reader-token', INK_OS_R2_BUCKET: 'owned-backup-fixture' });
  await f.sdk.assets.put(Buffer.from('Owned delayed remote reader'));
  const operation = 'e'.repeat(32); await f.sdk.backups.create({ operation, password: 'Disposable delayed reader password' }); await reading;
  let stopped = false; const quitting = f.stop().then(() => stopped = true);
  try {
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(stopped, false);
    assert.equal((await f.sdk.backups.get(operation)).status, 'running');
    await assert.rejects(f.sdk.backups.create({ operation: 'f'.repeat(32), password: 'Replacement fixture password' }), { status: 503 });
  } finally { release(); }
  await quitting;
  const journal = JSON.parse(await readFile(join(f.directory, 'backups/journal.json'))), job = journal.jobs.find(job => job.id === operation);
  assert.equal(job.status, 'ready'); assert.equal(sha(await readFile(join(f.directory, 'backups', operation + '.inkbak'))), job.sha256);
});

test('backup cancellation, secret wiping, lost admission replay and interrupted restart never publish an incomplete archive', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-backup-jobs-'))); t.after(() => rm(root, { recursive: true }));
  await writeFile(join(root, 'storage-retention.json'), JSON.stringify({ keep: {}, safe_to_remove: { backups: 'Owned generated lifecycle fixture after its writer settles.' } }));
  let finish, observedSecret, started; const entered = new Promise(resolve => started = resolve), blocked = new Promise(resolve => finish = resolve);
  const operation = 'a'.repeat(32), instanceId = 'b'.repeat(32), options = { gate: { directory: root }, world: {}, storage: {}, instanceId };
  const jobs = await new Backups({ ...options, capture: async input => { observedSecret = input.password; started(); await blocked; await writeFile(input.archive, 'fixture archive', { mode: 0o600 }); return { archiveBytes: 15, archiveSha256: sha('fixture archive'), coverage: {}, files: 1, bytes: 1 }; } }).open();
  await jobs.create({ operation, password: 'transient fixture password' }); await entered;
  await assert.rejects(jobs.create({ operation: 'c'.repeat(32), password: 'second fixture password' }), { status: 409 });
  assert.equal((await jobs.create({ operation, password: 'ignored replay password' })).id, operation);
  await jobs.cancel(operation); finish(); await jobs.whenIdle(); assert.equal(jobs.get(operation).status, 'cancelled'); assert.ok(observedSecret.every(value => value === 0)); await assert.rejects(jobs.openArchive(operation), { status: 409 });
  const path = join(root, 'backups/journal.json'), saved = JSON.parse(await readFile(path)); saved.jobs[0].status = 'running'; delete saved.digest; saved.digest = sha(JSON.stringify(saved)); await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
  const restarted = await new Backups(options).open(); assert.equal(restarted.get(operation).status, 'interrupted'); await assert.rejects(restarted.openArchive(operation), { status: 409 });
  restarted.stopAccepting(); await assert.rejects(restarted.create({ operation: 'd'.repeat(32), password: 'stopped fixture password' }), { status: 503 });
});
