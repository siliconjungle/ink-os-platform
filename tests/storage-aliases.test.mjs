import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Storage } from '../server/storage.mjs';
import { StorageAliases, storageAliasLocation } from '../server/storage-aliases.mjs';
import { createBackup, restoreBackup } from '../server/backup-store.mjs';
import { captureCurrentProcessReceipt, captureProcessReceipt } from '../server/process-receipt.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputDigest = hash('fixture source cut');
const operation = '1'.repeat(32);
async function directory(t, prefix = 'ink-storage-alias-') { const path = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function fixture(t, kind = 'local') {
  const path = await directory(t), bytes = Buffer.from('private bytes\0\xff canonical'), digest = hash(bytes), env = kind === 'r2' ? { INK_OS_R2_URL: 'https://current-store.invalid', INK_OS_R2_TOKEN: 'fixture token', INK_OS_R2_BUCKET: 'current-bucket' } : kind === 's3' ? { INK_OS_S3_BUCKET: 'current-bucket', INK_OS_STORAGE_PREFIX: 'custom/prefix' } : {};
  const target = kind === 'local' ? 'blob:' + digest : kind === 'r2' ? 'r2://current-bucket/objects/' + digest : 's3://current-bucket/custom/prefix/objects/' + digest;
  const remote = new Map(), calls = [];
  async function open() {
    const storage = new Storage(path, { env });
    storage.r2Request = async (route, options = {}) => { calls.push({ kind: 'r2', route, method: options.method || 'GET' }); assert.equal(options.method || 'GET', 'GET'); const raw = remote.get(route); if (!raw) throw Object.assign(Error('missing'), { upstreamStatus: 404 }); return new Response(raw); };
    storage.client = () => ({ send: async command => { calls.push({ kind: 's3', ...command.input, command: command.constructor.name }); assert.equal(command.constructor.name, 'GetObjectCommand'); assert.equal(command.input.Bucket, 'current-bucket'); const raw = remote.get('/' + command.input.Key); if (!raw) throw Object.assign(Error('missing'), { name: 'NoSuchKey' }); return { Body: Readable.from([raw.subarray(0, 3), raw.subarray(3)]) }; } });
    return storage.open();
  }
  const storage = await open();
  if (kind === 'local') await writeFile(join(path, 'blobs', digest), bytes, { mode: 0o600 }); else remote.set('/' + storageAliasLocation(target).key, bytes);
  return { path, storage, bytes, digest, target, remote, calls, open, source: 'r2://previous-bucket/objects/' + digest };
}

for (const kind of ['local', 'r2', 's3']) test('verified ' + kind + ' target supports exact old aliases, restart and conservative GC without old-store reads', async t => {
  const f = await fixture(t, kind), sources = ['blob:' + f.digest, f.source, 's3://previous-bucket/old/prefix/objects/' + f.digest], aliases = Object.fromEntries(sources.map(source => [source, f.target]));
  const installed = await f.storage.installAliases({ operation, inputDigest, aliases }); assert.equal(installed.aliases, sources.length); assert.equal(installed.replayed, false);
  for (const source of sources) assert.deepEqual(await f.storage.get(source), f.bytes);
  assert.equal(await f.storage.remove(f.source), false); assert.equal(await f.storage.remove(f.target), false); assert.equal(await f.storage.removeBytes(f.source), false);
  assert.ok(f.calls.every(call => call.kind !== 'r2' || call.route === '/objects/' + f.digest));
  const journal = JSON.parse(await readFile(join(f.path, 'storage-aliases.json'))); assert.equal(journal.aliases.length, sources.length); assert.equal(journal.operations[0].inputDigest, inputDigest); assert.equal((await stat(join(f.path, 'storage-aliases.json'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(f.path, 'storage-aliases.json'), 'utf8')).includes('fixture token'));
  const reopened = await f.open(); for (const source of sources) assert.deepEqual(await reopened.get(source), f.bytes);
  const calls = f.calls.length; const replay = await reopened.installAliases({ operation, inputDigest, aliases }); assert.equal(replay.replayed, true); assert.equal(f.calls.length, calls);
  await assert.rejects(reopened.installAliases({ operation, inputDigest: hash('different cut'), aliases }), { code: 'STORAGE_ALIAS_CONFLICT' }); assert.equal(f.calls.length, calls);
});

test('unverified old buckets, malformed locations, different digests, prototype keys and chains fail before transport', async t => {
  const f = await fixture(t, 'r2');
  await assert.rejects(f.storage.get(f.source), /outside managed R2/); assert.equal(f.calls.length, 0);
  const badSources = ['https://old.invalid/objects/' + f.digest, 'r2://previous-bucket/objects/../objects/' + f.digest, 'r2://previous-bucket/objects/' + f.digest + '?token=bad', 'r2://owner:secret@previous-bucket/objects/' + f.digest, 's3://previous-bucket/prefix/../objects/' + f.digest, '__proto__'];
  for (const source of badSources) await assert.rejects(f.storage.installAliases({ operation, inputDigest, aliases: { [source]: f.target } }), { code: 'STORAGE_ALIAS_INVALID' });
  await assert.rejects(f.storage.installAliases({ operation, inputDigest, aliases: { [f.source]: 'blob:' + hash('different bytes') } }), { code: 'STORAGE_ALIAS_INVALID' });
  await assert.rejects(f.storage.installAliases({ operation, inputDigest, aliases: Object.create({ [f.source]: f.target }) }), { code: 'STORAGE_ALIAS_INVALID' });
  let getterCalled = false; const getters = {}; Object.defineProperty(getters, f.source, { enumerable: true, get() { getterCalled = true; return f.target; } }); await assert.rejects(f.storage.installAliases({ operation, inputDigest, aliases: getters }), { code: 'STORAGE_ALIAS_INVALID' }); assert.equal(getterCalled, false);
  await assert.rejects(f.storage.installAliases({ operation, inputDigest, aliases: { [f.source]: 'blob:' + f.digest, ['blob:' + f.digest]: f.target } }), { code: 'STORAGE_ALIAS_CONFLICT' }); assert.equal(f.calls.length, 0);
});

test('corrupt target, oversized bytes and a corrupt valid-current source cannot be shadowed or persisted', async t => {
  const f = await fixture(t, 'r2'); const route = '/objects/' + f.digest;
  f.remote.set(route, Buffer.from('wrong target')); await assert.rejects(f.storage.installAliases({ operation, inputDigest, aliases: { [f.source]: f.target } }), { code: 'STORAGE_ALIAS_INTEGRITY' }); assert.ok(!(await readdir(f.path)).includes('storage-aliases.json'));
  f.remote.set(route, f.bytes); const source = 'blob:' + f.digest; await writeFile(join(f.path, 'blobs', f.digest), 'wrong existing local bytes');
  await assert.rejects(f.storage.installAliases({ operation, inputDigest, aliases: { [source]: f.target } }), { code: 'STORAGE_ALIAS_INTEGRITY' }); assert.ok(!(await readdir(f.path)).includes('storage-aliases.json'));
  await rm(join(f.path, 'blobs', f.digest)); await f.storage.installAliases({ operation, inputDigest, aliases: { [source]: f.target } });
  f.remote.set(route, Buffer.from('changed after verification')); await assert.rejects(f.storage.get(source), { code: 'STORAGE_ALIAS_INTEGRITY' });
  const standalone = new StorageAliases({ directory: await directory(t), isCurrent: () => true, readCurrent: async () => Buffer.alloc(4), limits: { objectBytes: 3 } }); await standalone.open();
  await assert.rejects(standalone.install({ operation, inputDigest, aliases: { [f.source]: f.target } }), { code: 'STORAGE_ALIAS_INVALID' });
});

test('restart validates private journal integrity and destination scope without network; symlinks and locks fail safely', async t => {
  const f = await fixture(t, 'r2'); await f.storage.installAliases({ operation, inputDigest, aliases: { [f.source]: f.target } }); const path = join(f.path, 'storage-aliases.json'), original = await readFile(path); f.calls.length = 0;
  const other = new Storage(f.path, { env: { INK_OS_R2_URL: 'https://other.invalid', INK_OS_R2_TOKEN: 'fixture', INK_OS_R2_BUCKET: 'other-bucket' } }); await assert.rejects(other.open(), { code: 'STORAGE_ALIAS_INVALID' }); assert.equal(f.calls.length, 0);
  const corrupt = JSON.parse(original); corrupt.aliases[0].bytes++; await writeFile(path, JSON.stringify(corrupt)); await assert.rejects(f.open(), { code: 'STORAGE_ALIAS_INVALID' }); assert.equal(f.calls.length, 0);
  await writeFile(path, original); await writeFile(join(f.path, 'storage-aliases.lock'), 'operator review'); await assert.rejects(f.storage.installAliases({ operation: '2'.repeat(32), inputDigest, aliases: { [f.source]: f.target } }), { code: 'STORAGE_ALIAS_LOCKED' }); await rm(join(f.path, 'storage-aliases.lock'));
  await rm(path); await symlink(join(f.path, 'blobs', f.digest), path); await assert.rejects(f.open(), e => e.code === 'ELOOP'); assert.equal(f.calls.length, 0);
});

test('operation is atomic when one destination is missing, source count/input/byte limits fail safely', async t => {
  const f = await fixture(t), second = hash('missing object'), aliases = { [f.source]: f.target, ['r2://previous-bucket/objects/' + second]: 'blob:' + second };
  await assert.rejects(f.storage.installAliases({ operation, inputDigest, aliases })); assert.ok(!(await readdir(f.path)).includes('storage-aliases.json')); assert.equal(f.storage.aliases.get(f.source), undefined);
  for (const limits of [{ aliases: 1 }, { inputBytes: 1 }, { verifiedBytes: 1 }]) {
    const store = new StorageAliases({ directory: await directory(t), isCurrent: () => true, readCurrent: async () => f.bytes, limits }); await store.open();
    await assert.rejects(store.install({ operation, inputDigest, aliases: limits.aliases ? aliases : { [f.source]: f.target } }), { code: 'STORAGE_ALIAS_INVALID' }); assert.ok(!(await readdir(store.directory)).includes('storage-aliases.json'));
  }
});

test('queued GC cannot remove a destination being verified for alias installation', async t => {
  const f = await fixture(t); let entered, proceed; const arrived = new Promise(r => entered = r), held = new Promise(r => proceed = r), originalRead = f.storage.readAliasCurrent.bind(f.storage);
  f.storage.readAliasCurrent = async (...args) => { entered(); await held; return originalRead(...args); };
  const install = f.storage.installAliases({ operation, inputDigest, aliases: { [f.source]: f.target } }); await arrived;
  const remove = f.storage.remove(f.target); proceed(); await install; assert.equal(await remove, false); assert.deepEqual(await f.storage.get(f.source), f.bytes);
});

test('whole-tree encrypted backup retains alias journal and local target for exact restart', async t => {
  const f = await fixture(t), outputRoot = await directory(t, 'ink-alias-archive-'); await f.storage.installAliases({ operation, inputDigest, aliases: { [f.source]: f.target } });
  const archive = join(outputRoot, 'instance.inkbackup'), restored = join(outputRoot, 'restored');
  await createBackup({ directory: f.path, archive, password: 'fixture backup password', offline: true });
  await restoreBackup({ archive, directory: restored, password: 'fixture backup password' });
  assert.deepEqual(await readFile(join(restored, 'storage-aliases.json')), await readFile(join(f.path, 'storage-aliases.json')));
  const storage = await new Storage(restored, { env: {} }).open(); assert.deepEqual(await storage.get(f.source), f.bytes); assert.equal(await storage.remove(f.target), false);
});

test('authoritative owner-gone lock recovery replays an actual crash after journal rename', async t => {
  const f = await fixture(t), current = await captureCurrentProcessReceipt({ directory: f.path });
  if (!current.verified) { t.skip('Authoritative process identity unavailable on this platform'); return; }
  const moduleURL = new URL('../server/storage.mjs', import.meta.url).href;
  const script = `import {Storage} from ${JSON.stringify(moduleURL)};const storage=await new Storage(process.argv[1],{env:{}}).open();storage.aliases.fault=step=>{if(step==='journal-renamed')process.exit(73);};await storage.installAliases(JSON.parse(process.argv[2]));`;
  const input = { operation, inputDigest, aliases: { [f.source]: f.target } }, child = spawn(process.execPath, ['--input-type=module', '-e', script, f.path, JSON.stringify(input)], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
  const [code, signal] = await once(child, 'exit'); assert.equal(code, 73); assert.equal(signal, null);
  const lock = JSON.parse(await readFile(join(f.path, 'storage-aliases.lock'))); assert.equal(lock.owner.pid, child.pid); assert.equal(lock.owner.format, 'ink-os-process-receipt-v1');
  const saved = await readFile(join(f.path, 'storage-aliases.json')), reopened = await f.open();
  const result = await reopened.installAliases(input); assert.equal(result.replayed, true); assert.deepEqual(await readFile(join(f.path, 'storage-aliases.json')), saved); assert.deepEqual(await reopened.get(f.source), f.bytes);
  assert.ok(!(await readdir(f.path)).some(name => name.endsWith('.lock') || name.endsWith('.claim')));
});

test('live, foreign and unverified locks stay blocked; a mismatched start identity safely recovers without disturbing its PID', async t => {
  const f = await fixture(t), child = spawn(process.execPath, ['-e', "process.stdin.on('data',()=>process.stdout.write('pong\\n'));process.stdout.write('ready\\n');"], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] }), exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exited; }); await once(child.stdout, 'data');
  const captured = await captureProcessReceipt({ pid: child.pid, directory: f.path, child }); if (!captured.verified) { t.skip('Authoritative process identity unavailable on this platform'); return; }
  const lockPath = join(f.path, 'storage-aliases.lock'), input = { operation, inputDigest, aliases: { [f.source]: f.target } };
  const lock = owner => JSON.stringify({ format: 'ink-os-storage-alias-lock-v1', operation, inputDigest, owner });
  for (const owner of [captured.receipt, { ...captured.receipt, hostHash: hash('different boot') }, { pid: child.pid }]) { await writeFile(lockPath, lock(owner)); await assert.rejects(f.storage.installAliases(input), { code: 'STORAGE_ALIAS_LOCKED' }); }
  await writeFile(lockPath, lock({ ...captured.receipt, startHash: hash('original PID lifetime differs') }));
  const result = await f.storage.installAliases(input); assert.equal(result.replayed, false); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  const pong = once(child.stdout, 'data'); child.stdin.write('ping\n'); assert.match(String((await pong)[0]), /pong/);
});
