import { parentPort, workerData } from 'node:worker_threads';
import {
  StorageFixture,
  validateStorageWorkload,
  scopeStorageQuery,
  unScopeContract,
  storageIdentity,
  storageTarget,
} from './data-path-workload.mjs';
import { queryRelational, describeRelational } from './relational-query.mjs';
const observe = (value) => ({
  rows: value.rows,
  total: value.total,
  offset: value.offset,
  limit: value.limit,
  nextOffset: value.nextOffset,
  nextCursor: value.nextCursor,
  version: value.version,
  schema: value.schema,
});
const execute = (world, query, candidate) => {
  try {
    return { ok: observe(queryRelational(world, query, { candidate })) };
  } catch (error) {
    return { error: { status: error.status || 500, message: error.message } };
  }
};
try {
  const { queries, options } = workerData,
    workload = validateStorageWorkload(workerData.workload),
    plans = {};
  for (const op of workload.history)
    if (op.op === 'read' && !Object.hasOwn(queries, op.query))
      throw Error('Unknown workload query');
  for (const [name, source] of Object.entries(queries)) {
    const query = scopeStorageQuery(source, '1'.repeat(32)),
      world = new StorageFixture(workload),
      contract = unScopeContract(describeRelational(world, query));
    const candidates = contract.candidates.slice(0, options.candidates),
      baseline = candidates[0];
    if (baseline.recipe.family !== 'scan')
      throw Error('Storage baseline is missing');
    const history = workload.history.filter(
      (op) => op.op !== 'read' || op.query === name,
    );
    const reference = new StorageFixture(workload),
      expected = [];
    expected.push(execute(reference, query, baseline));
    if (expected[0].error)
      throw Error('Planning fixture must have valid baseline outputs');
    for (const op of history) {
      if (op.op === 'read') expected.push(execute(reference, query, baseline));
      else reference.apply(op);
    }
    const ranges = {};
    for (const dep of contract.dependencies) {
      const n = world.relationalStorage.footprint(
        world.namespace,
        dep.tableId,
      ).rows;
      ranges[dep.alias] = { min: n, max: n };
    }
    const receipts = candidates.map((candidate) => ({
      candidate: candidate.id,
      valid: true,
      reason: null,
      trials: [],
      observations: storageIdentity(expected),
    }));
    function run(candidate) {
      const current = new StorageFixture(workload),
        observed = [],
        heapBefore = process.memoryUsage().heapUsed;
      let peakHeap = heapBefore;
      const begin = performance.now();
      observed.push(execute(current, query, candidate));
      const setupNS = Math.round((performance.now() - begin) * 1e6);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      let readNS = 0,
        writeNS = 0;
      for (const op of history) {
        const start = performance.now();
        if (op.op === 'read') {
          observed.push(execute(current, query, candidate));
          readNS += Math.round((performance.now() - start) * 1e6);
        } else {
          current.apply(op);
          writeNS += Math.round((performance.now() - start) * 1e6);
        }
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        for (const dep of contract.dependencies) {
          const n = current.relationalStorage.footprint(
            current.namespace,
            dep.tableId,
          ).rows;
          ranges[dep.alias].min = Math.min(ranges[dep.alias].min, n);
          ranges[dep.alias].max = Math.max(ranges[dep.alias].max, n);
        }
      }
      return {
        observed,
        timing: {
          setupNS,
          readNS,
          writeNS,
          totalNS: setupNS + readNS + writeNS,
          heapGrowth: Math.max(0, peakHeap - heapBefore),
        },
      };
    }
    // Warm executable code for every strategy; each timed trial still starts with
    // a fresh cold storage adapter. Rotate order to avoid fixed GC/JIT positioning.
    for (const candidate of candidates) run(candidate);
    for (let trial = 0; trial < options.trials; trial++)
      for (let i = 0; i < candidates.length; i++) {
        const index = (i + trial) % candidates.length,
          receipt = receipts[index],
          result = run(candidates[index]);
        if (JSON.stringify(result.observed) !== JSON.stringify(expected)) {
          receipt.valid = false;
          receipt.reason = 'complete-observation-mismatch';
        }
        receipt.trials.push(result.timing);
      }
    const mean = (receipt) =>
        receipt.trials.reduce((n, t) => n + t.totalNS, 0) /
        receipt.trials.length,
      base = receipts[0];
    if (!base.valid) throw Error('Storage reference failed');
    let winner = base;
    if (options.mode === 'auto')
      for (const candidate of receipts.slice(1))
        if (
          candidate.valid &&
          mean(candidate) < mean(winner) &&
          mean(candidate) < mean(base) * 0.9 &&
          candidate.trials.filter((t, i) => t.totalNS < base.trials[i].totalNS)
            .length >= Math.ceil((options.trials * 2) / 3)
        )
          winner = candidate;
    const selected = candidates.find((c) => c.id === winner.candidate);
    plans[name] = {
      format: 'ink-data-path-v1',
      contract,
      selected: selected.id,
      recipe: selected.recipe,
      rows: ranges,
      target: storageTarget(),
      selection: {
        mode: options.mode,
        workload: storageIdentity(workload),
        receipts,
        reason:
          'Measured cold adapter setup and complete read/write history; 10% margin and repeated wins required',
      },
      fallback: { family: 'scan', reason: 'missing-or-inapplicable-evidence' },
    };
    plans[name].identity = storageIdentity(plans[name]);
  }
  parentPort.postMessage({ plans });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
