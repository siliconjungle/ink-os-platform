// Admission of cross-app read plans: the footprint rule.
//
// A plan may change how a declared, already-checked link runs. It may never
// add a link or let more authority cross one. Admission derives the plan's
// footprint from the compiler's IR facts of both exact releases and accepts it
// only when the footprint is within what the declared link already allows:
//
// - the provider entry is an exported readonly query (no writes, emits or
//   effects), and the plan reads only the roots that query reads;
// - every consumer function the plan moves next to the provider's data is
//   pure by the IR (no read, write, emit, action or effect anywhere in its
//   call closure) and is typed over the exact exported row type;
// - the only capabilities used are the ones the link already requires: the
//   consumer's apps.invoke (for another app) and code.execute, and the
//   provider's code.execute.
//
// The admitted plan is bound to both release identities; callers re-check
// both releases and capabilities on every run.
import { createHash } from 'node:crypto';
import { resolveEffectType, effectTypeEqual } from '../shared/ink-effects.mjs';
import { linkPlanFunctions } from '../shared/ink-link-plan.mjs';

export const LINK_PLAN_FORMAT = 'ink-os-link-plan-v1';
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};
const canonical = (value) =>
  Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
      : JSON.stringify(value);
const sha = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const subset = (a, b) => a.every((x) => b.includes(x));

/** Identity of a pure function's code: its call closure and the program's types. */
export function functionIdentity(core, name) {
  const program = (typeof core === 'string' ? JSON.parse(core) : core).program,
    byName = new Map(program.functions.map((f) => [f.name, f])),
    closure = new Map(),
    visit = (value) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object')
        for (const [key, child] of Object.entries(value)) {
          if (key === 'Call' && Array.isArray(child) && byName.has(child[0])) add(child[0]);
          visit(child);
        }
    },
    add = (fn) => {
      if (closure.has(fn)) return;
      closure.set(fn, byName.get(fn));
      visit(byName.get(fn).body);
    };
  if (!byName.has(name)) fail('Unknown consumer function ' + name);
  add(name);
  return sha({
    root: name,
    functions: [...closure.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    records: program.records,
    enums: program.enums,
  });
}

/**
 * Derive and check a plan's footprint. `data` is the consumer port's resolved
 * UiData type; `provider`/`consumer` carry each release's compiled program,
 * IR footprints and declared capabilities.
 */
export function admitLinkPlan({ binding, data, provider, consumer }) {
  const plan = binding.plan;
  if (!provider.footprints || !consumer.footprints)
    fail('Link plans need a compiler that reports IR footprints', 409);
  const query = provider.footprints.graphs.get(binding.entry);
  if (
    !query ||
    query.kind !== 'query' ||
    query.roots.write.length ||
    query.emits?.length ||
    query.effects?.length
  )
    fail('Link plans read an exported readonly query');
  const rowType = data.fields.find((field) => field.name === 'rows').type.element,
    named = consumer.compiled.artifact.manifest.named_types,
    code = linkPlanFunctions(plan).map(({ name, role, result }) => {
      const fn = consumer.compiled.artifact.manifest.functions.find((f) => f.name === name && !f.internal),
        graph = consumer.footprints.graphs.get(name);
      if (!fn || !graph || graph.kind !== 'function')
        fail(`Link plan ${role} ${name} is not a consumer function`);
      if (!graph.pure)
        fail(`Link plan ${role} ${name} is not pure: moved code may not read, write, emit, call actions or perform effects`);
      if (
        fn.params.length !== 1 ||
        !effectTypeEqual(resolveEffectType(fn.params[0].type, named), rowType) ||
        resolveEffectType(fn.result, named).kind !== result
      )
        fail(`Link plan ${role} ${name} must take the exact row type and return ${result}`);
      return { function: name, role, pure: true, identity: functionIdentity(consumer.compiled.artifact.core, name) };
    });
  const footprint = {
      reads: [...query.roots.read].sort(),
      writes: [],
      emits: [],
      effects: [],
      capabilities: {
        provider: ['code.execute'],
        consumer: [...(binding.appId === consumer.appId ? [] : ['apps.invoke']), 'code.execute'],
      },
    },
    declared = {
      reads: query.roots.read,
      capabilities: { provider: provider.capabilities || [], consumer: consumer.capabilities || [] },
    };
  if (
    !subset(footprint.reads, declared.reads) ||
    footprint.writes.length ||
    footprint.emits.length ||
    footprint.effects.length ||
    !subset(footprint.capabilities.provider, declared.capabilities.provider) ||
    !subset(footprint.capabilities.consumer, declared.capabilities.consumer)
  )
    fail('The link plan footprint exceeds the declared link', 403);
  const record = {
    format: LINK_PLAN_FORMAT,
    provider: { appId: binding.appId, releaseId: binding.releaseId, entry: binding.entry, input: binding.input || '[]' },
    consumer: { appId: consumer.appId, releaseId: consumer.releaseId },
    plan,
    code,
    footprint,
  };
  // The shared identity omits the consumer: identical code over the same
  // binding computes the same value for every consumer.
  return Object.freeze({
    ...record,
    identity: sha(record),
    shared: sha({ provider: record.provider, plan, code: code.map((c) => [c.role, c.identity]) }),
  });
}
