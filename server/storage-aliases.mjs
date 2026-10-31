import { open, lstat, rename, unlink, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { captureCurrentProcessReceipt, checkProcessReceipt } from './process-receipt.mjs';
import { BACKUP_ASSET_LIMITS } from '../shared/backup-limits.mjs';

const format = 'ink-os-storage-aliases-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'STORAGE_ALIAS_INVALID') => { throw Object.assign(Error(message), { code }); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0') && !Object.getOwnPropertySymbols(value).length && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const orderedMap = entries => Object.fromEntries([...entries].sort(([a], [b]) => compare(a, b)));

/** Parse only canonical content-addressed locations, never arbitrary URLs. */
export function storageAliasLocation(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('Invalid bounded storage alias location');
  if (/^blob:[a-f0-9]{64}$/.test(value)) return { scheme: 'blob', digest: value.slice(5) };
  // Reject URL normalization, escapes, userinfo, ports, dot segments and query/fragment.
  const match = /^(r2|s3):\/\/([a-z0-9][a-z0-9.-]{0,252})\/((?:[A-Za-z0-9_-]+\/)*objects\/([a-f0-9]{64}))$/.exec(value);
  if (!match || match[2].includes('..') || match[2].endsWith('.') || match[1] === 'r2' && match[3] !== 'objects/' + match[4]) fail('Storage aliases require canonical content-addressed blob, R2 or S3 locations');
  return { scheme: match[1], bucket: match[2], key: match[3], digest: match[4] };
}
async function boundedFile(path, limit) {
  let f; try { f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { const s = await f.stat(); if (!s.isFile() || s.size > limit) fail('Storage alias journal exceeds its bound'); const b = Buffer.alloc(s.size + 1); let n = 0; while (n < b.length) { const part = await f.read(b, n, b.length - n, n); if (!part.bytesRead) break; n += part.bytesRead; } if (n !== s.size) fail('Storage alias journal changed during read'); return b.subarray(0, n); } finally { await f.close(); }
}
async function syncDirectory(path) { const f = await open(path, 'r'); try { await f.sync(); } finally { await f.close(); } }

/** Explicit aliases never authorize reads from the old store. The adapter may
 * read only currently configured destinations, and must bound returned bytes. */
export class StorageAliases {
  constructor({ directory, isCurrent, readCurrent, withDigests = (_digests, run) => run(), limits = {}, fault }) {
    if (!directory || typeof isCurrent !== 'function' || typeof readCurrent !== 'function') fail('Provide a private directory and current storage adapter');
    const defaults = { aliases: BACKUP_ASSET_LIMITS.locations, operations: 4096, inputBytes: 8 * 1024 * 1024, journalBytes: 128 * 1024 * 1024, objectBytes: BACKUP_ASSET_LIMITS.objectBytes, verifiedBytes: 2 * 1024 * 1024 * 1024 };
    for (const [key, value] of Object.entries(limits)) if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) fail('Storage alias limits can only be reduced');
    Object.assign(this, { directory, isCurrent, readCurrent, withDigests, fault, limits: { ...defaults, ...limits }, path: join(directory, 'storage-aliases.json'), aliases: new Map(), operations: new Map(), tail: Promise.resolve(), ready: false });
  }
  mapping(input) {
    if (!plain(input) || Object.getOwnPropertySymbols(input).length || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !('value' in d)) || Object.keys(input).length > this.limits.aliases) fail('Aliases must be a bounded plain map without accessors or inherited entries');
    const entries = Object.entries(input); if (!entries.length) fail('Alias operation input exceeds its bound');
    for (const [source, target] of entries) { const from = storageAliasLocation(source), to = storageAliasLocation(target); if (from.digest !== to.digest || !this.isCurrent(target)) fail('Storage aliases must preserve the exact digest and target current configured storage'); }
    if (Buffer.byteLength(JSON.stringify(input)) > this.limits.inputBytes) fail('Alias operation input exceeds its bound');
    return orderedMap(entries);
  }
  async open() {
    const stat = await lstat(this.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Storage aliases need a private instance directory');
    const raw = await boundedFile(this.path, this.limits.journalBytes);
    if (!raw) { this.aliases = new Map(); this.operations = new Map(); this.ready = true; return this; }
    let saved; try { saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { fail('Storage alias journal is corrupt'); }
    if (!exact(saved, ['format', 'aliases', 'operations', 'digest']) || saved.format !== format || !Array.isArray(saved.aliases) || saved.aliases.length > this.limits.aliases || !Array.isArray(saved.operations) || saved.operations.length > this.limits.operations || !hex(saved.digest)) fail('Invalid bounded storage alias journal');
    const body = { format: saved.format, aliases: saved.aliases, operations: saved.operations }; if (hash(JSON.stringify(body)) !== saved.digest) fail('Storage alias journal integrity check failed');
    const aliases = new Map(), operations = new Map();
    for (const row of saved.aliases) {
      if (!exact(row, ['source', 'target', 'digest', 'bytes']) || !hex(row.digest) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > this.limits.objectBytes || aliases.has(row.source)) fail('Invalid persisted storage alias');
      if (storageAliasLocation(row.source).digest !== row.digest || storageAliasLocation(row.target).digest !== row.digest || !this.isCurrent(row.target)) fail('Persisted storage alias destination is outside current configured storage'); aliases.set(row.source, Object.freeze({ ...row }));
    }
    const ownedSources = new Set();
    for (const row of saved.operations) {
      if (!exact(row, ['operation', 'inputDigest', 'aliasesDigest', 'sources']) || typeof row.operation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,127}$/.test(row.operation) || operations.has(row.operation) || !hex(row.inputDigest) || !hex(row.aliasesDigest) || !Array.isArray(row.sources) || row.sources.length > this.limits.aliases || new Set(row.sources).size !== row.sources.length || row.sources.some(source => !aliases.has(source))) fail('Invalid persisted alias operation');
      const map = orderedMap(row.sources.map(source => [source, aliases.get(source).target])); if (hash(JSON.stringify(map)) !== row.aliasesDigest) fail('Storage alias operation disagrees with installed map'); for (const source of row.sources) ownedSources.add(source); operations.set(row.operation, Object.freeze({ ...row }));
    }
    if ([...aliases].some(([source, row]) => source !== row.target && aliases.has(row.target) && aliases.get(row.target).target !== row.target) || [...aliases.keys()].some(source => !ownedSources.has(source))) fail('Storage alias chains or unowned aliases are forbidden');
    this.aliases = aliases; this.operations = operations; this.ready = true; return this;
  }
  get(location) { if (!this.ready) fail('Open storage aliases before use'); return this.aliases.get(location); }
  retainsDigest(digest) { if (!this.ready) fail('Open storage aliases before use'); return [...this.aliases.values()].some(row => row.digest === digest); }
  async read(location) {
    const row = this.get(location); if (!row) return null;
    if (!this.isCurrent(row.target)) fail('Storage alias destination configuration changed');
    const bytes = await this.readCurrent(row.target, { maxBytes: this.limits.objectBytes });
    if (!bytes || bytes.length !== row.bytes || hash(bytes) !== row.digest) fail('Storage alias destination failed full content verification', 'STORAGE_ALIAS_INTEGRITY');
    return bytes;
  }
  install(input) { const task = this.tail.then(() => this.installNow(input)); this.tail = task.catch(() => {}); return task; }
  async acquireLock(input) {
    const path = join(this.directory, 'storage-aliases.lock'), captured = await captureCurrentProcessReceipt({ directory: this.directory });
    const bytes = Buffer.from(JSON.stringify({ format: 'ink-os-storage-alias-lock-v1', operation: input.operation, inputDigest: input.inputDigest, owner: captured.receipt || null }));
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const original = await boundedFile(path, 4096); let saved;
      try { saved = JSON.parse(original); } catch { fail('Alias lock ownership is ambiguous; inspect its journal', 'STORAGE_ALIAS_LOCKED'); }
      if (saved?.format !== 'ink-os-storage-alias-lock-v1' || !saved.owner) fail('Alias lock has no authoritative owner receipt', 'STORAGE_ALIAS_LOCKED');
      const owner = await checkProcessReceipt(saved.owner, { directory: this.directory });
      if (!owner.verified || !['gone', 'different-process'].includes(owner.state)) fail('Another alias owner is live, foreign or unverified', 'STORAGE_ALIAS_LOCKED');
      // An exclusive hard-link claim serializes recovery of these exact old
      // bytes. Take over the existing inode rather than unlinking a lock that
      // another process could already have replaced. Partial/unknown claims
      // stay blocked for operator review; no numeric-PID-only recovery occurs.
      const claim = path + '.' + hash(original) + '.claim'; let claimed = false;
      try {
        try { await link(path, claim); claimed = true; } catch { fail('Alias lock recovery is already claimed or ambiguous', 'STORAGE_ALIAS_LOCKED'); }
        const current = await boundedFile(path, 4096), linked = await boundedFile(claim, 4096), left = await lstat(path), right = await lstat(claim);
        if (!current?.equals(original) || !linked?.equals(original) || left.dev !== right.dev || left.ino !== right.ino) fail('Alias lock owner changed during recovery', 'STORAGE_ALIAS_LOCKED');
        const again = await checkProcessReceipt(saved.owner, { directory: this.directory });
        if (!again.verified || !['gone', 'different-process'].includes(again.state)) fail('Alias lock ownership changed during recovery', 'STORAGE_ALIAS_LOCKED');
        handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW); const held = await handle.stat();
        if (held.dev !== right.dev || held.ino !== right.ino) fail('Alias lock inode changed during recovery', 'STORAGE_ALIAS_LOCKED');
        await handle.truncate(0); await handle.writeFile(bytes); await handle.sync(); await syncDirectory(this.directory);
      } catch (error) { await handle?.close(); handle = null; throw error; }
      finally { if (claimed) await unlink(claim); }
      return handle;
    }
    try { await handle.writeFile(bytes); await handle.sync(); await syncDirectory(this.directory); return handle; }
    catch (e) { await handle.close(); await unlink(path); throw e; }
  }
  async installNow(input) {
    if (!exact(input, ['operation', 'inputDigest', 'aliases']) || typeof input.operation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,127}$/.test(input.operation) || !hex(input.inputDigest)) fail('Provide an explicit alias operation and source input digest');
    const mapping = this.mapping(input.aliases), aliasesDigest = hash(JSON.stringify(mapping)), digests = [...new Set(Object.keys(mapping).map(source => storageAliasLocation(source).digest))].sort();
    const lockPath = join(this.directory, 'storage-aliases.lock'), lock = await this.acquireLock(input);
    try {
      await this.open();
      const prior = this.operations.get(input.operation);
      if (prior) { if (prior.inputDigest !== input.inputDigest || prior.aliasesDigest !== aliasesDigest) fail('Alias operation identity already belongs to different inputs', 'STORAGE_ALIAS_CONFLICT'); return { operation: prior.operation, inputDigest: prior.inputDigest, aliasesDigest, aliases: prior.sources.length, replayed: true }; }
      if (this.operations.size >= this.limits.operations) fail('Storage alias operation bound exceeded');
      const entries = Object.entries(mapping);
      for (const [source, target] of entries) { const old = this.aliases.get(source); if (old && old.target !== target || target !== source && (this.aliases.has(target) && this.aliases.get(target).target !== target || Object.hasOwn(mapping, target) && mapping[target] !== target)) fail('Storage alias conflict or chain', 'STORAGE_ALIAS_CONFLICT'); }
      if (new Set([...this.aliases.keys(), ...Object.keys(mapping)]).size > this.limits.aliases) fail('Storage alias count bound exceeded');
      return await this.withDigests(digests, async () => {
        const proofs = new Map(); let verifiedBytes = 0;
        const verify = async (location, allowMissing = false) => {
          if (proofs.has(location)) return proofs.get(location);
          const bytes = await this.readCurrent(location, { maxBytes: this.limits.objectBytes, allowMissing }); if (bytes === null && allowMissing) { proofs.set(location, null); return null; }
          if (!bytes || bytes.length > this.limits.objectBytes) fail('Storage alias destination exceeds its byte bound');
          verifiedBytes += bytes.length; if (verifiedBytes > this.limits.verifiedBytes) fail('Storage alias aggregate verification bound exceeded');
          const digest = storageAliasLocation(location).digest; if (hash(bytes) !== digest) fail('Storage alias destination failed full content verification', 'STORAGE_ALIAS_INTEGRITY');
          const proof = { digest, bytes: bytes.length }; proofs.set(location, proof); return proof;
        };
        const aliases = new Map(this.aliases);
        for (const [source, target] of entries) { const proof = await verify(target); if (source !== target && this.isCurrent(source)) await verify(source, true); aliases.set(source, Object.freeze({ source, target, ...proof })); }
        const operations = new Map(this.operations), operation = { operation: input.operation, inputDigest: input.inputDigest, aliasesDigest, sources: Object.keys(mapping) }; operations.set(input.operation, Object.freeze(operation));
        const body = { format, aliases: [...aliases.values()].sort((a, b) => compare(a.source, b.source)), operations: [...operations.values()].sort((a, b) => compare(a.operation, b.operation)) }, bytes = Buffer.from(JSON.stringify({ ...body, digest: hash(JSON.stringify(body)) }));
        if (bytes.length > this.limits.journalBytes) fail('Storage alias journal byte bound exceeded');
        const temporary = this.path + '.' + randomBytes(12).toString('hex') + '.partial'; let f;
        try { f = await open(temporary, 'wx', 0o600); await f.writeFile(bytes); await f.sync(); await f.close(); f = null; await rename(temporary, this.path); await this.fault?.('journal-renamed'); await syncDirectory(this.directory); } finally { await f?.close(); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        this.aliases = aliases; this.operations = operations;
        return { operation: operation.operation, inputDigest: operation.inputDigest, aliasesDigest, aliases: entries.length, verifiedBytes, replayed: false };
      });
    } finally { await lock.close(); await unlink(lockPath); await syncDirectory(this.directory); }
  }
}
