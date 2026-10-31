import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';

export async function initializeInstance({ directory = '.data', port = 4318 } = {}) {
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
      id: randomBytes(16).toString('hex'),
      adminToken: randomBytes(32).toString('base64url'),
      environmentKey: randomBytes(32).toString('base64'),
    };
    try { await writeFile(path, JSON.stringify(fresh), { flag: 'wx', mode: 0o600, flush: true }); }
    catch (conflict) { if (conflict.code !== 'EEXIST') throw conflict; }
    settings = JSON.parse(await readFile(path, 'utf8'));
  }
  if (settings.schema !== 1 || typeof settings.adminToken !== 'string' || settings.adminToken.length < 32 || Buffer.from(settings.environmentKey || '', 'base64').length !== 32) {
    throw Error('Invalid instance identity. Restore its original private instance.json.');
  }
  await chmod(path, 0o600);
  const clientPath = join(directory, 'client.json');
  await writeFile(clientPath, JSON.stringify({ url: process.env.INK_OS_ORIGIN || `http://127.0.0.1:${port}`, token: process.env.INK_OS_ADMIN_TOKEN || settings.adminToken }), { mode: 0o600, flush: true });
  return { ...settings, directory, clientPath };
}
