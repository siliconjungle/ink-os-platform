import { hostBudget, WORKER_MEMORY_MB } from './execution-budget.mjs';
import { Worker } from 'node:worker_threads';
import { compilerModule } from './ink-compiler.mjs';

export async function javascriptResident(compiled, { timeout = 30000 } = {}) {
  const worker = new Worker(
    new URL('./ink-resident-worker.mjs', import.meta.url),
    {
      workerData: {
        artifact: compiled.artifact,
        // Generated learn-hole entries are callable only through code.run's
        // `learned` path (server/ink-learned.mjs), which checks them first.
        entries: [
          ...compiled.entries,
          ...(compiled.artifact.manifest.state?.actions || [])
            .filter((a) => /^(__learn_get|__learn_set|__objective_[A-Za-z_][A-Za-z0-9_]*)$/.test(a.name))
            .map((a) => ({ ...a, action: true })),
        ],
        compiler: (await compilerModule()).module,
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    },
  );
  let pending, failed;
  const fail = (error) => {
    failed = error;
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.reject(error);
    }
  };
  worker.on('error', fail);
  worker.on('exit', (code) =>
    fail(Error('Resident Ink worker exited (' + code + ').')),
  );
  worker.on('message', (message) => {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    worker.unref();
    // Private, opt-in benchmark telemetry never enters the Ink result or journal.
    try { current.diagnostic?.(message.trace || []); } catch {}
    message.error
      ? current.reject(Error(message.error))
      : current.resolve(message.value);
  });
  worker.unref();
  return {
    request(message) {
      if (failed) return Promise.reject(failed);
      if (pending)
        return Promise.reject(
          Error('Resident Ink requests must be serialized.'),
        );
      worker.ref();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(Error('Ink operation exceeded its execution time limit.'));
          void worker.terminate();
        }, timeout);
        pending = { resolve, reject, timer, diagnostic: this.onDiagnostic };
        worker.postMessage(this.onDiagnostic ? { ...message, trace: true } : message);
      });
    },
    close() {
      fail(Error('Resident Ink worker was evicted.'));
      return worker.terminate();
    },
  };
}

export class InkResidents {
  constructor({
    limit = 4,
    idleMs = 30000,
    timeout = 30000,
    budget = hostBudget,
  } = {}) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 8 ||
      !Number.isFinite(idleMs) ||
      idleMs < 1 ||
      !Number.isFinite(timeout) ||
      timeout < 1
    )
      throw Error('Invalid resident Ink limits.');
    this.budget = budget;
    this.unregisterReclaimer = budget.registerReclaimer(async () => {
      const idle = [...this.sessions.values()]
        .filter((session) => !session.busy)
        .sort((a, b) => a.used - b.used)[0];
      if (!idle) return false;
      await this.drop(idle);
      return true;
    });
    Object.assign(this, {
      limit,
      idleMs,
      timeout,
      sessions: new Map(),
      starts: 0,
      closed: false,
    });
  }
  async acquire(key, create, { owner = 'ink', signal, pooled = false } = {}) {
    if (pooled) {
      const lane = Array.from(
        { length: this.limit },
        (_, n) => key + ':' + n,
      ).find((key) => !this.sessions.get(key)?.busy);
      if (!lane)
        throw Object.assign(Error('Resident Ink capacity is busy'), {
          status: 429,
        });
      key = lane;
    }
    if (this.closed)
      throw Object.assign(Error('Ink execution is stopping.'), { status: 503 });
    let session = this.sessions.get(key);
    if (session?.busy)
      throw Object.assign(Error('Resident Ink instance is busy.'), {
        status: 429,
      });
    if (!session) {
      let eviction;
      if (this.sessions.size >= this.limit) {
        const idle = [...this.sessions.values()]
          .filter((item) => !item.busy)
          .sort((a, b) => a.used - b.used)[0];
        if (!idle)
          throw Object.assign(
            Error('Resident Ink capacity is busy; retry the request.'),
            { status: 429 },
          );
        eviction = this.drop(idle);
      }
      session = { key, busy: true, used: Date.now() };
      this.sessions.set(key, session);
      try {
        await eviction;
        session.memoryLease = await this.budget.acquire({
          owner,
          resources: { memoryMB: WORKER_MEMORY_MB },
          signal,
          label: 'resident memory',
        });
        session.endpoint = await this.budget.run(
          { owner, resources: { cpu: 1 }, signal, label: 'resident startup' },
          () => create({ timeout: this.timeout }),
        );
        if (this.closed || this.sessions.get(key) !== session) {
          throw Error('Ink execution is stopping.');
        }
        this.starts++;
      } catch (error) {
        await this.drop(session);
        throw error;
      }
    } else {
      clearTimeout(session.timer);
      session.busy = true;
    }
    return session;
  }
  release(session) {
    if (this.sessions.get(session.key) !== session) return;
    session.busy = false;
    session.used = Date.now();
    session.timer = setTimeout(
      () => void this.drop(session).catch(() => {}),
      this.idleMs,
    );
    session.timer.unref();
    this.budget.notify();
  }
  async drop(session) {
    if (this.sessions.get(session.key) === session)
      this.sessions.delete(session.key);
    clearTimeout(session.timer);
    try {
      await session.endpoint?.close();
    } catch (error) {
      this.budget.poison(error);
      throw error;
    }
    session.memoryLease?.release();
  }
  async close() {
    this.closed = true;
    this.unregisterReclaimer();
    await Promise.all(
      [...this.sessions.values()].map((session) => this.drop(session)),
    );
  }
}
