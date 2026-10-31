import { mkdir, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BACKUP_ASSET_LIMITS as limits } from '../shared/backup-limits.mjs';
import { storageAliasLocation } from './storage-aliases.mjs';
import { privateBytes, privateJSON, writePrivateJSON } from './provider-bindings.mjs';

export const recoveryHash = value => createHash('sha256').update(value).digest('hex');
const format = 'ink-os-provider-recovery-v1', hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function recoveredAssets(directory, assets, expectedDigest) {
  if (assets?.format !== 'ink-os-backup-asset-closure-v1' || !/^\.ink-backup-assets-[a-f0-9]{32}\.json$/.test(assets.path) || !Number.isSafeInteger(assets.objects) || assets.objects < 0 || assets.objects > limits.objects || !Number.isSafeInteger(assets.locations) || assets.locations < 0 || assets.locations > limits.locations) throw Error('Provider recovery requires an authenticated complete asset manifest.');
  const raw = await privateBytes(join(directory, assets.path), limits.manifestBytes), digest = recoveryHash(raw), manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (expectedDigest && digest !== expectedDigest || manifest.format !== assets.format || !Array.isArray(manifest.objects) || manifest.objects.length !== assets.objects) throw Error('Recovered asset manifest identity changed.');
  const digests = new Set(), locations = new Set(); let bytes = 0;
  for (const row of manifest.objects) {
    if (!row || !hex(row.digest) || digests.has(row.digest) || row.path !== 'blobs/' + row.digest || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > limits.objectBytes || !Array.isArray(row.locations) || !row.locations.length || row.locations.length > limits.locations) throw Error('Invalid recovered asset entry.');
    digests.add(row.digest); bytes += row.bytes;
    for (const location of row.locations) { if (locations.has(location) || storageAliasLocation(location).digest !== row.digest) throw Error('Ambiguous recovered asset location.'); locations.add(location); }
    if (locations.size > limits.locations || bytes > limits.totalBytes) throw Error('Recovered asset manifest exceeds its bounds.');
  }
  if (locations.size !== assets.locations || bytes !== manifest.totalBytes) throw Error('Recovered asset coverage disagrees with its receipt.');
  return { digest, objects: manifest.objects, bytes, locations: locations.size };
}
export async function recoveredBlob(directory, row) {
  const bytes = await privateBytes(join(directory, row.path), limits.objectBytes);
  if (bytes.length !== row.bytes || recoveryHash(bytes) !== row.digest) throw Error('Recovered asset bytes failed content verification.');
  return bytes;
}
export function recoveryAliasJournal(objects, targets, operation, inputDigest) {
  const aliases = objects.flatMap(row => row.locations.map(source => ({ source, target: targets.get(row.digest), digest: row.digest, bytes: row.bytes }))).sort((a,b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
  for (const row of aliases) if (storageAliasLocation(row.target).digest !== row.digest) throw Error('Recovery alias target changed its digest.');
  const mapping = Object.fromEntries(aliases.map(row => [row.source, row.target]));
  const body = { format: 'ink-os-storage-aliases-v1', aliases, operations: aliases.length ? [{ operation, inputDigest, aliasesDigest: recoveryHash(JSON.stringify(mapping)), sources: aliases.map(row => row.source) }] : [] };
  const saved = { ...body, digest: recoveryHash(JSON.stringify(body)) };
  if (Buffer.byteLength(JSON.stringify(saved)) > 128 * 1024 * 1024) throw Error('Recovered alias journal exceeds its bound.');
  return saved;
}
export async function readRecoveryPlan(directory) {
  const plan = await privateJSON(join(directory, 'provider-recovery.json'), 1024 * 1024, true);
  if (!plan) return null;
  if (plan.format !== format || !/^[a-f0-9]{32}$/.test(plan.operation) || !/^[a-f0-9]{32}$/.test(plan.instanceId) || plan.auditDirectory !== '.provider-recovery-' + plan.operation || !['preserve','local','host'].includes(plan.storage?.provider) || !['preserved','pending','copying','complete'].includes(plan.storage?.state) || !['preserve','local','host'].includes(plan.runtime?.provider) || !['preserved','pending','complete'].includes(plan.runtime?.state)) throw Error('Invalid provider recovery plan.');
  const identity = await privateJSON(join(directory, 'instance.json'), 8192);
  if (identity?.id !== plan.instanceId) throw Error('Recovery plan belongs to a different instance.');
  return plan;
}

/** Called only in the authenticated unpublished recovery envelope. Source
 * provider authority is retained privately and never used for worker actions. */
export async function prepareProviderRecovery({ directory, restored, storage = 'preserve', runtime = 'preserve' }) {
  if (storage === 'preserve' && runtime === 'preserve') return null;
  const identity = await privateJSON(join(directory, 'instance.json'), 8192);
  if (!/^[a-f0-9]{32}$/.test(identity?.id)) throw Error('Provider recovery requires the original private instance identity.');
  for (const name of ['namespace-migrations/pending.json', 'automation-migrations/pending.json', 'restoration/pending.json', 'storage-aliases.lock']) {
    try { await lstat(join(directory, name)); throw Error('Resolve pending data migrations before changing recovery providers.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const previous = await readRecoveryPlan(directory);
  for (const [kind, choice] of [['storage',storage],['runtime',runtime]]) if (previous && choice === 'preserve' && !['preserved','complete'].includes(previous[kind].state)) throw Error('A previous provider recovery is still pending; choose that provider explicitly.');
  const manifest = storage === 'preserve' ? null : await recoveredAssets(directory, restored.assets);
  if (manifest) for (const row of manifest.objects) await recoveredBlob(directory, row);
  const operation = randomBytes(16).toString('hex'), auditDirectory = '.provider-recovery-' + operation;
  await mkdir(join(directory, auditDirectory), { mode: 0o700 });
  const preserved = [];
  for (const name of [...(storage === 'preserve' ? [] : ['storage.json','storage-aliases.json','storage-binding.json']), ...(runtime === 'preserve' ? [] : ['runtime-pool.json','runtime-pool.json.next','maintenance.json','runtime-binding.json']), 'provider-recovery.json']) {
    try {
      const file = await lstat(join(directory, name)); if (!file.isFile() || file.isSymbolicLink()) throw Error('Recovery provider authority must be regular private files.');
      await rename(join(directory, name), join(directory, auditDirectory, name)); preserved.push(name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const [kind, provider] of [['storage',storage],['runtime',runtime]]) if (provider !== 'preserve') await writePrivateJSON(directory, kind + '-binding.json', { format:'ink-os-provider-binding-v1',kind,provider,instanceId:identity.id,operation });
  if (manifest) await writePrivateJSON(directory, 'storage-aliases.json', recoveryAliasJournal(manifest.objects, new Map(manifest.objects.map(row => [row.digest, 'blob:' + row.digest])), operation, manifest.digest));
  const plan = { format, operation, instanceId:identity.id, auditDirectory, preserved, storage:{ provider:storage, state:storage === 'host' ? 'pending' : storage === 'local' ? 'complete' : 'preserved', ...(manifest ? { assets:restored.assets, manifestSha256:manifest.digest, objects:manifest.objects.length, locations:manifest.locations, bytes:manifest.bytes } : {}) }, runtime:{provider:runtime,state:runtime === 'preserve' ? 'preserved' : 'pending'} };
  await writePrivateJSON(directory, 'provider-recovery.json', plan);
  return { operation, auditDirectory, preserved, storage:{provider:storage,verifiedObjects:manifest?.objects.length || 0,bytes:manifest?.bytes || 0},runtime:{provider:runtime,rebindOnStartup:runtime !== 'preserve'} };
}
