import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, lstat, rm, symlink, chmod, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, scryptSync, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createBackup, restoreBackup } from '../server/backup-store.mjs';
import { initializeInstance } from '../server/instance.mjs';
import { AppEnvironment } from '../server/app-environment.mjs';
import { ProjectCredentials } from '../server/project-credentials.mjs';
import { backupCLI } from '../cli/bin/backup.mjs';

const password = 'test-only disposable recovery phrase';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-backup-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), archive = join(root, 'private.inkbackup'), target = join(root, 'restored');
  await mkdir(source, { mode: 0o700 });
  return { root, source, archive, target };
}
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function noStaging(root) { assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.ink-restore-') || name.endsWith('.partial')), []); }
function crafted(records, mutate) {
  const header = Buffer.concat([Buffer.from('INKBAK01'), randomBytes(16), randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, header.subarray(8, 24), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), header.subarray(24));
  cipher.setAAD(header);
  const chunks = [];
  for (const entry of [{ type: 'metadata', format: 'ink-os-private-backup-v1', consistency: 'offline', coverage: { localTree: true } }, ...records]) {
    const bytes = Buffer.from(JSON.stringify(entry)), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); chunks.push(length, bytes);
  }
  if (mutate) mutate(chunks);
  return Buffer.concat([header, cipher.update(Buffer.concat(chunks)), cipher.final(), cipher.getAuthTag()]);
}

