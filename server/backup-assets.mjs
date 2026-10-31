import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { storageAliasLocation } from './storage-aliases.mjs';

const format = 'ink-os-backup-asset-closure-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const defaults = { objects: 100000, locations: 200000, objectBytes: 64 * 1024 * 1024, totalBytes: 1024 ** 4, manifestBytes: 16 * 1024 * 1024 };
function limitsFor(input) {
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result)) if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) throw Error('Backup asset limits can only be reduced.');
  return result;
}
async function localBytes(path, limit) {
  let input;
  try { input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw Error('Backup asset exceeds its object byte limit.');
    const bytes = Buffer.alloc(Number(before.size) + 1); let size = 0;
    while (size < bytes.length) { const next = await input.read(bytes, size, bytes.length - size, size); if (!next.bytesRead) break; size += next.bytesRead; }
    const after = await input.stat({ bigint: true });
    if (size !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error('Backup asset changed during capture.');
    return bytes.subarray(0, size);
  } finally { await input.close(); }
}

/** Called only under the same host's acquired snapshot. Resolve the complete
 * retained World reference index plus installed aliases through current storage.
 * A former bucket is never consulted. Each unique digest is resolved with a
 * bounded, verified read before additional bytes enter the encrypted archive.
 */
export function backupAssetClosure({ world, storage, directory = storage?.directory, limits, manifestId = randomBytes(16).toString('hex') } = {}) {
  if (!world || !storage || typeof directory !== 'string' || typeof world.directory !== 'string' || typeof storage.directory !== 'string' || resolve(world.directory) !== resolve(storage.directory) || !(storage.aliases?.aliases instanceof Map) || !storage.aliases.ready || !(world.retiredBlobs instanceof Set)) throw Error('Provide the same opened World and current storage for backup assets.');
  if (!/^[a-f0-9]{32}$/.test(manifestId)) throw Error('Invalid backup asset manifest identity.');
  const bound = limitsFor(limits), byDigest = new Map(), locations = new Set();
  let nameBytes = 0;
  const add = location => {
    const parsed = storageAliasLocation(location);
    if (world.retiredBlobs.has(parsed.digest)) return;
    const target = storage.aliases.get(location)?.target || location;
    if (!storage.aliasIsCurrent(target) || storageAliasLocation(target).digest !== parsed.digest) throw Error('A retained backup asset has no current storage binding.');
    if (!locations.has(location)) {
      locations.add(location); nameBytes += Buffer.byteLength(location);
      if (locations.size > bound.locations || nameBytes > bound.manifestBytes) throw Error('Backup asset location limit exceeded.');
    }
    let entry = byDigest.get(parsed.digest);
    if (!entry) {
      if (byDigest.size >= bound.objects) throw Error('Backup asset object limit exceeded.');
      entry = { digest: parsed.digest, locations: new Set(), targets: new Set() }; byDigest.set(parsed.digest, entry);
    }
    entry.locations.add(location); entry.targets.add(target);
  };
  if (!world.blobRefs || typeof world.blobRefs !== 'object' || Array.isArray(world.blobRefs)) throw Error('Invalid retained backup asset index.');
  for (const refs of Object.values(world.blobRefs)) {
    if (!Array.isArray(refs)) throw Error('Invalid retained backup asset index.');
    for (const location of refs) add(location);
  }
  for (const object of world.all()) if (typeof object.location === 'string' && /^(blob:|r2:\/\/|s3:\/\/)/.test(object.location)) add(object.location);
  for (const row of storage.aliases.aliases.values()) { add(row.source); add(row.target); }
  const entries = [...byDigest.values()].sort((a,b)=>a.digest.localeCompare(b.digest));
  const path = '.ink-backup-assets-' + manifestId + '.json';
  const assets = { format, path, objects: entries.length, locations: locations.size };
  let consumed = false;
  async function* extraFiles() {
    if (consumed) throw Error('This backup asset stream was already consumed.'); consumed = true;
    try { await lstat(join(directory, path)); throw Error('Backup asset manifest path already exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const rows = []; let totalBytes = 0;
    for (const entry of entries) {
      const local = 'blobs/' + entry.digest;
      let bytes = await localBytes(join(directory, 'blobs', entry.digest), bound.objectBytes), archivedLocally = bytes !== null;
      if (bytes === null) for (const target of [...entry.targets].sort()) {
        bytes = await storage.readAliasCurrent(target, { maxBytes: bound.objectBytes, allowMissing: true });
        if (bytes !== null) break;
      }
      if (!(bytes instanceof Uint8Array) || bytes.length > bound.objectBytes || sha(bytes) !== entry.digest) throw Error('A retained backup asset is missing or failed content verification.');
      totalBytes += bytes.length;
      if (totalBytes > bound.totalBytes) throw Error('Backup asset total byte limit exceeded.');
      rows.push({ digest: entry.digest, bytes: bytes.length, path: local, locations: [...entry.locations].sort() });
      if (!archivedLocally) yield { path: local, mode: 0o600, size: bytes.length, sha256: entry.digest, chunks: [bytes] };
    }
    const manifest = Buffer.from(JSON.stringify({ format, objects: rows, totalBytes }));
    if (manifest.length > bound.manifestBytes) throw Error('Backup asset manifest byte limit exceeded.');
    yield { path, mode: 0o600, size: manifest.length, sha256: sha(manifest), chunks: [manifest] };
  }
  return { assets, extraFiles, coverage: { remoteAssets: true } };
}
