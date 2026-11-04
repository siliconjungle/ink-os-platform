import { installedInk } from './ink-apps.mjs';
import { inkProgramKey } from './ink-compiler.mjs';
import { queryWorld } from './query.mjs';

const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
const canonical = (value) =>
  JSON.stringify(value, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );

/** Derive authority from the checked selected release, never command.effect or
 * access-analysis hints. Action commutation does not preserve commit versions. */
export async function checkedWorkflowPlan(platform, run) {
  const parallel = run.definition.scheduling?.mode === 'parallel',
    apps = new Map(),
    nodes = [];
  if (
    parallel &&
    (!Number.isInteger(run.definition.scheduling.maxConcurrent) ||
      run.definition.scheduling.maxConcurrent < 1 ||
      run.definition.scheduling.maxConcurrent > 4)
  )
    fail(400, 'Invalid persisted workflow concurrency limit');
  for (const step of run.steps) {
    let contract = {
      kind: 'ordered',
      reason: 'Unknown/external/stateful observations retain source order',
    };
    if (parallel && !step.command.poll) {
      if (step.command.handler.type === 'query')
        contract = {
          kind: 'world-snapshot',
          reason: 'Host query over one captured World version',
        };
      else if (step.command.handler.type === 'ink') {
        const key = step.appId + ':' + step.releaseId;
        if (!apps.has(key))
          apps.set(key, installedInk(platform, step.appId, step.releaseId));
        const app = await apps.get(key),
          entry = app.entries.find(
            (entry) => entry.name === step.command.handler.entry,
          );
        if (
          entry &&
          !entry.action &&
          !entry.hostBinding &&
          !entry.effectProtocol
        )
          contract = {
            kind: 'ink-pure',
            source: inkProgramKey(app.source),
            entry: entry.name,
            reason: 'Compiler-checked state/effect-free function',
          };
      }
    }
    const dependencies = new Set([
      ...(step.dependsOn || []),
      ...Object.values(step.bindings)
        .filter((binding) => binding.source === 'step')
        .map((binding) => binding.stepId),
    ]);
    for (const previous of nodes)
      if (
        !parallel ||
        contract.kind === 'ordered' ||
        previous.contract.kind === 'ordered'
      )
        dependencies.add(previous.id);
    nodes.push({ id: step.id, dependencies: [...dependencies], contract });
  }
  return {
    version: 1,
    semantics: 'ink-os-workflow-frontier-v1',
    mode: parallel ? 'parallel' : 'sequential',
    maxConcurrent: parallel ? run.definition.scheduling.maxConcurrent : 1,
    nodes,
  };
}

/** A detached bounded snapshot shared only by this admitted ready frontier.
 * Equivalent queries share physical work; callers always receive detached data. */
export function captureWorkflowSnapshot(
  world,
  { maxBytes = 32 * 1024 * 1024, maxRows = 20000 } = {},
) {
  const version = world.version,
    records = world
      .publicAll()
      .filter(
        (object) =>
          !object.archived &&
          !object.tags?.some((tag) =>
            ['app-source', 'app-artifact'].includes(tag),
          ),
      );
  if (
    records.length > maxRows ||
    Buffer.byteLength(JSON.stringify(records)) > maxBytes
  )
    fail(413, 'Workflow snapshot exceeds its bounded read batch');
  const cache = new Map(),
    snapshot = { version, physicalQueries: 0, logicalQueries: 0 };
  const view = {
    version,
    all: () => structuredClone(records),
    publicAll: () => structuredClone(records),
    publicObject: (object) => structuredClone(object),
    query: (name, args) => {
      if (name !== 'in_namespace') fail(400, 'Unsupported snapshot query');
      return structuredClone(
        records.filter((object) => object.namespace === args[0]),
      );
    },
  };
  snapshot.query = (input) => {
    snapshot.logicalQueries++;
    const key = canonical(input);
    if (!cache.has(key)) {
      snapshot.physicalQueries++;
      cache.set(key, queryWorld(view, input));
    }
    return structuredClone(cache.get(key));
  };
  return snapshot;
}

/** Bounded DAG dispatcher. Failure stops new admission and drains siblings;
 * results stay indexed by source position, independently of completion order. */
export async function executeWorkflowGraph(
  nodes,
  {
    limit = 4,
    completed = [],
    cancelled = () => false,
    prepare = async () => new Map(),
    execute,
  } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4)
    fail(400, 'Workflow graph admission supports 1–4 concurrent steps');
  const done = new Set(completed),
    pending = new Set(
      nodes.filter((node) => !done.has(node.id)).map((node) => node.id),
    ),
    active = new Map(),
    errors = [];
  try {
    while (pending.size || active.size) {
      if (!errors.length && !cancelled()) {
        const ready = nodes
          .filter(
            (node) =>
              pending.has(node.id) &&
              node.dependencies.every((id) => done.has(id)),
          )
          .slice(0, limit - active.size);
        if (ready.length) {
          const contexts = await prepare(ready);
          for (const node of ready) {
            const context = contexts.get(node.id);
            if (cancelled()) {
              await context?.release?.();
              continue;
            }
            pending.delete(node.id);
            const task = Promise.resolve()
              .then(() => execute(node, context))
              .finally(() => context?.release?.())
              .then(
                () => ({ id: node.id }),
                (error) => ({ id: node.id, error }),
              );
            active.set(node.id, task);
          }
        }
      }
      if (!active.size) {
        if (pending.size && !errors.length && !cancelled())
          fail(409, 'Workflow dependencies are not satisfied');
        break;
      }
      const result = await Promise.race(active.values());
      active.delete(result.id);
      if (result.error) errors.push(result);
      else done.add(result.id);
    }
  } finally {
    const remaining = await Promise.all(active.values());
    for (const result of remaining) if (result.error) errors.push(result);
  }
  errors.sort(
    (a, b) =>
      nodes.findIndex((node) => node.id === a.id) -
      nodes.findIndex((node) => node.id === b.id),
  );
  return { errors, pending: [...pending] };
}
