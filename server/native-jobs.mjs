import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { captureProcessReceipt, checkProcessReceipt } from './process-receipt.mjs';

const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const active = new Set(['queued', 'running', 'recovering']);

export class NativeJobs {
  constructor(directory, { native, source, enabled = true, captureProcess = captureProcessReceipt, checkProcess = checkProcessReceipt }) {
    Object.assign(this, { directory, native, source, enabled, captureProcess, checkProcess });
    this.path = join(directory, 'native-jobs.json'); this.jobs = []; this.tail = Promise.resolve(); this.accepting = true;
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.some(job => !/^[a-f0-9]{32}$/.test(job.id) || !/^[a-f0-9]{32}$/.test(job.appId) || !/^[a-f0-9]{32}$/.test(job.releaseId) || !/^[a-f0-9]{64}$/.test(job.compatibilityKey))) throw Error('Invalid native build queue.');
      this.jobs = saved.jobs;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.jobs.some(job => job.status === 'running')) await this.change(jobs => { for (const job of jobs) if (job.status === 'running') job.status = 'recovering'; });
    if (!this.enabled && this.jobs.some(job => job.status === 'queued')) await this.change(jobs => { for (const job of jobs) if (job.status === 'queued') Object.assign(job, { status: 'interrupted', error: 'Native compilation is disabled for this host.' }); });
    await this.reconcile(); void this.pump();
    return this;
  }
  change(update) {
    const task = this.tail.then(async () => {
      const draft = structuredClone(this.jobs), result = update(draft);
      await writeFile(this.path + '.next', JSON.stringify({ version: 1, jobs: draft }), { mode: 0o600, flush: true });
      await rename(this.path + '.next', this.path);
      if (process.platform !== 'win32') { const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      this.jobs = draft; return structuredClone(result);
    });
    this.tail = task.catch(() => {}); return task;
  }
  visible(job) { const { pid, processReceipt, processReceiptState, artifactId, ...result } = job; return { ...result, ...(artifactId ? { artifactId } : {}) }; }
  list(appId) { return this.jobs.filter(job => job.appId === appId).map(job => this.visible(job)); }
  get(appId, id) { const job = this.jobs.find(job => job.id === id && job.appId === appId); if (!job) fail(404, 'Native build not found.'); return this.visible(job); }
  async status() {
    const toolchain = this.enabled ? await this.native.availability() : { available: false, reason: 'Native compilation is disabled for this host.' };
    return { ...toolchain, buildAvailable: Boolean(toolchain.available || toolchain.installable), readyArtifacts: this.jobs.filter(job => job.status === 'succeeded').length, active: this.jobs.filter(job => active.has(job.status)).length, ...(this.error ? { error: this.error } : {}) };
  }
  async enqueue(appId, releaseId) {
    if (!/^[a-f0-9]{32}$/.test(appId || '') || !/^[a-f0-9]{32}$/.test(releaseId || '')) fail(400, 'Choose an application and an Ink source release.');
    if (!this.accepting) fail(503, 'This host is draining its background jobs.');
    if (!this.enabled) fail(503, 'Native compilation is disabled for this host.');
    const source = await this.source(appId, releaseId), context = await this.native.compatibility(source, appId);
    const previous = this.jobs.findLast(job => job.appId === appId && job.compatibilityKey === context.compatibilityKey && ['queued', 'running', 'recovering', 'succeeded'].includes(job.status));
    if (previous) {
      if (previous.status !== 'succeeded') return this.visible(previous);
      try { await this.native.record(previous.artifactId, appId); return this.visible(previous); }
      catch (error) { await this.patch(previous.id, { status: 'failed', error: error.message, finishedAt: Date.now() }); }
    }
    const plan = await this.native.plan(source, appId, context.artifact);
    const job = await this.change(jobs => {
      if (!this.accepting) fail(503, 'This host is draining its background jobs.');
      const existing = jobs.findLast(job => job.appId === appId && job.compatibilityKey === plan.compatibilityKey && ['queued', 'running', 'recovering', 'succeeded'].includes(job.status));
      if (existing) return existing;
      if (jobs.filter(job => active.has(job.status)).length >= 32) fail(429, 'Native build queue is full.');
      const job = { id: randomBytes(16).toString('hex'), appId, releaseId, compatibilityKey: plan.compatibilityKey, artifactId: plan.id, sourceIdentity: plan.artifact.manifest.core_sha256, ...(plan.toolchain?.managed ? { toolchain: plan.toolchain } : {}), status: 'queued', createdAt: Date.now() };
      jobs.push(job); return job;
    });
    void this.pump(); return this.visible(job);
  }
  patch(id, changes) { return this.change(jobs => { const job = jobs.find(job => job.id === id); if (!job) fail(404, 'Native build not found.'); Object.assign(job, changes, { updatedAt: Date.now() }); return job; }); }
  async recordProcess(id, { pid, artifactId, child }) {
    const captured = await this.captureProcess({ pid, directory: this.directory, child });
    return this.patch(id, { pid, artifactId, processReceipt: captured.receipt || null, processReceiptState: captured.state });
  }
  async reconcile() {
    for (const job of this.jobs.filter(job => job.status === 'recovering')) {
      const worker = job.processReceipt || Number.isInteger(job.pid) && job.pid > 0 ? await this.checkProcess(job.processReceipt, { directory: this.directory, pid: job.pid }) : { state: 'gone', blocksCurrentRoot: false };
      if (job.workerState !== worker.state) await this.patch(job.id, { workerState: worker.state });
      if (['same-process', 'unverified'].includes(worker.state) && worker.blocksCurrentRoot !== false) continue;
      try { const record = await this.native.record(job.artifactId, job.appId); await this.patch(job.id, { status: 'succeeded', sourceIdentity: record.sourceIdentity, pid: null, processReceipt: null, processReceiptState: null, finishedAt: Date.now() }); }
      catch { await this.patch(job.id, { status: 'interrupted', error: 'The previous build host exited before publishing its artifact. Submit the build again to resume.', pid: null, processReceipt: null, processReceiptState: null, finishedAt: Date.now() }); }
    }
  }
  pump() {
    if (this.pumping) return this.pumping;
    this.pumping = this.execute().catch(error => { this.error = error.message; }).finally(() => {
      this.pumping = null;
      if (this.jobs.some(job => job.status === 'recovering')) { clearTimeout(this.timer); this.timer = setTimeout(() => void this.pump(), 500); this.timer.unref(); }
    });
    return this.pumping;
  }
  async execute() {
    await this.reconcile();
    if (!this.enabled) return;
    if (this.jobs.some(job => job.status === 'recovering')) return;
    for (;;) {
      const job = this.jobs.find(job => job.status === 'queued'); if (!job) return;
      await this.patch(job.id, { status: 'running', startedAt: Date.now() });
      try {
        const source = await this.source(job.appId, job.releaseId);
        const context = await this.native.compatibility(source, job.appId);
        if (context.compatibilityKey !== job.compatibilityKey) fail(409, 'The compiler or native runtime changed. Submit a fresh build.');
        if (job.toolchain?.managed && (await this.native.plan(source, job.appId, context.artifact)).id !== job.artifactId) throw Object.assign(Error('The pinned managed toolchain changed. Submit a fresh native build.'), { status: 409, code: 'INK_NATIVE_TOOLCHAIN_CHANGED' });
        const result = await this.native.build(source, { namespace: job.appId, onProcess: value => this.recordProcess(job.id, value), onStage: value => this.patch(job.id, value) });
        await this.patch(job.id, { status: 'succeeded', phase: 'ready', artifactId: result.id, sourceIdentity: result.sourceIdentity, cached: result.cached, pid: null, processReceipt: null, processReceiptState: null, finishedAt: Date.now() });
      } catch (error) { await this.patch(job.id, { status: 'failed', phase: 'failed', error: String(error.message).slice(0, 2000), ...(typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? { errorCode: error.code } : {}), pid: null, processReceipt: null, processReceiptState: null, finishedAt: Date.now() }); }
    }
  }
  async readyFor(appId, source, compiled) {
    if (!this.enabled || !this.jobs.some(job => job.appId === appId && job.status === 'succeeded')) return null;
    let context;
    try { context = await this.native.compatibility(source, appId, compiled); } catch (error) { if (error.status === 422) return null; throw error; }
    const job = this.jobs.findLast(job => job.appId === appId && job.status === 'succeeded' && job.compatibilityKey === context.compatibilityKey);
    if (!job) return null;
    try { await this.native.record(job.artifactId, appId); return job.artifactId; } catch (error) { if (error.code === 'ENOENT' || error.status === 409) return null; throw error; }
  }
  async close() {
    this.accepting = false; clearTimeout(this.timer);
    while (this.jobs.some(job => active.has(job.status))) { await this.pump(); if (this.error) throw Error(this.error); if (this.jobs.some(job => job.status === 'recovering')) await new Promise(resolve => setTimeout(resolve, 500)); }
    await this.tail; clearTimeout(this.timer);
  }
}
