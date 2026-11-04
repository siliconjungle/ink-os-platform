import { Worker } from 'node:worker_threads';
import { hostBudget } from './execution-budget.mjs';

/** Serializes one opaque kernel session. The request deadline starts before
 * queueing; CPU/memory claims cover bootstrap and live work until retirement. */
export class ProofCompiler {
  constructor({ budget = hostBudget, idleMS = 10000 } = {}) {
    this.budget = budget;
    this.idleMS = idleMS;
    this.resident = null;
    this.queue = [];
    this.running = false;
    this.drain = [];
    this.jobs = new Set();
    this.sequence = 0;
    this.counters = {
      sessions: 0,
      requests: 0,
      failedRequests: 0,
      timeouts: 0,
      checked: 0,
      reused: 0,
      expandedBytes: 0,
      wasmBytes: 0,
      workerNS: {},
      kernelRequestBytes: 0,
      kernelResponseBytes: 0,
      last: null,
    };
  }
  stats() {
    return structuredClone({
      ...this.counters,
      resident: !!this.resident,
      queued: this.jobs.size,
    });
  }
  async retire(cell) {
    if (!cell) return;
    if (cell.retirement) return cell.retirement;
    cell.retired = true;
    if (this.resident === cell) this.resident = null;
    clearTimeout(cell.timer);
    cell.removeReclaimer?.();
    cell.retirement = (async () => {
      try {
        await cell.worker?.terminate();
      } catch (error) {
        this.budget.poison(error);
        throw error;
      }
      cell.lease.release();
    })();
    return cell.retirement;
  }
  async create(module, signal) {
    const lease = await this.budget.acquire({
      owner: 'compiler-proof-units',
      resources: { memoryMB: 1024 },
      signal,
      label: 'resident proof checker',
    });
    const cell = {
      module,
      lease,
      worker: null,
      busy: true,
      retired: false,
      timer: null,
    };
    cell.removeReclaimer = this.budget.registerReclaimer(async () => {
      if (cell.busy || cell.retired) return false;
      await this.retire(cell);
      return true;
    });
    this.resident = cell;
    return cell;
  }
  start(cell) {
    // Called only after CPU admission. Even Wasm instantiation runs in its lane.
    cell.worker = new Worker(
      new URL('./ink-proof-worker.mjs', import.meta.url),
      {
        workerData: { module: cell.module },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    cell.worker.on('error', () => {});
    cell.worker.on('exit', () => {
      void this.retire(cell).catch(() => {});
    });
    this.counters.sessions++;
  }
  observe(stats) {
    if (!stats) return;
    for (const key of [
      'checked',
      'reused',
      'expandedBytes',
      'kernelRequestBytes',
      'kernelResponseBytes',
    ])
      this.counters[key] += stats[key];
    this.counters.wasmBytes = stats.wasmBytes;
    for (const [phase, ns] of Object.entries(stats.timingNS))
      this.counters.workerNS[phase] = (this.counters.workerNS[phase] || 0) + ns;
  }
  async execute(cell, request, signal, timing, checkpoint) {
    cell.busy = true;
    clearTimeout(cell.timer);
    cell.worker?.ref();
    const queued = performance.now();
    let cpu;
    try {
      checkpoint();
      try {
        cpu = await this.budget.acquire({
          owner: 'compiler-proof-units',
          resources: { cpu: 1 },
          signal,
          label: 'checked proof-unit composition',
        });
      } finally {
        timing.cpuWaitMS += performance.now() - queued;
      }
      checkpoint();
      if (!cell.worker) this.start(cell);
      return await new Promise((resolve, reject) => {
        const id = ++this.sequence;
        let settled = false;
        const done = (error, message) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          cell.worker.off('message', onMessage);
          cell.worker.off('error', onError);
          cell.worker.off('exit', onExit);
          if (message?.stats) this.observe(message.stats);
          try {
            checkpoint();
          } catch (expired) {
            error = expired;
          }
          if (error && !error.proofRejected) {
            // Active claims survive until a timed-out driver actually stops.
            void this.retire(cell).then(() => reject(error), reject);
          } else error ? reject(error) : resolve(message);
        };
        const onMessage = (message) => {
            if (message.id === id)
              done(
                message.error
                  ? Object.assign(Error(message.error), {
                      proofRejected: true,
                    })
                  : null,
                message,
              );
          },
          onError = (error) => done(error),
          onExit = (code) => done(Error('Proof checker exited: ' + code)),
          abort = () => done(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        cell.worker.on('message', onMessage);
        cell.worker.once('error', onError);
        cell.worker.once('exit', onExit);
        if (signal.aborted) abort();
        else cell.worker.postMessage({ id, request });
      });
    } catch (error) {
      if (!error.proofRejected) await this.retire(cell);
      throw error;
    } finally {
      cpu?.release();
      cell.busy = false;
      if (!cell.retired) {
        cell.worker?.unref();
        cell.timer = setTimeout(() => {
          void this.retire(cell).catch(() => {});
        }, this.idleMS);
        cell.timer.unref();
      }
    }
  }
  compile(module, request, { timeout = 90000 } = {}) {
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 90000)
      return Promise.reject(Error('Invalid proof admission time budget'));
    if (this.jobs.size >= 16)
      return Promise.reject(Error('Proof admission queue is full'));
    const started = performance.now(),
      controller = new AbortController(),
      timing = { queueMS: 0, memoryWaitMS: 0, cpuWaitMS: 0, elapsedMS: 0 },
      job = { active: false, settled: false };
    this.jobs.add(job);
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const finish = (error, value) => {
      if (job.settled) return;
      job.settled = true;
      clearTimeout(timer);
      this.jobs.delete(job);
      timing.elapsedMS = performance.now() - started;
      this.counters.last = {
        ...timing,
        outcome: error ? 'rejected' : 'accepted',
      };
      if (error) this.counters.failedRequests++;
      else this.counters.requests++;
      error ? rejectResult(error) : resolveResult(value);
    };
    const expire = () => {
      if (job.settled || controller.signal.aborted) return;
      this.counters.timeouts++;
      const error = Object.assign(
        Error('Proof admission exceeded its execution budget'),
        { status: 408 },
      );
      controller.abort(error);
      // A queued expiration has no driver to drain; reject it immediately and
      // remove its payload from the FIFO so expired jobs cannot accumulate.
      if (!job.active) {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        timing.queueMS = performance.now() - started;
        finish(error);
      }
    };
    const timer = setTimeout(expire, timeout);
    const checkpoint = () => {
      if (performance.now() - started >= timeout) expire();
      controller.signal.throwIfAborted();
    };

    job.run = async () => {
      job.active = true;
      timing.queueMS = performance.now() - started;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          checkpoint();
          if (this.resident && this.resident.module !== module)
            await this.retire(this.resident);
          let cell = this.resident;
          if (!cell || cell.retired) {
            const begin = performance.now();
            try {
              cell = await this.create(module, controller.signal);
            } finally {
              timing.memoryWaitMS += performance.now() - begin;
            }
          }
          try {
            const response = await this.execute(
              cell,
              request,
              controller.signal,
              timing,
              checkpoint,
            );
            finish(null, response.value);
            return;
          } catch (error) {
            if (
              attempt ||
              ![
                'Proof unit encoding changed',
                'Proof unit capacity exceeded',
              ].some((reason) => error.message.includes(reason))
            )
              throw error;
            await this.retire(cell);
          }
        }
      } catch (error) {
        finish(error);
      }
    };
    this.queue.push(job);
    this.pump();
    return result;
  }
  pump() {
    if (this.running) return;
    this.running = true;
    void (async () => {
      try {
        while (this.queue.length) {
          const job = this.queue.shift();
          await job.run();
        }
      } finally {
        this.running = false;
        for (const resolve of this.drain.splice(0)) resolve();
      }
    })();
  }
  async close() {
    if (this.running) await new Promise((resolve) => this.drain.push(resolve));
    await this.retire(this.resident);
  }
}
const compiler = new ProofCompiler();
export const proofAdmissionStats = () => compiler.stats();
export const compileProofPlan = (module, request, options) =>
  compiler.compile(module, request, options);
export const closeProofCompiler = () => compiler.close();
