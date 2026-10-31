import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';

export async function initializeInstance({ directory = '.data', port = 4318, hostProcess = false, id, adminToken, environmentKey } = {}) {
  if (id !== undefined && !/^[a-f0-9]{32}$/.test(id)) throw Error('Declared instance ID must be 32 lowercase hexadecimal characters.');
  if (adminToken !== undefined && (typeof adminToken !== 'string' || adminToken.length < 32 || adminToken.length > 4096 || /[\r\n\0]/.test(adminToken))) throw Error('Declared admin credential is invalid.');
  if (environmentKey !== undefined && (typeof environmentKey !== 'string' || Buffer.from(environmentKey, 'base64').length !== 32 || Buffer.from(environmentKey, 'base64').toString('base64') !== environmentKey)) throw Error('Declared environment key must be canonical base64 for 32 bytes.');
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'instance.json');
  let settings;
  try {
    settings = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fresh = {
      schema: 1,
      id: id ?? randomBytes(16).toString('hex'),
      adminToken: adminToken ?? randomBytes(32).toString('base64url'),
      environmentKey: environmentKey ?? randomBytes(32).toString('base64'),
    };
    try { await writeFile(path, JSON.stringify(fresh), { flag: 'wx', mode: 0o600, flush: true }); }
    catch (conflict) { if (conflict.code !== 'EEXIST') throw conflict; }
    settings = JSON.parse(await readFile(path, 'utf8'));
  }
  if (settings.schema !== 1 || !/^[a-f0-9]{32}$/.test(settings.id || '') || typeof settings.adminToken !== 'string' || settings.adminToken.length < 32 || Buffer.from(settings.environmentKey || '', 'base64').length !== 32 || Buffer.from(settings.environmentKey, 'base64').toString('base64') !== settings.environmentKey) {
    throw Error('Invalid instance identity. Restore its original private instance.json.');
  }
  if (id !== undefined && settings.id !== id || adminToken !== undefined && settings.adminToken !== adminToken || environmentKey !== undefined && settings.environmentKey !== environmentKey) throw Error('Declared instance identity or credentials differ from persisted private state. Restore the matching configuration or perform an explicit credential migration.');
  await chmod(path, 0o600);
  const clientPath = join(directory, 'client.json');
  await writeFile(clientPath, JSON.stringify({ url: process.env.INK_OS_ORIGIN || `http://127.0.0.1:${port}`, token: settings.adminToken, instanceId: settings.id, ...(hostProcess ? { hostPid: process.pid } : {}) }), { mode: 0o600, flush: true });
  return { ...settings, directory, clientPath };
}