test('encrypted private identity, environment secrets, blobs and complete managed Git bytes recover', async t => {
  const { source, archive, target } = await fixture(t);
  const identity = await initializeInstance({ directory: source });
  const secret = randomBytes(32).toString('hex');
  const environment = await new AppEnvironment(source, identity.environmentKey).open();
  await environment.mutate('app', { RECOVERY_TEST_SECRET: secret });
  const credentialProject = { id: 'managed', source: { provider: 'github', github: { owner: 'fixture', repository: 'private-source' } } };
  const credentials = await new ProjectCredentials(source, identity.environmentKey).open();
  await credentials.set(credentialProject, secret);
  const project = join(source, 'projects', 'managed'); await mkdir(project, { recursive: true });
  const git = args => { const result = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '-b', 'main']);
  await writeFile(join(project, 'run.sh'), '#!/bin/sh\nprintf recovered\n', { mode: 0o755 });
  const binary = Buffer.from([0, 255, 128, 10, 13, 0]); await writeFile(join(project, 'binary'), binary);
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Disposable recovery fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  await writeFile(join(source, 'projects.json'), JSON.stringify({ managed: { id: 'managed', managed: true, directory: project }, external: { managed: false, directory: '/external-not-included' } }));
  await writeFile(join(project, 'uncommitted.txt'), 'working tree survives');
  await mkdir(join(source, 'blobs')); await writeFile(join(source, 'blobs', 'binary'), binary);
  await writeFile(join(source, 'world.json'), JSON.stringify({ sample: 'checkpoint bytes', count: '18446744073709551615' }));
  await mkdir(join(source, 'empty')); await chmod(join(source, 'empty'), 0o750);
  const receipt = await createBackup({ directory: source, archive, password, offline: true });
  assert.deepEqual(receipt.source, { instanceRoot: source, managedProjects: [{ id: 'managed', directory: project, archivePath: 'projects/managed' }], externalProjectCount: 1 });
  assert.equal(receipt.consistency, 'offline'); assert.equal(receipt.coverage.remoteAssets, false);
  assert.equal((await lstat(archive)).mode & 0o777, 0o600);
  assert.equal((await readFile(archive)).includes(Buffer.from(secret)), false);
  const restored = await restoreBackup({ directory: target, archive, password });
  assert.equal(restored.bytes, receipt.bytes); assert.equal(restored.files, receipt.files);
  const recoveredIdentity = await initializeInstance({ directory: target });
  assert.equal(recoveredIdentity.id, identity.id); assert.equal(recoveredIdentity.adminToken, identity.adminToken); assert.equal(recoveredIdentity.environmentKey, identity.environmentKey);
  assert.deepEqual((await new AppEnvironment(target, recoveredIdentity.environmentKey).open()).values('app'), { RECOVERY_TEST_SECRET: secret });
  assert.equal((await new ProjectCredentials(target, recoveredIdentity.environmentKey).open()).token(credentialProject), secret);
  assert.deepEqual(await readFile(join(target, 'projects/managed/binary')), binary);
  assert.equal((await lstat(join(target, 'projects/managed/run.sh'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(target, 'empty'))).mode & 0o777, 0o750);
  assert.equal(spawnSync('git', ['-C', join(target, 'projects/managed'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), commit);
  assert.equal(await readFile(join(target, 'projects/managed/uncommitted.txt'), 'utf8'), 'working tree survives');
  assert.deepEqual(await readFile(join(target, 'world.json')), await readFile(join(source, 'world.json')));
});

test('wrong password, ciphertext/tag/header corruption, truncation and appended bytes never publish', async t => {
  const { root, source, archive } = await fixture(t);
  await writeFile(join(source, 'secret'), randomBytes(100_000));
  await createBackup({ directory: source, archive, password, offline: true });
  const original = await readFile(archive);
  const cases = [
    { name: 'password', bytes: original, password: 'a different wrong password' },
    ...[0, 10, 30, Math.floor(original.length / 2), original.length - 1].map(offset => { const bytes = Buffer.from(original); bytes[offset] ^= 1; return { name: 'flip' + offset, bytes }; }),
    { name: 'truncate', bytes: original.subarray(0, original.length - 20) },
    { name: 'append', bytes: Buffer.concat([original, Buffer.from('junk')]) },
  ];
  for (const item of cases) {
    const path = join(root, item.name + '.backup'), directory = join(root, item.name); await writeFile(path, item.bytes);
    await assert.rejects(restoreBackup({ archive: path, directory, password: item.password || password }));
    await assert.rejects(lstat(directory), { code: 'ENOENT' }); await noStaging(root);
  }
});

test('authenticated malicious records reject traversal, symlinks, duplicate/ambiguous paths and missing parents', async t => {
  const { root } = await fixture(t);
  const dir = { type: 'directory', path: '', mode: 0o700 }, end = { type: 'end', files: 0, directories: 1, bytes: 0 };
  const entries = [
    { type: 'file', path: '../escape', mode: 0o600, size: 0 },
    { type: 'file', path: '/absolute', mode: 0o600, size: 0 },
    { type: 'file', path: 'a\\..\\escape', mode: 0o600, size: 0 },
    { type: 'file', path: 'C:escape', mode: 0o600, size: 0 },
    { type: 'file', path: 'x/../escape', mode: 0o600, size: 0 },
    { type: 'file', path: 'missing/child', mode: 0o600, size: 0 },
    { type: 'file', path: 'special', mode: 0o4600, size: 0 },
    { type: 'symlink', path: 'link', target: '/outside', mode: 0o600 },
    dir,
  ];
  for (const [index, entry] of entries.entries()) {
    const archive = join(root, 'malicious' + index); await writeFile(archive, crafted([dir, entry, end]));
    await assert.rejects(restoreBackup({ archive, directory: join(root, 'target'), password })); await noStaging(root);
  }
  for (const paths of [['same', 'same'], ['Name', 'name'], ['é', 'e\u0301']]) {
    const archive = join(root, 'alias'); await writeFile(archive, crafted([dir, ...paths.map(path => ({ type: 'file', path, mode: 0o600, size: 0 })), end]));
    await assert.rejects(restoreBackup({ archive, directory: join(root, 'target'), password }), /duplicate|Ambiguous/); await noStaging(root);
  }
});

test('authenticated invalid record bounds, oversized files and trailing records fail before publication', async t => {
  const { root, target } = await fixture(t);
  const dir = { type: 'directory', path: '', mode: 0o700 }, end = { type: 'end', files: 0, directories: 1, bytes: 0 };
  const cases = [
    crafted([dir, { type: 'file', path: 'huge', size: Number.MAX_SAFE_INTEGER, mode: 0o600 }, end]),
    crafted([dir, end, end]),
    crafted([dir, end], chunks => chunks[0].writeUInt32BE(0xffffffff)),
    crafted([dir, { ...end, bytes: 1 }]),
  ];
  for (const [index, bytes] of cases.entries()) {
    const archive = join(root, 'bounds' + index); await writeFile(archive, bytes);
    await assert.rejects(restoreBackup({ archive, directory: target, password }));
    await assert.rejects(lstat(target), { code: 'ENOENT' }); await noStaging(root);
  }
});

test('nonempty targets and source/target/ancestor symlinks are rejected without changing existing data', async t => {
  const { root, source, archive, target } = await fixture(t);
  await writeFile(join(source, 'key'), 'private'); await createBackup({ directory: source, archive, password, offline: true });
  await mkdir(target); await writeFile(join(target, 'keep'), 'untouched');
  await assert.rejects(restoreBackup({ directory: target, archive, password }), /empty directory/);
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'untouched');
  const linked = join(root, 'linked'); await symlink(target, linked);
  await assert.rejects(restoreBackup({ directory: linked, archive, password }), /symlink|empty directory/);
  await assert.rejects(restoreBackup({ directory: join(linked, 'child'), archive, password }), /symlink/);
  await symlink(join(source, 'key'), join(source, 'link'));
  await assert.rejects(createBackup({ directory: source, archive: join(root, 'bad'), password, offline: true }), /symlink/);
  await assert.rejects(createBackup({ directory: linked, archive: join(root, 'bad'), password, offline: true }), /symlink/);
  await noStaging(root);
});

test('explicit offline assertion/barrier, release-on-failure, limits and no-clobber archive publication', async t => {
  const { root, source, archive, target } = await fixture(t);
  await writeFile(join(source, 'payload'), '0123456789');
  await assert.rejects(createBackup({ directory: source, archive, password }), /acquireSnapshot/);
  await assert.rejects(createBackup({ directory: source, archive, password, offline: 'false' }), /boolean/);
  await assert.rejects(createBackup({ directory: source, archive: join(source, 'self'), password, offline: true }), /outside/);
  let releases = 0;
  const acquireSnapshot = async () => ({ directory: source, consistency: 'quiesced', release: async () => { releases++; } });
  await assert.rejects(createBackup({ directory: source, archive, password, acquireSnapshot, limits: { maxFileBytes: 5 } }), /limit/);
  assert.equal(releases, 1); await assert.rejects(lstat(archive), { code: 'ENOENT' }); await noStaging(root);
  const result = await createBackup({ directory: source, archive, password, acquireSnapshot }); assert.equal(releases, 2); assert.equal(result.consistency, 'quiesced');
  const hash = await digest(archive);
  await assert.rejects(createBackup({ directory: source, archive, password, offline: true }), /already exists/); assert.equal(await digest(archive), hash);
  await mkdir(target);
  await assert.rejects(restoreBackup({ directory: target, archive, password, limits: { maxBytes: 5 } }), /limit/);
  assert.deepEqual(await readdir(target), []); await noStaging(root);
  await assert.rejects(restoreBackup({ directory: target, archive, password, limits: { maxEntries: 1 } }), /entry/);
  await restoreBackup({ directory: target, archive, password, limits: { maxEntries: 2 } });
  assert.equal(await readFile(join(target, 'payload'), 'utf8'), '0123456789');
});

test('larger file streams with bounded memory and exact hash', async t => {
  const { source, archive, target } = await fixture(t), path = join(source, 'large');
  const file = await open(path, 'wx', 0o600), chunk = randomBytes(64 * 1024);
  try { for (let n = 0; n < 1024; n++) await file.write(chunk); } finally { await file.close(); }
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 2);
  const baseline = process.memoryUsage().arrayBuffers;
  try { await createBackup({ directory: source, archive, password, offline: true }); await restoreBackup({ directory: target, archive, password }); } finally { clearInterval(sampler); }
  assert.equal(await digest(join(target, 'large')), await digest(path));
  // A regression buffering whole files through Buffer.concat would exceed this
  // comfortably; allowance includes normal GC lag and encryption I/O buffers.
  assert.ok(peak - baseline < 48 * 1024 * 1024, 'array buffer growth: ' + (peak - baseline));
});

test('CLI accepts only stdin/environment password sources and requires stopped-instance assertion', async t => {
  const { root, source, target } = await fixture(t); await writeFile(join(source, 'bytes'), 'recover');
  const alias = join(root, 'explicitly-selected-parent-alias'); await symlink(root, alias);
  const options = { directory: join(alias, 'source'), output: join(alias, 'private.inkbackup'), offline: true, 'password-stdin': true };
  await backupCLI({ sub: 'create', options, stdin: Readable.from([password + '\n']), print: () => {} });
  await backupCLI({ sub: 'restore', options: { directory: join(alias, 'restored'), input: join(alias, 'private.inkbackup'), offline: true }, env: { INK_OS_BACKUP_PASSWORD: password }, print: () => {} });
  assert.equal(await readFile(join(target, 'bytes'), 'utf8'), 'recover');
  await assert.rejects(backupCLI({ sub: 'create', options: { ...options, password }, print: () => {} }), /Unsupported/);
  await assert.rejects(backupCLI({ sub: 'create', options: { ...options, offline: false }, print: () => {} }), /Stop the instance/);
});
