import { availableParallelism, totalmem } from 'node:os';

const dimensions = ['cpu', 'memoryMB', 'network', 'gpu'];
const failure = (status, message) => Object.assign(Error(message), { status });
const vector = (value) =>
  Object.fromEntries(dimensions.map((key) => [key, value?.[key] ?? 0]));
const defaults = {
  cpu: Math.min(4, availableParallelism()),
  memoryMB: Math.max(
    1024,
    Math.min(4096, Math.floor(totalmem() / 4 / 1048576)),
  ),
  network: 8,
  gpu: 0,
};

/** One host admission ledger. Claims come from host drivers, never app hints.
 * Cancellation removes queued work; an active lease survives until its driver
 * has actually stopped. Idle residents retain their memory reservations. */
export class ExecutionBudget {
  constructor({
    limits = defaults,
    maxQueued = 256,
    perOwnerQueued = 64,
  } = {}) {
    this.limits = Object.freeze(vector(limits));
    this.used = vector();
    this.owners = new Map();
    this.active = new Set();
    this.reclaimers = new Set();
    this.maxQueued = maxQueued;
    this.perOwnerQueued = perOwnerQueued;
    this.queued = 0;
    this.sequence = 0;
    if (
      Object.keys(limits).some((key) => !dimensions.includes(key)) ||
      dimensions.some(
        (key) =>
          !Number.isSafeInteger(this.limits[key]) || this.limits[key] < 0,
      ) ||
      !this.limits.cpu ||
      this.limits.memoryMB < 512 ||
      !Number.isInteger(maxQueued) ||
      maxQueued < 1 ||
      !Number.isInteger(perOwnerQueued) ||
      perOwnerQueued < 1
    )
      throw Error('Invalid host execution budget');
  }
  poison(error) {
    this.error ||= error;
    for (const queue of this.owners.values())
      for (const job of queue) {
        job.signal?.removeEventListener('abort', job.abort);
        job.reject(failure(503, 'Host resource retirement needs recovery'));
      }
    this.owners.clear();
    this.queued = 0;
  }
  activity() {
    if (this.error)
      throw failure(503, 'Host resource retirement needs recovery');
    return (
      this.queued +
      [...this.active].filter(
        (job) =>
          job.requested.cpu || job.requested.network || job.requested.gpu,
      ).length
    );
  }
  snapshot() {
    return {
      limits: this.limits,
      used: { ...this.used },
      queued: this.queued,
      active: this.active.size,
      ready: !this.error,
    };
  }
  registerReclaimer(reclaim) {
    this.reclaimers.add(reclaim);
    return () => this.reclaimers.delete(reclaim);
  }
  notify() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }
  acquire({ owner = 'host', resources, signal, label = 'execution' } = {}) {
    if (this.error)
      return Promise.reject(
        failure(503, 'Host resource retirement needs recovery'),
      );
    const requested = vector(resources);
    if (
      !dimensions.some((key) => requested[key] > 0) ||
      Object.keys(resources || {}).some((key) => !dimensions.includes(key)) ||
      dimensions.some(
        (key) => !Number.isSafeInteger(requested[key]) || requested[key] < 0,
      )
    )
      return Promise.reject(failure(400, 'Invalid execution resource claim'));
    if (dimensions.some((key) => requested[key] > this.limits[key]))
      return Promise.reject(
        failure(503, 'Host budget cannot admit this ' + label),
      );
    if (signal?.aborted)
      return Promise.reject(
        signal.reason || failure(499, 'Execution cancelled before admission'),
      );
    if (
      this.queued >= this.maxQueued ||
      (this.owners.get(owner)?.length || 0) >= this.perOwnerQueued
    )
      return Promise.reject(failure(429, 'Host execution queue is full'));
    return new Promise((resolve, reject) => {
      const job = {
        id: ++this.sequence,
        owner,
        requested,
        label,
        resolve,
        reject,
        signal,
      };
      job.abort = () => {
        const queue = this.owners.get(owner),
          index = queue?.indexOf(job) ?? -1;
        if (index < 0) return;
        queue.splice(index, 1);
        this.queued--;
        if (!queue.length) this.owners.delete(owner);
        signal.removeEventListener('abort', job.abort);
        reject(
          signal.reason || failure(499, 'Execution cancelled before admission'),
        );
        this.notify();
      };
      if (!this.owners.has(owner)) this.owners.set(owner, []);
      this.owners.get(owner).push(job);
      this.queued++;
      signal?.addEventListener('abort', job.abort, { once: true });
      this.notify();
    });
  }
  pump() {
    if (this.error) return;
    // Round-robin owners; a blocked resource reserves that dimension against
    // later claims. CPU-only work can still finish and release resident memory.
    let progressed = true;
    while (progressed) {
      progressed = false;
      const blocked = new Set();
      for (const [owner, queue] of [...this.owners]) {
        let index = -1;
        for (let candidate = 0; candidate < queue.length; candidate++) {
          const job = queue[candidate],
            missing = dimensions.filter(
              (key) => this.used[key] + job.requested[key] > this.limits[key],
            );
          if (missing.length) {
            missing.forEach((key) => blocked.add(key));
            continue;
          }
          if (dimensions.some((key) => blocked.has(key) && job.requested[key]))
            continue;
          index = candidate;
          break;
        }
        if (index < 0) continue;
        const [job] = queue.splice(index, 1);
        this.queued--;
        this.owners.delete(owner);
        if (queue.length) this.owners.set(owner, queue);
        job.signal?.removeEventListener('abort', job.abort);
        dimensions.forEach((key) => (this.used[key] += job.requested[key]));
        this.active.add(job);
        let released = false;
        job.resolve({
          release: () => {
            if (released) return;
            released = true;
            this.active.delete(job);
            dimensions.forEach((key) => (this.used[key] -= job.requested[key]));
            this.notify();
          },
        });
        progressed = true;
      }
    }
    if (
      !this.reclaiming &&
      [...this.owners.values()].some(
        (queue) =>
          queue[0] &&
          this.used.memoryMB + queue[0].requested.memoryMB >
            this.limits.memoryMB,
      )
    ) {
      this.reclaiming = true;
      Promise.allSettled(
        [...this.reclaimers].map((reclaim) => Promise.resolve().then(reclaim)),
      ).then((results) => {
        this.reclaiming = false;
        if (
          results.some(
            (result) => result.status === 'fulfilled' && result.value,
          )
        )
          this.notify();
      });
    }
  }
  async run(options, execute) {
    const lease = await this.acquire(options);
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      return await execute();
    } finally {
      lease.release();
    }
  }
}
function hostLimits() {
  if (!process.env.INK_OS_EXECUTION_BUDGET) return defaults;
  let parsed;
  try {
    parsed = JSON.parse(process.env.INK_OS_EXECUTION_BUDGET);
  } catch {
    throw Error('INK_OS_EXECUTION_BUDGET must be a resource JSON object');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
    throw Error('Invalid host budget configuration');
  return { ...defaults, ...parsed };
}
export const hostBudget = new ExecutionBudget({ limits: hostLimits() });
export const WORKER_MEMORY_MB = 512;
