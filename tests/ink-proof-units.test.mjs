import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { buildInkApp, inkSource } from '../server/ink-apps.mjs';
import { compilerRequest, compileInkProgram } from '../server/ink-compiler.mjs';
import {
  packProofPlan,
  unpackProofPlan,
  proofPlan,
  encodeProofUnit,
} from '../server/ink-proof-plan.mjs';
import { rebindProofPlan } from '../server/ink-proof-authoring.mjs';
import {
  proofAdmissionStats,
  closeProofCompiler,
} from '../server/ink-proof-compiler.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
const root = new URL('../examples/tables-system/tables/', import.meta.url),
  manifest = JSON.parse(await readFile(new URL('ink-app.json', root), 'utf8'));
const files = await Promise.all(
  manifest.modules.modules.map(async (module) => ({
    path: module.path,
    base64: (await readFile(new URL(module.path, root))).toString('base64'),
  })),
);
const raw = await readFile(new URL('selected.plan.json', root), 'utf8'),
  packed = packProofPlan(raw),
  legacy = await unpackProofPlan(packed);
let sequence = 0;
async function program() {
  const bundle = await buildInkApp(
    { ...manifest, optimisation: { version: 1, mode: 'baseline' } },
    files,
  );
  return inkSource(bundle.ink, bundle.files);
}
const request = (source, plan) => ({
  op: 'compilePlan',
  ...(typeof source === 'string' ? { source } : { graph: source }),
  plan,
});
function changedSource(source) {
  const next = structuredClone(source);
  next.modules[0].source += '\n// independent admission ' + sequence++;
  return next;
}

test('unit transport is complete, bounded and preserves exact canonical mathematical entries', async () => {
  const packet = proofPlan(packed);
  assert.equal(Object.keys(packet.units).length, 180);
  assert.ok(Buffer.byteLength(packed) < Buffer.byteLength(legacy) * 0.4);
  assert.deepEqual(
    parseExactJSON(await unpackProofPlan(packed)),
    parseExactJSON(legacy),
  );
  const unsafe = parseExactJSON(legacy),
    all = unsafe.steps[0].package.knowledge.objects;
  for (const [id, entry] of Object.entries(all))
    assert.equal(encodeProofUnit(entry).id, id);
  for (const change of [
    (v) => (v.units[Object.keys(v.units)[0]].bytes = 0),
    (v) => (v.units[Object.keys(v.units)[0]].brotli = 'bad'),
    (v) => delete v.units[Object.keys(v.units)[0]],
    (v) => (v.units.extra = {}),
  ]) {
    const value = JSON.parse(packed);
    change(value);
    assert.throws(() => proofPlan(JSON.stringify(value)));
  }
});

test('fresh admission checks every unit; a new release can reuse dependencies and eviction requires full replay', async (t) => {
  t.after(closeProofCompiler);
  await closeProofCompiler();
  const source = await program(),
    before = proofAdmissionStats();
  const original = await compilerRequest(request(source, packed)),
    cold = proofAdmissionStats();
  assert.equal(cold.checked - before.checked, 180);
  assert.equal(cold.reused - before.reused, 0);
  const next = changedSource(source),
    again = await compilerRequest(request(next, packed)),
    warm = proofAdmissionStats();
  assert.equal(warm.checked - cold.checked, 0);
  assert.equal(warm.reused - cold.reused, 180);
  assert.equal(again.javascript, original.javascript);
  await closeProofCompiler();
  await compilerRequest(request(changedSource(source), packed));
  assert.equal(proofAdmissionStats().checked - warm.checked, 180);
});

