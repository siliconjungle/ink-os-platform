import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createLiveBackup } from './snapshot-gate.mjs';

const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const states = new Set(['queued', 'running', 'ready', 'failed', 'interrupted', 'cancelled', 'deleting', 'deleted']);
const pending = value => ['queued', 'running'].includes(value.status);
async function syncDirectory(path) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }

/** One owned journal and encrypted archive directory, excluded from its own
 * snapshots. Passwords exist only in the active operation's memory. Restart
 * never advertises an interrupted writer or an uncommitted archive as ready. */
export class Backups {
  constructor({ gate, world, storage, instanceId, available = () => true, capture = createLiveBackup } = {}) {
    if (!gate || !world || !storage || !id(instanceId) || typeof available !== 'function') throw Error('Bind backups to one live instance and admission gate.');
    Object.assign(this, { gate, world, storage, instanceId, available, capture, directory: gate.directory, root: join(gate.directory, 'backups'), jobs: [], tail: Promise.resolve(), active: null, accepting: true });
  }
  async open() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw Error('Backup directory must be owned and private.');
    let file;
    try {
      file = await open(join(this.root, 'journal.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 2 * 1024 * 1024 || process.getuid && stat.uid !== process.getuid()) throw Error('Invalid private backup journal.');
      const bytes = Buffer.alloc(stat.size + 1); let size = 0;
      while (size < bytes.length) { const part = await file.read(bytes, size, bytes.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
      if (size !== stat.size) throw Error('Backup journal changed while reading.');
      const { digest, ...saved } = JSON.parse(bytes.subarray(0, size));
      if (saved.format !== 'ink-os-backup-jobs-v1' || saved.instanceId !== this.instanceId || digest !== sha(JSON.stringify(saved)) || !Array.isArray(saved.jobs) || saved.jobs.length > 128 || new Set(saved.jobs.map(job => job.id)).size !== saved.jobs.length || saved.jobs.some(job => !id(job.id) || !states.has(job.status) || !Number.isSafeInteger(job.createdAt) || !Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > 3600000 || typeof job.remoteAssets !== 'boolean' || job.status === 'ready' && (!/^[a-f0-9]{64}$/.test(job.sha256) || !Number.isSafeInteger(job.bytes) || job.bytes < 52))) throw Error('Backup journal integrity or identity is invalid.');
      this.jobs = saved.jobs;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await file?.close(); }
    await this.change(jobs => { for (const job of jobs) if (pending(job)) Object.assign(job, { status: 'interrupted', error: 'Host restarted before backup completion.', finishedAt: Date.now() }); });
    for (const job of this.jobs) if (job.status === 'deleting') await this.remove(job.id);
    return this;
  }
  change(fn) {
    const task = this.tail.then(async () => {
      const jobs = structuredClone(this.jobs), result = fn(jobs);
      const saved = { format: 'ink-os-backup-jobs-v1', instanceId: this.instanceId, jobs }, data = JSON.stringify({ ...saved, digest: sha(JSON.stringify(saved)) });
      if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw Error('Backup journal exceeds its bound.');
      const path = join(this.root, '.journal-' + randomBytes(12).toString('hex')), file = await open(path, 'wx', 0o600);
      try { await file.writeFile(data); await file.sync(); await file.close(); await rename(path, join(this.root, 'journal.json')); await syncDirectory(this.root); }
      finally { await file.close(); await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      this.jobs = jobs; return structuredClone(result);
    });
    this.tail = task.catch(() => {}); return task;
  }
  list() { return structuredClone(this.jobs); }
  get(operation) { if (!id(operation)) fail(400, 'Invalid backup operation ID.'); const job = this.jobs.find(job => job.id === operation); if (!job) fail(404, 'Backup job not found.'); return structuredClone(job); }
  get busy() { return !!this.active; }
  archive(operation) { if (!id(operation)) fail(400, 'Invalid backup operation ID.'); return join(this.root, operation + '.inkbak'); }
  async create({ operation, password, timeoutMs = 300000, remoteAssets = true } = {}) {
    if (!id(operation) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000 || typeof remoteAssets !== 'boolean') fail(400, 'Provide a backup operation ID, timeout and remote-asset choice.');
    const previous = this.jobs.find(job => job.id === operation);
    if (previous) {
      if (previous.timeoutMs !== timeoutMs || previous.remoteAssets !== remoteAssets) fail(409, 'Backup operation belongs to a different request.');
      return structuredClone(previous); // Never restart or replace an existing operation with a new password.
    }
    if ((typeof password !== 'string' && !Buffer.isBuffer(password)) || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 4096) fail(400, 'Backup password must contain 12–4096 bytes.');
    if (!this.accepting || this.error || !this.available()) fail(503, 'This host is closing admission or needs backup recovery.');
    if (this.active) fail(409, 'Another backup is active.');
    if (this.jobs.length >= 128) fail(409, 'Backup job limit reached; remove completed jobs first.');
    const secret = Buffer.from(password), controller = new AbortController();
    const active = { operation, controller, promise: null }; this.active = active;
    try {
      await this.change(jobs => jobs.push({ id: operation, status: 'queued', createdAt: Date.now(), timeoutMs, remoteAssets }));
      // Scheduling after the durable admission decision gives callers a job ID
      // without awaiting their own compute hold or the snapshot barrier.
      active.promise = this.run(active, secret, { timeoutMs, remoteAssets });
      active.promise.catch(error => { this.error = error; });
      return this.get(operation);
    } catch (error) { secret.fill(0); this.active = null; throw error; }
  }
  async run(active, secret, options) {
    const timer = setTimeout(() => active.controller.abort(new Error('Backup timeout.')), options.timeoutMs);
    let created = false;
    try {
      await this.change(jobs => { jobs.find(job => job.id === active.operation).status = 'running'; });
      const result = await this.capture({ gate: this.gate, world: this.world, storage: this.storage, directory: this.directory, archive: this.archive(active.operation), password: secret, signal: active.controller.signal, timeoutMs: options.timeoutMs, remoteAssets: options.remoteAssets, excludeBackupDirectory: true });
      created = true;
      await this.change(jobs => {
        active.controller.signal.throwIfAborted();
        Object.assign(jobs.find(job => job.id === active.operation), { status: 'ready', finishedAt: Date.now(), bytes: result.archiveBytes, sha256: result.archiveSha256, coverage: result.coverage, files: result.files, sourceBytes: result.bytes });
      });
    } catch {
      if (created) await unlink(this.archive(active.operation)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await this.change(jobs => Object.assign(jobs.find(job => job.id === active.operation), { status: active.controller.signal.aborted ? 'cancelled' : 'failed', error: active.controller.signal.aborted ? 'Backup cancelled or timed out.' : 'Backup did not complete; no archive is available.', finishedAt: Date.now() }));
    } finally { clearTimeout(timer); secret.fill(0); if (this.active === active) this.active = null; }
  }
  async cancel(operation) {
    this.get(operation);
    await this.change(jobs => {
      const job = jobs.find(job => job.id === operation);
      if (['cancelled', 'interrupted', 'failed'].includes(job.status)) return;
      if (!pending(job) || this.active?.operation !== operation) fail(409, 'Only an active backup can be cancelled.');
      this.active.controller.abort(new Error('Backup cancelled.'));
    });
    return this.get(operation);
  }
  async remove(operation) {
    this.get(operation);
    await this.change(jobs => { const job = jobs.find(job => job.id === operation); if (pending(job)) fail(409, 'Cancel and wait for the active backup first.'); job.status = 'deleting'; });
    await unlink(this.archive(operation)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await this.change(jobs => { const index = jobs.findIndex(job => job.id === operation); jobs.splice(index, 1); });
    return { id: operation, deleted: true };
  }
  async openArchive(operation) {
    const job = this.get(operation); if (job.status !== 'ready') fail(409, 'Backup is not ready.');
    const file = await open(this.archive(operation), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== job.bytes || stat.mode & 0o077) fail(503, 'Backup archive is unavailable or changed.'); return { file, job }; }
    catch (error) { await file.close(); throw error; }
  }
  stopAccepting() { this.accepting = false; }
  async whenIdle() { while (this.active) { const active = this.active; if (active.promise) await active.promise; else await this.tail; } await this.tail; }
}
