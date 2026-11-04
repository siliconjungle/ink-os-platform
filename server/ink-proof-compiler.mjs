import { Worker } from 'node:worker_threads';
import { hostBudget } from './execution-budget.mjs';
let resident = null,
  tail = Promise.resolve(),
  queued = 0,
  sequence = 0;
const counters = {
  sessions: 0,
  requests: 0,
  checked: 0,
  reused: 0,
  expandedBytes: 0,
  wasmBytes: 0,
};
export const proofAdmissionStats = () => ({
  ...counters,
  resident: !!resident,
  queued,
});
async function retire(cell) {
  if (!cell || cell.retired) return;
  cell.retired = true;
  if (resident === cell) resident = null;
  clearTimeout(cell.timer);
  cell.removeReclaimer?.();
  try {
    await cell.worker.terminate();
  } catch (error) {
    hostBudget.poison(error);
    throw error;
  }
  cell.lease.release();
}
async function create(module) {
  const lease = await hostBudget.acquire({
    owner: 'compiler-proof-units',
    resources: { memoryMB: 1024 },
    label: 'resident proof checker',
  });
  let worker;
  try {
    worker = new Worker(new URL('./ink-proof-worker.mjs', import.meta.url), {
      workerData: { module },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
  } catch (error) {
    lease.release();
    throw error;
  }
  const cell = {
    module,
    worker,
    lease,
    busy: true,
    retired: false,
    timer: null,
  };
  cell.removeReclaimer = hostBudget.registerReclaimer(async () => {
    if (cell.busy || cell.retired) return false;
    await retire(cell);
    return true;
  });
  worker.on('error', () => {});
  worker.on('exit', () => void retire(cell));
  resident = cell;
  counters.sessions++;
  return cell;
}
async function execute(cell, request, timeout) {
  cell.busy = true;
  cell.worker.ref();
  clearTimeout(cell.timer);
  const controller = new AbortController(),
    deadline = setTimeout(
      () =>
        controller.abort(
          Error('Proof admission exceeded its execution budget'),
        ),
      timeout,
    );
  try {
    return await hostBudget.run(
      {
        owner: 'compiler-proof-units',
        resources: { cpu: 1 },
        signal: controller.signal,
        label: 'checked proof-unit composition',
      },
      () =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const done = (error, message) => {
            controller.signal.removeEventListener('abort', abort);
            cell.worker.off('message', messageHandler);
            cell.worker.off('error', errorHandler);
            cell.worker.off('exit', exitHandler);
            if (error && !error.proofRejected) {
              // Keep the active CPU lease until a timed-out/broken driver has
              // actually stopped; a rejected proof has already returned idle.
              void retire(cell).then(() => reject(error), reject);
            } else error ? reject(error) : resolve(message);
          };
          const messageHandler = (message) => {
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
            errorHandler = (error) => done(error),
            exitHandler = (code) =>
              done(Error('Proof checker exited: ' + code)),
            abort = () => done(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          cell.worker.on('message', messageHandler);
          cell.worker.once('error', errorHandler);
          cell.worker.once('exit', exitHandler);
          cell.worker.postMessage({ id, request });
        }),
    );
  } catch (error) {
    if (!error.proofRejected) await retire(cell);
    throw error;
  } finally {
    clearTimeout(deadline);
    cell.busy = false;
    if (!cell.retired) {
      cell.worker.unref();
      cell.timer = setTimeout(() => void retire(cell), 10000);
      cell.timer.unref();
    }
  }
}
/** One serialized, bounded kernel session; eviction/restart loses all witnesses.
 * A new session replays every required unit. No on-disk checked flags are read. */
export async function compileProofPlan(
  module,
  request,
  { timeout = 90000 } = {},
) {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 90000)
    throw Error('Invalid proof admission time budget');
  if (queued >= 16) throw Error('Proof admission queue is full');
  queued++;
  const run = tail
    .catch(() => {})
    .then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (resident && resident.module !== module) await retire(resident);
        const cell =
          resident && !resident.retired ? resident : await create(module);
        try {
          const response = await execute(cell, request, timeout);
          counters.requests++;
          for (const key of ['checked', 'reused', 'expandedBytes'])
            counters[key] += response.stats[key];
          counters.wasmBytes = response.stats.wasmBytes;
          return response.value;
        } catch (error) {
          if (
            attempt ||
            ![
              'Proof unit encoding changed',
              'Proof unit capacity exceeded',
            ].some((reason) => error.message.includes(reason))
          )
            throw error;
          await retire(cell);
        }
      }
    });
  tail = run;
  try {
    return await run;
  } finally {
    queued--;
  }
}
export async function closeProofCompiler() {
  await tail.catch(() => {});
  await retire(resident);
}