test('a semantic view edit rebinds checked source observations and checks only its new definition unit', async (t) => {
  t.after(closeProofCompiler);
  await closeProofCompiler();
  const source = await program();
  await compilerRequest(request(source, packed));
  const before = proofAdmissionStats(),
    next = structuredClone(source);
  next.modules[0].source = next.modules[0].source.replace(
    '"Tables"',
    '"Edited heading"',
  );
  const changed = await rebindProofPlan(next, packed),
    stats = proofAdmissionStats();
  assert.equal(stats.checked - before.checked, 1);
  assert.equal(stats.reused - before.reused, 180);
  const compiled = await compileInkProgram({
    kind: 'ink-os-planned-v1',
    source: next,
    plan: changed,
  });
  assert.ok(compiled.javascript.includes('Edited heading'));
  const stale = JSON.parse(packed),
    updated = parseExactJSON(stale.plan),
    original = await compileInkProgram(next);
  updated.input_core_sha256 = original.manifest.core_sha256;
  updated.steps[0].package.input_core_sha256 = original.manifest.core_sha256;
  stale.plan = stringifyExactJSON(updated);
  await assert.rejects(
    compilerRequest(request(next, JSON.stringify(stale))),
    /source definitions missing or changed/,
  );
});

test('warm caches cannot admit substituted units, missing imports, false rehashed theorems or forged view obligations', async (t) => {
  t.after(closeProofCompiler);
  await closeProofCompiler();
  const source = await program();
  await compilerRequest(request(source, packed));
  const values = JSON.parse(packed),
    id = Object.keys(values.units).find(
      (id) =>
        JSON.parse(
          brotliDecompressSync(
            Buffer.from(values.units[id].brotli, 'base64'),
          ).toString(),
        ).kind === 'theorem',
    );
  const forged = JSON.parse(packed);
  forged.units[id].brotli = Buffer.from('not a compressed proof').toString(
    'base64',
  );
  await assert.rejects(
    compilerRequest(request(changedSource(source), JSON.stringify(forged))),
  );
  // A content-addressed and correctly typed claim still needs an actual proof.
  const theorem = {
      Theorem: {
        params: [],
        conditions: [],
        from: { U64: 7 },
        to: { U64: 8 },
        proof: { Refl: { U64: 7 } },
      },
    },
    entry = {
      schema: 1,
      semantics: 'first-order-inductive-equality-v1',
      kind: 'theorem',
      dependencies: [],
      interface: {
        conditions: [],
        effects: [],
        operations: [],
        parameters: {},
        result: null,
      },
      payload: { declaration: theorem },
    };
  const encoded = encodeProofUnit(entry);
  await assert.rejects(
    compilerRequest({
      op: 'admitProofUnit',
      id: encoded.id,
      object: stringifyExactJSON(entry),
    }),
  );
  const bad = JSON.parse(packed),
    packet = parseExactJSON(bad.plan);
  packet.steps[0].package.views[0].factorisation = { Refl: { U64: 7 } };
  bad.plan = stringifyExactJSON(packet);
  await assert.rejects(
    compilerRequest(request(changedSource(source), JSON.stringify(bad))),
  );
  const missing = JSON.parse(packed),
    scope = parseExactJSON(missing.plan).steps[0].package.knowledge;
  scope.snapshot.root = '0'.repeat(64);
  const header = parseExactJSON(missing.plan);
  header.steps[0].package.knowledge = scope;
  missing.plan = stringifyExactJSON(header);
  await assert.rejects(
    compilerRequest(request(changedSource(source), JSON.stringify(missing))),
    /snapshot/,
  );
  // Failed source-specific equations cannot poison already checked dependencies.
  const before = proofAdmissionStats();
  await compilerRequest(request(changedSource(source), packed));
  const after = proofAdmissionStats();
  assert.equal(after.checked - before.checked, 0);
  assert.equal(after.reused - before.reused, 180);
});

test('changed keep semantics cannot reuse an old factorisation merely by refreshing source observations', async (t) => {
  t.after(closeProofCompiler);
  await closeProofCompiler();
  const source = await program();
  await compilerRequest(request(source, packed));
  const next = structuredClone(source);
  next.modules[0].source = next.modules[0].source.replace(
    'map(fn(row)=>row.amount)',
    'map(fn(row)=>row.amount+1)',
  );
  assert.notEqual(next.modules[0].source, source.modules[0].source);
  await assert.rejects(rebindProofPlan(next, packed));
});

