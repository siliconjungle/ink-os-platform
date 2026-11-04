import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionBudget } from '../server/execution-budget.mjs';
import { InkResidents } from '../server/ink-residents.mjs';
const defer = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const budget = (limits) =>
  new ExecutionBudget({
    limits: { cpu: 2, memoryMB: 1024, network: 2, gpu: 1, ...limits },
  });

test('one vector ledger bounds aggregate CPU, memory, network and GPU claims across owners', async () => {
  const b = budget(),
    hold = defer(),
    admitted = [];
  const tasks = Array.from({ length: 12 }, (_, n) =>
    b.run(
      {
        owner: 'app-' + n,
        resources: { cpu: 1, memoryMB: 512, network: 1, gpu: n === 0 ? 1 : 0 },
      },
      async () => {
        admitted.push(n);
        const state = b.snapshot();
        for (const key of Object.keys(state.used))
          assert.ok(state.used[key] <= state.limits[key]);
        await hold.promise;
      },
    ),
  );
  await turn();
  assert.equal(admitted.length, 2);
  assert.equal(b.snapshot().queued, 10);
  hold.resolve();
  await Promise.all(tasks);
  assert.deepEqual(b.snapshot().used, {
    cpu: 0,
    memoryMB: 0,
    network: 0,
    gpu: 0,
  });
  assert.equal(b.activity(), 0);
});

test('queued cancellation cannot dispatch and active cancellation retains its lease until the driver stops', async () => {
  const b = budget({ cpu: 1 }),
    hold = defer(),
    controller = new AbortController(),
    first = b.run(
      { owner: 'first', resources: { cpu: 1 }, signal: controller.signal },
      () => hold.promise,
    );
  await turn();
  const other = new AbortController();
  let called = false;
  const queued = b.run(
    { owner: 'second', resources: { cpu: 1 }, signal: other.signal },
    () => {
      called = true;
    },
  );
  const rejected = assert.rejects(queued);
  other.abort(Error('cancelled'));
  await rejected;
  controller.abort();
  assert.equal(b.snapshot().used.cpu, 1);
  assert.equal(called, false);
  hold.resolve();
  await first;
  assert.equal(b.activity(), 0);
});

test('owners rotate fairly and resource-only continuations bypass blocked memory claims without deadlock', async () => {
  const b = budget({ cpu: 1, memoryMB: 512 }),
    resident = await b.acquire({ owner: 'same', resources: { memoryMB: 512 } }),
    cpu = await b.acquire({ owner: 'busy', resources: { cpu: 1 } }),
    events = [];
  const memory = b.acquire({ owner: 'same', resources: { memoryMB: 512 } });
  const continuation = b.run(
    { owner: 'same', resources: { cpu: 1 } },
    async () => {
      events.push('continuation');
      resident.release();
    },
  );
  cpu.release();
  await continuation;
  const lease = await memory;
  assert.deepEqual(events, ['continuation']);
  lease.release();
  const occupied = await b.acquire({ owner: 'busy', resources: { cpu: 1 } });
  const tasks = ['a', 'a', 'b', 'b'].map((owner) =>
    b.run({ owner, resources: { cpu: 1 } }, () => events.push(owner)),
  );
  occupied.release();
  await Promise.all(tasks);
  assert.deepEqual(events.slice(1), ['a', 'b', 'a', 'b']);
});

test('idle residents retain memory, are reclaimed under pressure, and cannot be evicted while executing', async () => {
  const b = budget({ memoryMB: 512 }),
    pool = new InkResidents({ budget: b, limit: 2 });
  let closes = 0;
  const session = await pool.acquire('one', async () => ({
    close: async () => closes++,
  }));
  assert.equal(b.snapshot().used.memoryMB, 512);
  const waiting = b.acquire({
    owner: 'compiler',
    resources: { cpu: 1, memoryMB: 512 },
  });
  await turn();
  assert.equal(closes, 0);
  pool.release(session);
  const lease = await waiting;
  assert.equal(closes, 1);
  assert.equal(pool.sessions.size, 0);
  lease.release();
  await pool.close();
  assert.equal(b.snapshot().used.memoryMB, 0);
});

test('impossible or malformed claims fail closed and admission queues have bounded size', async () => {
  const b = new ExecutionBudget({
    limits: { cpu: 1, memoryMB: 512, network: 1, gpu: 0 },
    maxQueued: 2,
    perOwnerQueued: 1,
  });
  await assert.rejects(b.acquire({ resources: { gpu: 1 } }), { status: 503 });
  await assert.rejects(b.acquire({ resources: { cpu: -1 } }), { status: 400 });
  await assert.rejects(b.acquire({ resources: { unknown: 1 } }), {
    status: 400,
  });
  const lease = await b.acquire({ resources: { cpu: 1 } }),
    controller = new AbortController(),
    queued = b.acquire({
      owner: 'app',
      resources: { cpu: 1 },
      signal: controller.signal,
    });
  const rejected = assert.rejects(queued);
  await assert.rejects(b.acquire({ owner: 'app', resources: { cpu: 1 } }), {
    status: 429,
  });
  controller.abort();
  await rejected;
  lease.release();
  assert.equal(b.activity(), 0);
});

test('uncertain resident retirement fences new admissions and cannot certify quiescence by forgetting its memory', async () => {
  const b = budget(),
    pool = new InkResidents({ budget: b });
  let failed = true;
  const session = await pool.acquire('one', async () => ({
    close: async () => {
      if (failed) throw Error('retirement uncertain');
    },
  }));
  await assert.rejects(pool.drop(session), /uncertain/);
  assert.equal(b.snapshot().used.memoryMB, 512);
  await assert.rejects(b.acquire({ resources: { cpu: 1 } }), { status: 503 });
  assert.throws(() => b.activity(), { status: 503 });
  failed = false;
  await pool.drop(session);
  await pool.close();
});

test('idle eviction failure closes resource admission without an unhandled background rejection', async () => {
  const b = budget(),
    pool = new InkResidents({ budget: b, idleMs: 1 });
  let failed = true;
  const session = await pool.acquire('one', async () => ({
    close: async () => {
      if (failed) throw Error('uncertain idle retirement');
    },
  }));
  pool.release(session);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(b.snapshot().ready, false);
  assert.equal(b.snapshot().used.memoryMB, 512);
  failed = false;
  await pool.drop(session);
  await pool.close();
});
