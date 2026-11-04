import { Worker } from 'node:worker_threads';
import { hostBudget } from './execution-budget.mjs';
import { inkProgramKey } from './ink-compiler.mjs';
import { sourceFiles } from '../shared/source-files.mjs';
import {
  StorageFixture,
  validateStorageWorkload,
  scopeStorageQuery,
  scopeContract,
  unScopeContract,
  storageIdentity,
  storageTarget,
  fixtureNamespace,
  workloadRanges,
} from './data-path-workload.mjs';
import {
  describeRelational,
  checkDataPath,
  queryRelational,
} from './relational-query.mjs';
const plain = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) =>
  plain(value) &&
  Object.keys(value).length === allowed.length &&
  allowed.every((k) => Object.hasOwn(value, k));
const digest = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
export function dataPlanningFiles(input) {
  return input?.workload ? [input.workload] : input?.plan ? [input.plan] : [];
}
function options(input) {
  if (
    !input ||
    input.version !== 1 ||
    !['auto', 'baseline', 'replay'].includes(input.mode) ||
    Object.keys(input).some(
      (k) =>
        ![
          'version',
          'mode',
          'workload',
          'plan',
          'milliseconds',
          'candidates',
          'trials',
        ].includes(k),
    )
  )
    fail('Invalid storage planning contract');
  const replay = input.mode === 'replay';
  if (
    replay
      ? typeof input.plan !== 'string' || input.workload !== undefined
      : typeof input.workload !== 'string' || input.plan !== undefined
  )
    fail('Storage planning requires a committed workload or replay packet');
  sourceFiles(dataPlanningFiles(input).map((path) => ({ path, base64: '' })));
  const result = {
    ...input,
    milliseconds: input.milliseconds ?? 8000,
    candidates: input.candidates ?? 8,
    trials: input.trials ?? 3,
  };
  for (const [key, min, max] of [
    ['milliseconds', 1, 30000],
    ['candidates', 1, 8],
    ['trials', 3, 7],
  ])
    if (
      !Number.isInteger(result[key]) ||
      result[key] < min ||
      result[key] > max
    )
      fail('Storage planning budgets exceed build limits');
  return result;
}
function textFile(files, path) {
  const file = files.find((f) => f.path === path);
  if (!file || Buffer.byteLength(file.base64, 'base64') > 8 * 1024 * 1024)
    fail('Missing bounded storage planning input');
  const bytes = Buffer.from(file.base64, 'base64'),
    text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes))
    fail('Storage planning inputs must be UTF-8');
  return text;
}
function queriesOf(ui) {
  return Object.fromEntries(
    (ui?.components || []).filter((c) => c.query).map((c) => [c.name, c.query]),
  );
}
function baselinePlans(queries, workload, reason) {
  const plans = {},
    ranges = workloadRanges(workload);
  for (const [name, query] of Object.entries(queries)) {
    const world = new StorageFixture(workload),
      contract = unScopeContract(
        describeRelational(world, scopeStorageQuery(query, fixtureNamespace)),
      ),
      candidate = contract.candidates[0];
    plans[name] = {
      format: 'ink-data-path-v1',
      contract,
      selected: candidate.id,
      recipe: candidate.recipe,
      target: storageTarget(),
      rows: Object.fromEntries(
        contract.dependencies.map((dep) => {
          return [dep.alias, ranges[dep.tableId]];
        }),
      ),
      selection: {
        mode: 'baseline',
        workload: storageIdentity(workload),
        receipts: [],
        reason,
      },
      fallback: { family: 'scan', reason: 'missing-or-inapplicable-evidence' },
    };
    plans[name].identity = storageIdentity(plans[name]);
  }
  return plans;
}
async function produce(queries, workload, options) {
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(Error('Storage planning time budget exhausted')),
      options.milliseconds,
    );
  try {
    return await hostBudget.run(
      {
        owner: 'storage-planning',
        resources: { cpu: 1, memoryMB: 512 },
        signal: controller.signal,
        label: 'bounded storage plan build',
      },
      async () => {
        const worker = new Worker(
          new URL('./data-path-worker.mjs', import.meta.url),
          {
            workerData: { queries, workload, options },
            resourceLimits: { maxOldGenerationSizeMb: 384 },
          },
        );
        try {
          return await new Promise((resolve, reject) => {
            const abort = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', abort, { once: true });
            worker.once('error', reject);
            worker.once('exit', (code) =>
              reject(Error('Storage planner exited: ' + code)),
            );
            worker.once('message', (message) => {
              controller.signal.removeEventListener('abort', abort);
              message.error
                ? reject(Error(message.error))
                : resolve(message.plans);
            });
            if (controller.signal.aborted) abort();
          });
        } finally {
          await worker.terminate();
        }
      },
    );
  } finally {
    clearTimeout(timer);
  }
}
export async function buildDataPaths(program, ui, input, files) {
  if (input === undefined) return null;
  const effort = options(input),
    queries = queriesOf(ui);
  if (!Object.keys(queries).length || Object.keys(queries).length > 16)
    fail('Storage planning needs 1–16 declared typed UI queries');
  if (effort.mode === 'replay') {
    const saved = JSON.parse(textFile(files, effort.plan));
    return verifyDataPaths(program, ui, saved);
  }
  const workload = validateStorageWorkload(
    JSON.parse(textFile(files, effort.workload)),
  );
  let plans;
  if (effort.mode === 'baseline')
    plans = baselinePlans(
      queries,
      workload,
      'Explicit baseline; no profitability search',
    );
  else
    try {
      plans = await produce(queries, workload, effort);
    } catch {
      plans = baselinePlans(
        queries,
        workload,
        'Build search did not produce comparable evidence within its resource limits',
      );
    }
  const value = {
    format: 'ink-data-paths-v1',
    source: inkProgramKey(program),
    queries,
    workload,
    effort: {
      version: 1,
      mode: effort.mode,
      milliseconds: effort.milliseconds,
      candidates: effort.candidates,
      trials: effort.trials,
    },
    plans,
  };
  value.identity = storageIdentity(value);
  return verifyDataPaths(program, ui, value);
}
export function verifyDataPaths(program, ui, packet) {
  if (
    !fields(packet, [
      'format',
      'source',
      'queries',
      'workload',
      'effort',
      'plans',
      'identity',
    ]) ||
    !plain(packet.queries) ||
    !plain(packet.plans) ||
    !fields(packet.effort, [
      'version',
      'mode',
      'milliseconds',
      'candidates',
      'trials',
    ]) ||
    packet.format !== 'ink-data-paths-v1' ||
    Buffer.byteLength(JSON.stringify(packet)) > 8 * 1024 * 1024
  )
    fail('Invalid bounded data-path packet');
  options({ ...packet.effort, workload: 'workload.json' });
  const { identity, ...body } = packet;
  if (
    storageIdentity(body) !== identity ||
    packet.source !== inkProgramKey(program) ||
    JSON.stringify(packet.queries) !== JSON.stringify(queriesOf(ui))
  )
    fail('Storage plan is not bound to this complete app and typed queries');
  const workload = validateStorageWorkload(packet.workload);
  if (
    workload.history.some(
      (op) => op.op === 'read' && !Object.hasOwn(packet.queries, op.query),
    )
  )
    fail('Workload names an undeclared query');
  const ranges = workloadRanges(workload),
    schemas = {
      version: 1,
      tables: workload.tables.map((t) => ({ ...t, rows: [] })),
      history: [],
    };
  if (Object.keys(packet.plans).length !== Object.keys(packet.queries).length)
    fail('Storage plan inventory differs');
  for (const [name, query] of Object.entries(packet.queries)) {
    const plan = packet.plans[name],
      { identity: planId, ...planBody } = plan || {};
    if (
      !fields(plan, [
        'format',
        'contract',
        'selected',
        'recipe',
        'target',
        'rows',
        'selection',
        'fallback',
        'identity',
      ]) ||
      plan.format !== 'ink-data-path-v1' ||
      !fields(plan.selection, ['mode', 'workload', 'receipts', 'reason']) ||
      !['auto', 'baseline'].includes(plan.selection.mode) ||
      !Array.isArray(plan.selection.receipts) ||
      typeof plan.selection.reason !== 'string' ||
      plan.selection.reason.length > 512 ||
      !fields(plan.fallback, ['family', 'reason']) ||
      plan.fallback.reason !== 'missing-or-inapplicable-evidence' ||
      !fields(plan.contract, [
        'format',
        'logical',
        'schemas',
        'output',
        'dependencies',
        'candidates',
        'backend',
        'collation',
      ]) ||
      plan.contract.format !== 'ink-storage-query-contract-v1' ||
      !digest(plan.contract.backend) ||
      (plan.selection.mode === 'auto' && packet.effort.mode !== 'auto') ||
      !plain(plan.contract.collation) ||
      !plain(plan.rows)
    )
      fail('Invalid data-path contract fields');
    if (
      !plan ||
      storageIdentity(planBody) !== planId ||
      plan.selection.workload !== storageIdentity(workload) ||
      plan.fallback?.family !== 'scan'
    )
      fail('Storage evidence or fallback binding differs');
    const world = new StorageFixture(schemas),
      scoped = scopeStorageQuery(query, fixtureNamespace),
      derived = unScopeContract(describeRelational(world, scoped));
    const structural = (value) =>
      JSON.stringify({
        logical: value.logical,
        schemas: value.schemas,
        output: value.output,
        dependencies: value.dependencies,
        candidates: value.candidates,
      });
    if (structural(derived) !== structural(plan.contract))
      fail('Storage proof obligations differ from the typed operator tree');
    if (
      !digest(plan.target) ||
      !plan.rows ||
      Object.keys(plan.rows).sort().join() !==
        derived.dependencies
          .map((d) => d.alias)
          .sort()
          .join() ||
      Object.values(plan.rows).some(
        (r) =>
          !fields(r, ['min', 'max']) ||
          !Number.isSafeInteger(r.min) ||
          !Number.isSafeInteger(r.max) ||
          r.min < 0 ||
          r.min > r.max ||
          r.max > 10256,
      )
    )
      fail('Invalid storage applicability bounds');
    if (
      derived.dependencies.some(
        (dep) =>
          JSON.stringify(plan.rows[dep.alias]) !==
          JSON.stringify(ranges[dep.tableId]),
      )
    )
      fail('Storage row guards differ from the measured history');
    const candidate = derived.candidates.find(
      (c) =>
        c.id === plan.selected &&
        JSON.stringify(c.recipe) === JSON.stringify(plan.recipe),
    );
    if (!candidate) fail('Physical recipe cannot be derived from source');
    if (plan.recipe.family !== 'scan' || plan.selection.receipts.length) {
      const receipts = plan.selection.receipts,
        ids = new Set();
      if (
        receipts.length !==
        Math.min(packet.effort.candidates, derived.candidates.length)
      )
        fail('Invalid storage measurement inventory');
      for (const r of receipts) {
        if (
          !fields(r, [
            'candidate',
            'valid',
            'reason',
            'trials',
            'observations',
          ]) ||
          !digest(r.observations) ||
          ids.has(r.candidate) ||
          !derived.candidates
            .slice(0, packet.effort.candidates)
            .some((c) => c.id === r.candidate) ||
          typeof r.valid !== 'boolean' ||
          !Array.isArray(r.trials) ||
          r.trials.length !== packet.effort.trials ||
          r.trials.some(
            (t) =>
              !fields(t, [
                'setupNS',
                'readNS',
                'writeNS',
                'totalNS',
                'heapGrowth',
              ]) ||
              ['setupNS', 'readNS', 'writeNS', 'totalNS', 'heapGrowth'].some(
                (k) => !Number.isSafeInteger(t[k]) || t[k] < 0,
              ) ||
              t.totalNS !== t.setupNS + t.readNS + t.writeNS,
          )
        )
          fail('Invalid lifecycle evidence');
        ids.add(r.candidate);
      }
      const base = receipts.find(
          (r) => r.candidate === derived.candidates[0].id,
        ),
        mean = (r) =>
          r.trials.reduce((n, t) => n + t.totalNS, 0) / r.trials.length;
      if (
        !base?.valid ||
        receipts.some((r) => r.observations !== base.observations)
      )
        fail('Comparable scan baseline is missing');
      let winner = base;
      if (plan.selection.mode === 'auto')
        for (const r of receipts)
          if (
            r.valid &&
            mean(r) < mean(winner) &&
            mean(r) < mean(base) * 0.9 &&
            r.trials.filter((t, i) => t.totalNS < base.trials[i].totalNS)
              .length >= Math.ceil((r.trials.length * 2) / 3)
          )
            winner = r;
      if (winner.candidate !== plan.selected)
        fail('Storage selection differs from measured lifecycle evidence');
    }
    checkDataPath(world, scoped, {
      ...plan,
      contract: scopeContract(plan.contract, fixtureNamespace),
    });
  }
  return structuredClone(packet);
}
export function dataPathSummary(packet) {
  return packet
    ? {
        identity: packet.identity,
        paths: Object.fromEntries(
          Object.entries(packet.plans).map(([name, p]) => [
            name,
            {
              identity: p.identity,
              family: p.recipe.family,
              selection: p.selection.reason,
              target: p.target,
              rows: p.rows,
            },
          ]),
        ),
      }
    : null;
}
export class DataPaths {
  constructor(world, packet, namespace) {
    this.world = world;
    this.packet = {
      plans: packet.plans,
      queries: packet.queries,
      workload: {
        version: 1,
        tables: packet.workload.tables.map((t) => ({
          id: t.id,
          columns: t.columns,
          rows: [],
        })),
        history: [],
      },
    };
    this.namespace = namespace;
    this.handles = new Map();
  }
  query(name, input) {
    const plan = this.packet.plans[name];
    if (!plan) fail('Unknown admitted storage path');
    if (!this.handles.has(name)) {
      const workload = structuredClone(this.packet.workload),
        fixture = new StorageFixture(workload, { namespace: this.namespace });
      const query = scopeStorageQuery(
          this.packet.queries[name],
          this.namespace,
        ),
        artifact = {
          ...plan,
          contract: scopeContract(plan.contract, this.namespace),
        };
      this.handles.set(name, checkDataPath(fixture, query, artifact));
    }
    const control = {
      admitted: this.handles.get(name),
      target: storageTarget(),
    };
    try {
      return queryRelational(this.world, input, control);
    } catch (error) {
      if (error.status && error.status !== 500) throw error;
      this.world.relationalStorage?.reset();
      return queryRelational(this.world, input, {
        ...control,
        forceScan: 'derived-cache-failed',
      });
    }
  }
}