test('admission deadlines retire the worker and release its resource claims before another session can run', async (t) => {
  t.after(closeProofCompiler);
  await closeProofCompiler();
  const source = await program();
  await assert.rejects(
    compilerRequest(request(source, packed), { timeout: 1 }),
    /execution budget/,
  );
  assert.equal(proofAdmissionStats().resident, false);
  const { hostBudget } = await import('../server/execution-budget.mjs');
  assert.equal(hostBudget.snapshot().used.cpu, 0);
  assert.equal(hostBudget.snapshot().used.memoryMB, 0);
  const before = proofAdmissionStats();
  await compilerRequest(request(changedSource(source), packed));
  assert.equal(proofAdmissionStats().checked - before.checked, 180);
});

test('a different compiler module cannot inherit another module’s checked unit session', async (t) => {
  t.after(closeProofCompiler);
  await closeProofCompiler();
  const source = await program();
  await compilerRequest(request(source, packed));
  const before = proofAdmissionStats(),
    module = await WebAssembly.compile(
      await readFile(new URL('../public/ink-compiler.wasm', import.meta.url)),
    ),
    { compileProofPlan } = await import('../server/ink-proof-compiler.mjs');
  await compileProofPlan(module, request(changedSource(source), packed));
  const after = proofAdmissionStats();
  assert.equal(after.sessions - before.sessions, 1);
  assert.equal(after.checked - before.checked, 180);
  assert.equal(after.reused - before.reused, 0);
});

test('descriptor property order reuses the same checked facts without a new compiler session', async (t) => {
  t.after(closeProofCompiler);
  await closeProofCompiler();
  const source = await program();
  await compilerRequest(request(source, packed));
  const before = proofAdmissionStats(),
    envelope = JSON.parse(packed);
  envelope.units = Object.fromEntries(
    Object.entries(envelope.units).map(([id, unit]) => [
      id,
      {
        brotli: unit.brotli,
        dependencies: unit.dependencies,
        bytes: unit.bytes,
      },
    ]),
  );
  await compilerRequest(
    request(changedSource(source), JSON.stringify(envelope)),
  );
  const after = proofAdmissionStats();
  assert.equal(after.sessions, before.sessions);
  assert.equal(after.checked, before.checked);
  assert.equal(after.reused - before.reused, 180);
});

test('a rejected application still accounts for checked dependencies and phase work', async (t) => {
  const { ProofCompiler } = await import('../server/ink-proof-compiler.mjs'),
    { ExecutionBudget } = await import('../server/execution-budget.mjs'),
    { compilerModule } = await import('../server/ink-compiler.mjs');
  const pool = new ProofCompiler({
    budget: new ExecutionBudget({ limits: { cpu: 1, memoryMB: 1024 } }),
  });
  t.after(() => pool.close());
  const source = await program(),
    { module } = await compilerModule(),
    bad = JSON.parse(packed),
    header = parseExactJSON(bad.plan);
  header.steps[0].package.views[0].factorisation = { Refl: { U64: 7 } };
  bad.plan = stringifyExactJSON(header);
  await assert.rejects(
    pool.compile(module, request(source, JSON.stringify(bad))),
  );
  const failed = pool.stats();
  assert.equal(failed.checked, 180);
  assert.equal(failed.requests, 0);
  assert.equal(failed.failedRequests, 1);
  assert.equal(failed.last.outcome, 'rejected');
  assert.ok(failed.workerNS.admit > 0);
  assert.ok(failed.workerNS.compose > 0);
  assert.ok(failed.kernelRequestBytes > 7 * 1024 * 1024);
  const { total, ...parts } = failed.workerNS;
  assert.ok(Object.values(parts).reduce((a, b) => a + b, 0) <= total);
  await pool.compile(module, request(source, packed));
  const success = pool.stats();
  assert.equal(success.checked, 180);
  assert.equal(success.reused, 180);
  assert.equal(success.requests, 1);
  assert.equal(success.failedRequests, 1);
});

