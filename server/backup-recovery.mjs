import { constants } from 'node:fs';
import { open, lstat, mkdir, mkdtemp, realpath, readdir, rename, rm, chmod, unlink, opendir } from 'node:fs/promises';
import { resolve, dirname, basename, join, posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBackup, restoreBackup } from './backup-store.mjs';
import { gitRuntime } from './git-runtime.mjs';

const execute = promisify(execFile);
async function smallJSON(path, optional = false) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Recovery metadata must be a regular file of at most 1 MiB');
    const buffer = Buffer.alloc(stat.size + 1); let bytesRead = 0;
    while (bytesRead < buffer.length) { const part = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead); if (!part.bytesRead) break; bytesRead += part.bytesRead; }
    if (bytesRead !== stat.size) throw Error('Recovery metadata changed while reading');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  finally { await file?.close(); }
}
async function selectedPath(path) {
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), basename(absolute));
}
async function syncDirectory(path) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }

/** Probe only the saved loopback health endpoint, without credentials. The
 * explicit offline assertion remains necessary: absent metadata/refused TCP is
 * not proof of global quiescence, and stale PID values are never used to decide
 * whether a process is this instance. Reachable/ambiguous hosts fail closed. */
export async function assertOfflineInstance({ directory, fetcher = fetch, timeoutMs = 1500 } = {}) {
  const identity = await smallJSON(join(directory, 'instance.json'), true);
  const client = await smallJSON(join(directory, 'client.json'), true);
  if (identity && (identity.schema !== 1 || !/^[a-f0-9]{32}$/.test(identity.id || '') || typeof identity.adminToken !== 'string' || identity.adminToken.length < 32 || typeof identity.environmentKey !== 'string' || Buffer.from(identity.environmentKey, 'base64').length !== 32 || Buffer.from(identity.environmentKey, 'base64').toString('base64') !== identity.environmentKey)) throw Error('Invalid private instance identity; restore its original keys before recovery');
  if (!client) return { status: 'no-saved-address', verifiedStopped: false };
  if (!identity || typeof identity.id !== 'string' || client.instanceId !== identity.id) throw Error('Saved host metadata does not match the private instance identity');
  let url;
  try { url = new URL(client.url); } catch { throw Error('Invalid saved host address; correct its connection metadata before offline recovery'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Invalid saved host address');
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) return { status: 'nonlocal-address-not-probed', verifiedStopped: false };
  let response;
  try { response = await fetcher(new URL('/api/health', url).href, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED') return { status: 'saved-loopback-refused', verifiedStopped: false };
    throw Error('Saved host did not answer conclusively; stop the instance and retry offline recovery');
  }
  let health;
  try {
    let size = 0; const chunks = [];
    for await (const chunk of response.body || []) { size += chunk.length; if (size > 8192) throw Error('Health response exceeds bound'); chunks.push(Buffer.from(chunk)); }
    health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw Error('Saved host answered ambiguously; offline recovery was refused'); }
  if (response.ok && health?.instanceId === identity.id) throw Error('This instance host is still live; stop it before offline backup or recovery');
  throw Error('Saved address belongs to another or unidentified service; offline recovery was refused without sending credentials');
}

/** Stopped-instance creation. Does not stop workers or establish a live barrier. */
export async function createStoppedBackup({ directory, archive, password, offline = false, limits, fetcher } = {}) {
  if (offline !== true) throw Error('Stop the instance host and explicitly specify offline:true');
  directory = await realpath(directory); archive = await selectedPath(archive);
  const offlineCheck = await assertOfflineInstance({ directory, fetcher });
  return { ...await createBackup({ directory, archive, password, offline: true, limits }), offlineCheck };
}

function portableAbsolute(path) {
  if (typeof path !== 'string' || /[\x00-\x1f\x7f]/.test(path)) throw Error('Invalid authenticated original instance root');
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  if (!normalized || !normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized) || posix.normalize(normalized) !== normalized) throw Error('Invalid authenticated original instance root');
  return normalized;
}
function mappingPath(path) {
  if (typeof path !== 'string' || !path.startsWith('projects/') || /[\\:\x00-\x1f\x7f]/.test(path) || posix.normalize(path) !== path || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe authenticated managed project mapping');
  return path;
}
async function targetState(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(directory)).length) throw Error('Recovery target must be absent or an empty directory without symlinks');
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function retire(path) {
  async function unlock(directory) { await chmod(directory, 0o700); for await (const entry of await opendir(directory)) if (entry.isDirectory()) await unlock(join(directory, entry.name)); }
  await unlock(path).catch(() => {}); await rm(path, { recursive: true, force: true });
}

/** Restore raw bytes inside a private sibling envelope, then rebind only
 * authenticated managed project roots and exact generated Git hooks paths.
 * External project paths and application/checkpoint/credential bytes stay
 * untouched. client.json is removed; initializeInstance renews it on boot.
 * Caller exclusively controls the destination parent during final publication.
 * Remote assets/environment-provided keys still need explicit materialization.
 */
export async function recoverBackup({ directory, archive, password, offline = false, limits, fetcher, git = gitRuntime().executable } = {}) {
  if (offline !== true) throw Error('Stop the instance host and explicitly specify offline:true');
  directory = await selectedPath(directory); archive = await selectedPath(archive);
  const initial = await targetState(directory), parent = dirname(directory);
  let envelope;
  try {
    envelope = await mkdtemp(join(parent, '.ink-recovery-')); await chmod(envelope, 0o700);
    const payload = join(envelope, 'instance');
    const restored = await restoreBackup({ directory: payload, archive, password, limits });
    const modes = new Map();
    async function writable(path, directory = true) {
      if (modes.has(path)) return;
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error('Recovery paths must remain regular private files/directories');
      const mode = stat.mode & 0o777; modes.set(path, mode); await chmod(path, mode | (directory ? 0o700 : 0o600));
    }
    await writable(payload);
    const offlineCheck = await assertOfflineInstance({ directory: payload, fetcher });
    const source = restored.source;
    if (!source || !Array.isArray(source.managedProjects)) throw Error('Backup lacks authenticated project recovery mappings');
    const originalRoot = portableAbsolute(source.instanceRoot), mappings = new Map(), paths = new Set();
    for (const mapping of source.managedProjects) {
      if (!mapping || typeof mapping.id !== 'string' || !mapping.id || mappings.has(mapping.id)) throw Error('Duplicate or invalid authenticated project identity');
      const path = mappingPath(mapping.archivePath);
      if (portableAbsolute(mapping.directory) !== originalRoot + '/' + path || paths.has(path)) throw Error('Authenticated project root mapping mismatch');
      mappings.set(mapping.id, mapping); paths.add(path);
    }
    const catalogPath = join(payload, 'projects.json'), catalog = await smallJSON(catalogPath, true);
    const rebasedProjects = [], rebasedHooks = [], externalProjects = [], customHooks = [];
    const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), ...gitRuntime().environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const config = async (path, args) => {
      try { return (await execute(git, ['config', '--file', path, '--no-includes', ...args], { env: environment, encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout; }
      catch (error) { if (error.code === 1 && args.includes('--get-all')) return ''; throw Error('Managed Git configuration could not be safely rebound'); }
    };
    if (catalog !== undefined && (!catalog || typeof catalog !== 'object' || Array.isArray(catalog))) throw Error('Invalid restored project catalog');
    for (const [id, project] of Object.entries(catalog || {})) {
      if (!project || typeof project !== 'object') throw Error('Invalid restored project record');
      if (project.managed !== true) { externalProjects.push(id); continue; }
      const mapping = mappings.get(id);
      if (!mapping || project.id !== id || project.directory !== mapping.directory) throw Error('Restored project catalog does not match its authenticated mapping');
      mappings.delete(id);
      const parts = mapping.archivePath.split('/');
      for (let depth = 1; depth <= parts.length; depth++) await writable(join(payload, ...parts.slice(0, depth)));
      const local = join(payload, ...parts), gitDirectory = join(local, '.git');
      await writable(gitDirectory); // Reject linked worktree .git pointer files.
      for (const path of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
        try { if ((await lstat(join(gitDirectory, path))).size) throw Error('Managed Git project depends on external object/worktree storage'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const configPath = join(gitDirectory, 'config'); await writable(configPath, false);
      if ((await lstat(configPath)).size > 1024 * 1024) throw Error('Managed Git configuration exceeds the 1 MiB recovery bound');
      const hooks = (await config(configPath, ['--null', '--get-all', 'core.hooksPath'])).split('\0').filter(Boolean);
      const oldHooks = originalRoot + '/projects/.hooks';
      for (const value of new Set(hooks)) {
        if (value.replaceAll('\\', '/') === oldHooks) { await config(configPath, ['--fixed-value', '--replace-all', 'core.hooksPath', join(directory, 'projects', '.hooks'), value]); rebasedHooks.push(id); }
        else customHooks.push(id);
      }
      project.directory = join(directory, ...parts); rebasedProjects.push(id);
    }
    if (mappings.size || externalProjects.length !== source.externalProjectCount) throw Error('Restored project catalog coverage does not match authenticated metadata');
    if (catalog !== undefined && rebasedProjects.length) {
      await writable(catalogPath, false);
      const file = await open(catalogPath, 'w'); try { await file.writeFile(JSON.stringify(catalog)); await file.sync(); } finally { await file.close(); }
    }
    const removedConnectionFiles = [];
    try { await unlink(join(payload, 'client.json')); removedConnectionFiles.push('client.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [path, mode] of [...modes].reverse()) {
      if ((await lstat(path)).isFile()) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
      else await syncDirectory(path);
      await chmod(path, mode);
    }
    const now = await targetState(directory);
    if (!!initial !== !!now || initial && (initial.dev !== now.dev || initial.ino !== now.ino)) throw Error('Recovery target changed before publication');
    await rename(payload, directory); await syncDirectory(parent);
    return { ...restored, recovery: { rebasedProjects, rebasedHooks, externalProjects, customHooks, removedConnectionFiles, offlineCheck } };
  } finally { if (envelope) await retire(envelope); }
}
