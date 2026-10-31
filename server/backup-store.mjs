import { constants } from 'node:fs';
import { open, lstat, mkdir, mkdtemp, opendir, readdir, rename, link, unlink, rm, chmod } from 'node:fs/promises';
import { resolve, join, dirname, basename, relative, sep, parse } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

// v1: fixed authenticated header (magic, salt, IV), AES-256-GCM ciphertext,
// 16-byte tag. Plaintext is length-prefixed JSON records and exact file bytes.
// KDF parameters are fixed, never supplied by an untrusted archive.
const MAGIC = Buffer.from('INKBAK01'), HEADER_BYTES = 36, CHUNK_BYTES = 64 * 1024;
const derive = promisify(scrypt);
const defaults = { maxEntries: 1_000_000, maxBytes: 1024 ** 4, maxFileBytes: 1024 ** 4, maxDepth: 128, maxArchiveBytes: 1024 ** 4 + 1024 ** 3 };
function limitsFor(overrides = {}) {
  const limits = { ...defaults, ...overrides };
  for (const [name, value] of Object.entries(limits)) if (!Object.hasOwn(defaults, name) || !Number.isSafeInteger(value) || value < 1) throw Error('Invalid backup limit: ' + name);
  return limits;
}
async function keyFor(password, salt) {
  if (typeof password !== 'string' && !Buffer.isBuffer(password)) throw Error('Provide a backup password through stdin or environment');
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 4096) throw Error('Backup password must contain 12–4096 bytes');
  return derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) { const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset); if (!bytesWritten) throw Error('Backup write stopped'); offset += bytesWritten; }
}
async function readAt(handle, length, position) {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset); if (!bytesRead) throw Error('Truncated backup'); offset += bytesRead; }
  return bytes;
}
async function noSymlinkAncestors(path) {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const component of relative(root, full).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw Error('Backup paths cannot contain symlinks');
  }
}
function safePath(path, limits, allowRoot = false) {
  if (typeof path !== 'string' || !allowRoot && !path || Buffer.byteLength(path) > 4096 || path.includes('\\') || /[\x00-\x1f\x7f:<>"|?*]/.test(path)) throw Error('Unsafe backup path');
  if (path === '' && allowRoot) return;
  const parts = path.split('/');
  if (parts.length > limits.maxDepth || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw Error('Unsafe backup path');
}
function sameFile(before, after) { return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs; }
function recordBytes(record) {
  const bytes = Buffer.from(JSON.stringify(record)); if (bytes.length > CHUNK_BYTES) throw Error('Backup record exceeds 64 KiB');
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]);
}
async function syncDirectory(path) { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
function outside(source, destination) { const inside = relative(source, destination); if (!inside || !inside.startsWith('..' + sep) && inside !== '..' && !parse(inside).root) throw Error('Backup archive must be outside the source tree'); }

// Catalog mappings live only inside the authenticated ciphertext. Read a bounded
// regular file without following links; raw catalog bytes are still archived.
async function sourceManifest(source, originalDirectory, limits) {
  const result = { instanceRoot: resolve(originalDirectory), managedProjects: [], externalProjectCount: 0 };
  let catalog;
  try { catalog = await open(join(source, 'projects.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  try {
    const stat = await catalog.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Project catalog must be a regular file of at most 1 MiB');
    const records = JSON.parse((await readAt(catalog, stat.size, 0)).toString('utf8'));
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw Error('Invalid project catalog');
    for (const [id, record] of Object.entries(records)) {
      if (!record || record.managed !== true) { result.externalProjectCount++; continue; }
      if (typeof record.directory !== 'string') throw Error('Invalid managed project directory');
      const path = relative(result.instanceRoot, resolve(record.directory)).split(sep).join('/');
      safePath(path, limits);
      if (!path.startsWith('projects/')) throw Error('Managed project is outside the instance project tree');
      result.managedProjects.push({ id, directory: record.directory, archivePath: path });
    }
    return result;
  } finally { await catalog.close(); }
}

/**
 * Back up a stopped private instance with offline:true, or acquire a caller-owned
 * consistency barrier/snapshot. acquireSnapshot() returns {directory, release,
 * consistency:'quiesced'|'snapshot', coverage?:{remoteAssets,externalProjects,
 * externalSecrets}, sourceRoot?, assets?, extraFiles?}. sourceRoot preserves
 * original managed-project mappings when directory is an owned staged copy.
 * extraFiles() yields {path,mode,size,sha256,chunks} with raw byte chunks and an
 * already archived parent directory. They share all archive limits. release
 * runs after all source reads, including failures.
 * The caller must drain ALL state/project/blob writers and preserve remote asset
 * versions, or materialize a coherent snapshot. No live consistency is inferred.
 * Entire trees (including .git and identity/envelope keys) are private data.
 * No external symlinks, external project paths or remote blobs are followed.
 */
export async function createBackup({ directory, archive, password, offline = false, acquireSnapshot, limits: overrides, signal } = {}) {
  const limits = limitsFor(overrides);
  if (!archive || !directory) throw Error('Provide source directory and archive path');
  if (typeof offline !== 'boolean') throw Error('offline must be a boolean assertion');
  if (!offline && typeof acquireSnapshot !== 'function') throw Error('Stop the host and specify offline:true, or provide acquireSnapshot');
  if (offline && acquireSnapshot) throw Error('Choose offline or acquireSnapshot');
  let snapshot, output, temp, key, released = false;
  const destination = resolve(archive), parent = dirname(destination);
  try {
    snapshot = acquireSnapshot ? await acquireSnapshot() : { directory, consistency: 'offline', release: async () => {} };
    if (!snapshot || typeof snapshot.release !== 'function' || !snapshot.directory || !['offline', 'quiesced', 'snapshot'].includes(snapshot.consistency) || acquireSnapshot && snapshot.consistency === 'offline') throw Error('Invalid backup snapshot contract');
    const source = resolve(snapshot.directory);
    await noSymlinkAncestors(source); await noSymlinkAncestors(parent);
    const excluded = snapshot.excludeBackupDirectory === true ? 'backups' : null;
    const backupPath = relative(join(source, 'backups'), destination);
    const insideExcluded = excluded && backupPath && !backupPath.startsWith('..' + sep) && backupPath !== '..' && !parse(backupPath).root && source === resolve(directory);
    if (!insideExcluded) { outside(source, destination); outside(resolve(directory), destination); }
    if (!(await lstat(source)).isDirectory()) throw Error('Backup source must be a directory');
    try { await lstat(destination); throw Error('Backup archive already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const header = Buffer.concat([MAGIC, randomBytes(16), randomBytes(12)]);
    key = await keyFor(password, header.subarray(8, 24));
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(24)); cipher.setAAD(header);
    temp = join(parent, '.' + basename(destination) + '.' + randomBytes(12).toString('hex') + '.partial');
    const archiveDigest = createHash('sha256');
    const writeEncrypted = async bytes => { archiveDigest.update(bytes); await writeAll(output, bytes); };
    output = await open(temp, 'wx', 0o600); await writeEncrypted(header);
    let encryptedBytes = HEADER_BYTES;
    const emit = async bytes => { signal?.throwIfAborted(); const encrypted = cipher.update(bytes); encryptedBytes += encrypted.length; if (encryptedBytes + 16 > limits.maxArchiveBytes) throw Error('Backup archive exceeds limit'); await writeEncrypted(encrypted); };
    const metadata = { source: await sourceManifest(source, snapshot.sourceRoot || directory, limits), format: 'ink-os-private-backup-v1', createdAt: new Date().toISOString(), consistency: snapshot.consistency, coverage: { remoteAssets: false, externalProjects: false, externalSecrets: false, ...snapshot.coverage, localTree: true, ...(excluded ? { excludedBackupArchives: true } : {}) }, ...(snapshot.assets ? { assets: snapshot.assets } : {}) };
    await emit(recordBytes({ type: 'metadata', ...metadata }));
    let files = 0, directories = 0, bytes = 0;
    const names = new Set(), parents = new Set();
    async function visit(local, path) {
      safePath(path, limits, true);
      const folded = path.normalize('NFC').toLowerCase();
      if (names.has(folded)) throw Error('Ambiguous backup path');
      names.add(folded);
      const stat = await lstat(local, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw Error('Backup sources must be regular files or directories; symlinks are forbidden');
      if (files + directories >= limits.maxEntries) throw Error('Backup entry limit exceeded');
      const mode = Number(stat.mode & 0o777n);
      if (stat.isDirectory()) {
        parents.add(path);
        directories++; await emit(recordBytes({ type: 'directory', path, mode }));
        const entries = await opendir(local);
        for await (const entry of entries) { if (!path && entry.name === excluded) continue; await visit(join(local, entry.name), path ? path + '/' + entry.name : entry.name); }
      } else {
        const size = Number(stat.size);
        if (!Number.isSafeInteger(size) || size > limits.maxFileBytes || bytes + size > limits.maxBytes) throw Error('Backup file or total byte limit exceeded');
        files++; bytes += size;
        const input = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!sameFile(stat, await input.stat({ bigint: true }))) throw Error('Backup source changed while reading');
          await emit(recordBytes({ type: 'file', path, mode, size }));
          for (let position = 0; position < size;) { const count = Math.min(CHUNK_BYTES, size - position); await emit(await readAt(input, count, position)); position += count; }
          if (!sameFile(stat, await input.stat({ bigint: true }))) throw Error('Backup source changed while reading');
        } finally { await input.close(); }
      }
    }
    await visit(source, '');
    if (snapshot.extraFiles !== undefined) {
      if (typeof snapshot.extraFiles !== 'function') throw Error('Backup extraFiles must provide a bounded file iterator');
      for await (const file of snapshot.extraFiles()) {
        if (!file || typeof file !== 'object') throw Error('Invalid additional backup file');
        safePath(file.path, limits);
        const folded = file.path.normalize('NFC').toLowerCase();
        if (names.has(folded)) throw Error('Ambiguous backup path');
        if (!parents.has(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '')) throw Error('Missing backup parent directory');
        if (files + directories >= limits.maxEntries || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw Error('Invalid additional backup file');
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.maxFileBytes || bytes + file.size > limits.maxBytes) throw Error('Backup file or total byte limit exceeded');
        if (!file.chunks || typeof file.chunks[Symbol.asyncIterator] !== 'function' && typeof file.chunks[Symbol.iterator] !== 'function') throw Error('Additional backup files require raw byte chunks');
        names.add(folded); files++; bytes += file.size;
        await emit(recordBytes({ type: 'file', path: file.path, mode: file.mode, size: file.size }));
        const digest = createHash('sha256'); let size = 0;
        for await (const chunk of file.chunks) {
          if (!(chunk instanceof Uint8Array) || chunk.length > file.size - size) throw Error('Additional backup file size or bytes changed');
          size += chunk.length; digest.update(chunk);
          for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) await emit(chunk.subarray(offset, offset + CHUNK_BYTES));
        }
        if (size !== file.size || digest.digest('hex') !== file.sha256) throw Error('Additional backup file size or digest mismatch');
      }
    }
    await emit(recordBytes({ type: 'end', files, directories, bytes }));
    released = true; await snapshot.release();
    signal?.throwIfAborted(); await writeEncrypted(cipher.final()); await writeEncrypted(cipher.getAuthTag()); await output.sync(); await output.close(); output = undefined;
    // Hard-link publication is atomic and cannot clobber an existing archive.
    await link(temp, destination); await unlink(temp); temp = undefined; await syncDirectory(parent);
    return { ...metadata, files, directories, bytes, archiveBytes: encryptedBytes + 16, archiveSha256: archiveDigest.digest('hex') };
  } finally {
    key?.fill(0);
    if (output) await output.close().catch(() => {});
    if (temp) await unlink(temp).catch(() => {});
    if (!released && typeof snapshot?.release === 'function') await snapshot.release();
  }
}

class PlainReader {
  constructor(handle, cipher, end) { this.handle = handle; this.cipher = cipher; this.end = end; this.position = HEADER_BYTES; this.buffer = Buffer.alloc(0); this.finished = false; }
  async chunk() {
    if (this.position < this.end) { const length = Math.min(CHUNK_BYTES, this.end - this.position); const bytes = await readAt(this.handle, length, this.position); this.position += length; return this.cipher.update(bytes); }
    if (!this.finished) { this.finished = true; return this.cipher.final(); }
    return Buffer.alloc(0);
  }
  async take(length) {
    if (length > CHUNK_BYTES) throw Error('Backup read exceeds chunk bound');
    const parts = []; let count = 0;
    while (count < length) {
      if (!this.buffer.length) this.buffer = await this.chunk();
      if (!this.buffer.length) throw Error('Truncated backup');
      const size = Math.min(length - count, this.buffer.length); parts.push(this.buffer.subarray(0, size)); count += size; this.buffer = this.buffer.subarray(size);
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, count);
  }
  async record() { const size = (await this.take(4)).readUInt32BE(); if (!size || size > CHUNK_BYTES) throw Error('Invalid backup record length'); return JSON.parse((await this.take(size)).toString('utf8')); }
  async finish() { if (this.buffer.length) throw Error('Trailing backup data'); while (!this.finished) { if ((await this.chunk()).length) throw Error('Trailing backup data'); } }
}

/** Restore to a nonexistent or empty directory while the host is stopped.
 * No restored data is published until every record and the GCM tag verify.
 * Staging lives beside the target (same filesystem), mode 0700; files are 0600
 * until authentication completes. Caller owns exclusive access to the target's
 * parent during publication. Exact catalog paths are preserved, not rewritten;
 * integration must rebind managed projects when moving an instance.
 */
export async function restoreBackup({ archive, directory, password, limits: overrides } = {}) {
  const limits = limitsFor(overrides);
  if (!archive || !directory) throw Error('Provide archive and restore directory');
  const destination = resolve(directory), parent = dirname(destination);
  await noSymlinkAncestors(parent); await noSymlinkAncestors(resolve(archive));
  let existing;
  try { existing = await lstat(destination); if (existing.isSymbolicLink() || !existing.isDirectory() || (await readdir(destination)).length) throw Error('Restore target must be absent or an empty directory without symlinks'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let input, stage, key;
  try {
    input = await open(resolve(archive), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await input.stat({ bigint: true }), size = Number(stat.size);
    if (!stat.isFile() || !Number.isSafeInteger(size) || size < HEADER_BYTES + 16 || size > limits.maxArchiveBytes) throw Error('Invalid backup size');
    const header = await readAt(input, HEADER_BYTES, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) throw Error('Unsupported backup format');
    key = await keyFor(password, header.subarray(8, 24));
    const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(24)); cipher.setAAD(header); cipher.setAuthTag(await readAt(input, 16, size - 16));
    const reader = new PlainReader(input, cipher, size - 16), metadata = await reader.record();
    if (metadata.type !== 'metadata' || metadata.format !== 'ink-os-private-backup-v1' || !['offline', 'quiesced', 'snapshot'].includes(metadata.consistency) || !metadata.coverage || metadata.coverage.localTree !== true) throw Error('Invalid backup metadata');
    stage = await mkdtemp(join(parent, '.ink-restore-')); await chmod(stage, 0o700);
    const seen = new Set(), foldedNames = new Set(), directories = new Map(), fileModes = [];
    let files = 0, directoryCount = 0, bytes = 0;
    for (;;) {
      const entry = await reader.record();
      if (entry.type === 'end') {
        if (!directories.has('') || entry.files !== files || entry.directories !== directoryCount || entry.bytes !== bytes) throw Error('Backup summary mismatch');
        break;
      }
      if (!['file', 'directory'].includes(entry.type)) throw Error('Unsupported backup entry type');
      safePath(entry.path, limits, entry.type === 'directory');
      if (seen.size >= limits.maxEntries || seen.has(entry.path) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw Error('Invalid or duplicate backup entry');
      // Portable archives cannot contain case aliases, including on case-sensitive hosts.
      const folded = entry.path.normalize('NFC').toLowerCase();
      if (foldedNames.has(folded)) throw Error('Ambiguous backup path');
      if (entry.path && !directories.has(entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '')) throw Error('Missing backup parent directory');
      seen.add(entry.path); foldedNames.add(folded);
      const path = entry.path ? join(stage, ...entry.path.split('/')) : stage;
      if (entry.type === 'directory') {
        directoryCount++; if (entry.path) await mkdir(path, { mode: 0o700 }); directories.set(entry.path, entry.mode);
      } else {
        if (!entry.path || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes || bytes + entry.size > limits.maxBytes) throw Error('Backup file or total byte limit exceeded');
        files++; bytes += entry.size;
        const file = await open(path, 'wx', 0o600);
        try { for (let left = entry.size; left > 0;) { const length = Math.min(CHUNK_BYTES, left); await writeAll(file, await reader.take(length)); left -= length; } await file.sync(); } finally { await file.close(); }
        fileModes.push([path, entry.mode]);
      }
    }
    await reader.finish();
    if (!sameFile(stat, await input.stat({ bigint: true }))) throw Error('Backup archive changed while reading');
    await input.close(); input = undefined;
    for (const [path, mode] of fileModes) await chmod(path, mode);
    for (const [path, mode] of [...directories].reverse()) { const local = path ? join(stage, ...path.split('/')) : stage; await syncDirectory(local); await chmod(local, mode); }
    // Recheck the target immediately before the same-filesystem rename. A
    // nonempty target is also rejected by rename itself on supported hosts.
    try {
      const now = await lstat(destination);
      if (!existing || now.isSymbolicLink() || !now.isDirectory() || now.dev !== existing.dev || now.ino !== existing.ino || (await readdir(destination)).length) throw Error('Restore target changed or is nonempty');
    } catch (error) { if (error.code !== 'ENOENT' || existing) throw error; }
    await rename(stage, destination); stage = undefined; await syncDirectory(parent);
    const { type, ...result } = metadata;
    return { ...result, files, directories: directoryCount, bytes };
  } finally {
    key?.fill(0);
    if (input) await input.close().catch(() => {});
    if (stage) { // Re-enable access if applying original read-only directory modes failed.
      const unlock = async path => { await chmod(path, 0o700); for await (const entry of await opendir(path)) if (entry.isDirectory()) await unlock(join(path, entry.name)); };
      await unlock(stage).catch(() => {}); await rm(stage, { recursive: true, force: true });
    }
  }
}