test(
  'the admission deadline includes memory waiting and CPU waiting without bootstrapping a guest',
  { timeout: 10000 },
  async (t) => {
    const { ProofCompiler } = await import('../server/ink-proof-compiler.mjs'),
      { ExecutionBudget } = await import('../server/execution-budget.mjs'),
      { compilerModule } = await import('../server/ink-compiler.mjs');
    const source = await program(),
      { module } = await compilerModule();
    for (const resources of [{ memoryMB: 1024 }, { cpu: 1 }]) {
      const budget = new ExecutionBudget({
          limits: { cpu: 1, memoryMB: 1024 },
        }),
        hold = await budget.acquire({ owner: 'contention-fixture', resources }),
        pool = new ProofCompiler({ budget });
      t.after(async () => {
        hold.release();
        await pool.close();
      });
      await assert.rejects(
        pool.compile(module, request(source, packed), { timeout: 30 }),
        { status: 408 },
      );
      assert.equal(pool.stats().sessions, 0);
      assert.equal(pool.stats().queued, 0);
      assert.equal(budget.snapshot().queued, 0);
      assert.equal(budget.snapshot().used.memoryMB, resources.memoryMB || 0);
      assert.equal(budget.snapshot().used.cpu, resources.cpu || 0);
      hold.release();
      await pool.close();
    }
  },
);

test(
  'expired FIFO requests release their payload slots without cancelling the live head',
  { timeout: 10000 },
  async (t) => {
    const { ProofCompiler } = await import('../server/ink-proof-compiler.mjs'),
      { ExecutionBudget } = await import('../server/execution-budget.mjs'),
      { compilerModule } = await import('../server/ink-compiler.mjs');
    const source = await program(),
      { module } = await compilerModule(),
      budget = new ExecutionBudget({ limits: { cpu: 1, memoryMB: 1024 } }),
      hold = await budget.acquire({
        owner: 'contention-fixture',
        resources: { cpu: 1 },
      }),
      pool = new ProofCompiler({ budget });
    t.after(async () => {
      hold.release();
      await pool.close();
    });
    const head = pool.compile(module, request(source, packed), {
        timeout: 5000,
      }),
      waiting = Array.from({ length: 15 }, () =>
        pool.compile(module, request(source, packed), { timeout: 30 }),
      );
    await assert.rejects(
      pool.compile(module, request(source, packed)),
      /queue is full/,
    );
    const results = await Promise.allSettled(waiting);
    assert.ok(
      results.every((r) => r.status === 'rejected' && r.reason.status === 408),
    );
    assert.equal(pool.stats().queued, 1);
    assert.equal(pool.queue.length, 0);
    assert.equal(pool.stats().sessions, 0);
    hold.release();
    await head;
    assert.equal(pool.stats().checked, 180);
    assert.equal(pool.stats().requests, 1);
    assert.equal(pool.stats().failedRequests, 15);
    assert.equal(pool.stats().timeouts, 15);
    assert.equal(pool.stats().queued, 0);
  },
);

test(
  'a delayed timer cannot start a guest or deliver an artifact after its monotonic deadline',
  { timeout: 10000 },
  async (t) => {
    const { ProofCompiler } = await import('../server/ink-proof-compiler.mjs'),
      { ExecutionBudget } = await import('../server/execution-budget.mjs'),
      { compilerModule } = await import('../server/ink-compiler.mjs');
    const source = await program(),
      { module } = await compilerModule(),
      budget = new ExecutionBudget({ limits: { cpu: 1, memoryMB: 1024 } }),
      pool = new ProofCompiler({ budget });
    t.after(() => pool.close());
    const pending = pool.compile(module, request(source, packed), {
        timeout: 10,
      }),
      until = performance.now() + 30;
    // Keep timers from running while the resource-admission microtasks become due.
    while (performance.now() < until) {}
    await assert.rejects(pending, { status: 408 });
    assert.equal(pool.stats().sessions, 0);
    assert.equal(pool.stats().timeouts, 1);
    assert.equal(budget.snapshot().used.memoryMB, 0);
    assert.equal(budget.snapshot().used.cpu, 0);
  },
);
