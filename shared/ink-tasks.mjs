// The tasks contract of an Ink app: which tasks are callable and how each
// external effect a task declares is performed.
//
// An Ink `effect` is a typed request the program never performs itself. Each
// one is bound here to one capability-checked driver of the effect system:
//
// - model: a language model named by an operator resource (effects.model).
//   Any signature; the reply must decode to the declared type and pass the
//   step's contract, otherwise the authored fallback is used.
// - http:  an operator HTTP resource (effects.http). The effect takes
//   HttpEffectRequest and returns Result<HttpEffectResponse, EffectError>.
// - app:   an exported entry of an exact app release (apps.invoke), with the
//   entry's own parameter and result types.
// - clock / random: the wall clock or system randomness, with the effect
//   library's request and response records.
//
// A binding that writes (http or app `write`) must be an `ordered effect`, so
// it runs in source order after every earlier step and never speculatively.
export const TASK_KINDS = Object.freeze(['model', 'http', 'app', 'clock', 'random']);
export const TASK_CAPABILITIES = Object.freeze({
  model: 'effects.model',
  http: 'effects.http',
  app: 'apps.invoke',
  clock: 'effects.clock',
  random: 'effects.random',
});
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed, required = allowed) =>
  object(value) && Object.keys(value).every((k) => allowed.includes(k)) && required.every((k) => Object.hasOwn(value, k));
const symbol = (value) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value) && !value.startsWith('__');
const resource = (value) => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);
const bounded = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function inkTasks(input) {
  if (
    !keys(input, ['version', 'entries', 'effects', 'deadlineMs', 'concurrency'], ['version', 'entries', 'effects']) ||
    input.version !== 1 ||
    !Array.isArray(input.entries) || !input.entries.length || input.entries.length > 16 ||
    input.entries.some((name) => !symbol(name)) || new Set(input.entries).size !== input.entries.length ||
    !Array.isArray(input.effects) || input.effects.length > 32 ||
    (input.deadlineMs !== undefined && !bounded(input.deadlineMs, 1, 30000)) ||
    (input.concurrency !== undefined && !bounded(input.concurrency, 1, 16))
  )
    fail('Declare a version 1 tasks contract: 1–16 task entries and up to 32 effect bindings');
  const deadlineMs = input.deadlineMs ?? 30000,
    names = new Set();
  const effects = input.effects.map((binding) => {
    if (
      !keys(binding, ['name', 'kind', 'resource', 'effect', 'deadlineMs']) ||
      !symbol(binding.name) || names.has(binding.name) ||
      !TASK_KINDS.includes(binding.kind) ||
      !bounded(binding.deadlineMs, 1, deadlineMs)
    )
      fail('Each task effect binding names a declared effect, a driver kind, a resource, an effect class and a deadline');
    names.add(binding.name);
    const k = binding.kind,
      e = binding.effect;
    if (
      (k === 'model' && (e !== 'read' || !resource(binding.resource))) ||
      (k === 'http' && (!['read', 'write'].includes(e) || !resource(binding.resource))) ||
      (k === 'clock' && (e !== 'volatile' || binding.resource !== 'wall-clock')) ||
      (k === 'random' && (e !== 'volatile' || binding.resource !== 'system'))
    )
      fail('Task effect resource or effect class is incompatible with its driver');
    if (k === 'app') {
      const r = binding.resource;
      if (!['read', 'write'].includes(e) || !keys(r, ['appId', 'releaseId', 'entry']) || !/^[a-f0-9]{32}$/.test(r.appId) || !/^[a-f0-9]{32}$/.test(r.releaseId) || !symbol(r.entry))
        fail('Task app effects bind an exact app, release and exported entry');
    }
    return { ...binding, resource: object(binding.resource) ? { ...binding.resource } : binding.resource };
  });
  return {
    version: 1,
    entries: [...input.entries].sort(),
    effects: effects.sort((a, b) => a.name.localeCompare(b.name)),
    deadlineMs,
    concurrency: input.concurrency ?? 8,
  };
}
