import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function privateBytes(path, maxBytes, optional = false) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw Error('Provider recovery input exceeds its regular-file bound.');
    const bytes = Buffer.alloc(Number(before.size) + 1); let size = 0;
    while (size < bytes.length) { const part = await file.read(bytes, size, bytes.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
    const after = await file.stat({ bigint: true });
    if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error('Provider recovery input changed during reading.');
    return bytes.subarray(0, size);
  } catch (error) { if (optional && error.code === 'ENOENT' && !file) return null; throw error; }
  finally { await file?.close(); }
}
export async function privateJSON(path, maxBytes, optional = false) {
  const bytes = await privateBytes(path, maxBytes, optional);
  return bytes === null ? null : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export async function writePrivateJSON(directory, name, value) {
  if (!/^[A-Za-z0-9.-]+$/.test(name)) throw Error('Use one owned provider metadata filename.');
  const temporary = join(directory, '.' + name + '-' + randomBytes(12).toString('hex')), file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close();
    await rename(temporary, join(directory, name));
    const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  } finally { await file.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function readProviderBinding(directory, kind, expectedInstanceId) {
  if (!['storage', 'runtime'].includes(kind)) throw Error('Unknown provider binding.');
  const value = await privateJSON(join(directory, kind + '-binding.json'), 8192, true);
  if (value === null) return null;
  const providers = kind === 'storage' ? ['local', 'host', 'configured'] : ['local', 'host'];
  if (!value || Object.keys(value).sort().join(',') !== 'format,instanceId,kind,operation,provider' || value.format !== 'ink-os-provider-binding-v1' || value.kind !== kind || !providers.includes(value.provider) || !/^[a-f0-9]{32}$/.test(value.operation) || !/^[a-f0-9]{32}$/.test(value.instanceId)) throw Error('Invalid provider binding.');
  const identity = expectedInstanceId ? { id: expectedInstanceId } : await privateJSON(join(directory, 'instance.json'), 8192);
  if (identity?.id !== value.instanceId) throw Error('Provider binding belongs to a different instance.');
  return value;
}
export const unboundDeployment = value => value?.provider === 'unbound' && value.parked === true && /^[a-f0-9]{32}$/.test(value.recovery) && Object.keys(value).sort().join(',') === 'parked,provider,recovery';
