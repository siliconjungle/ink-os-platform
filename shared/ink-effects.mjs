const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
const object = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const symbol = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value) &&
  !value.startsWith('__');
const resource = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);
const fields = (value, allowed, required = allowed) =>
  object(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));
export const EFFECT_KINDS = Object.freeze([
  'http',
  'file',
  'clock',
  'random',
  'process',
  'subscription',
  'app',
]);
export const EFFECT_CAPABILITIES = Object.freeze({
  http: 'effects.http',
  file: 'effects.files',
  clock: 'effects.clock',
  random: 'effects.random',
  process: 'effects.process',
  subscription: 'effects.subscribe',
  app: 'apps.invoke',
});
export const EFFECT_CONTRACT_VERSION = 1;
export function inkEffects(input) {
  if (
    !fields(input, ['version', 'protocols']) ||
    input.version !== 1 ||
    !Array.isArray(input.protocols) ||
    !input.protocols.length ||
    input.protocols.length > 8
  )
    fail('Declare 1–8 version 1 Ink effect protocols');
  const names = new Set();
  return {
    version: 1,
    protocols: input.protocols
      .map((protocol) => {
        if (
          !fields(protocol, [
            'entry',
            'resume',
            'operations',
            'maxSteps',
            'deadlineMs',
          ]) ||
          !symbol(protocol.entry) ||
          !symbol(protocol.resume) ||
          protocol.entry === protocol.resume ||
          names.has(protocol.entry) ||
          !Number.isInteger(protocol.maxSteps) ||
          protocol.maxSteps < 1 ||
          protocol.maxSteps > 32 ||
          !Number.isInteger(protocol.deadlineMs) ||
          protocol.deadlineMs < 1 ||
          protocol.deadlineMs > 30000 ||
          !Array.isArray(protocol.operations) ||
          !protocol.operations.length ||
          protocol.operations.length > 16
        )
          fail('Invalid bounded Ink effect protocol');
        names.add(protocol.entry);
        const operations = new Set();
        return {
          entry: protocol.entry,
          resume: protocol.resume,
          maxSteps: protocol.maxSteps,
          deadlineMs: protocol.deadlineMs,
          operations: protocol.operations
            .map((operation) => {
              if (
                !fields(operation, [
                  'name',
                  'kind',
                  'resource',
                  'effect',
                  'retry',
                  'deadlineMs',
                ]) ||
                !resource(operation.name) ||
                operations.has(operation.name) ||
                !EFFECT_KINDS.includes(operation.kind) ||
                !['read', 'write', 'volatile', 'subscription'].includes(
                  operation.effect,
                ) ||
                !['recorded', 'observe-again'].includes(operation.retry) ||
                !Number.isInteger(operation.deadlineMs) ||
                operation.deadlineMs < 1 ||
                operation.deadlineMs > protocol.deadlineMs
              )
                fail('Invalid typed effect operation');
              if (
                (['clock', 'random'].includes(operation.kind) &&
                  operation.effect !== 'volatile') ||
                (operation.kind === 'subscription' &&
                  operation.effect !== 'subscription') ||
                (operation.kind === 'process' &&
                  operation.effect !== 'write') ||
                (['file', 'app', 'http'].includes(operation.kind) &&
                  !['read', 'write'].includes(operation.effect)) ||
                (operation.retry === 'observe-again' &&
                  !(operation.kind === 'http' && operation.effect === 'read'))
              )
                fail(
                  'Effect retry or mutation classification is incompatible with its driver',
                );
              if (operation.kind === 'app') {
                if (
                  !fields(operation.resource, [
                    'appId',
                    'releaseId',
                    'entry',
                  ]) ||
                  !/^([a-f0-9]{32})$/.test(operation.resource.appId) ||
                  !/^([a-f0-9]{32})$/.test(operation.resource.releaseId) ||
                  !symbol(operation.resource.entry)
                )
                  fail(
                    'Typed app calls bind an app, release and exported entry',
                  );
              } else if (!resource(operation.resource))
                fail('Effect resources must be fixed names');
              operations.add(operation.name);
              return {
                ...operation,
                resource: object(operation.resource)
                  ? { ...operation.resource }
                  : operation.resource,
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      })
      .sort((a, b) => a.entry.localeCompare(b.entry)),
  };
}
const scalar = (kind) => ({ kind }),
  option = (element) => ({ kind: 'option', element }),
  list = (element) => ({ kind: 'list', element }),
  record = (fields) => ({
    kind: 'record',
    fields: Object.entries(fields).map(([name, type]) => ({ name, type })),
  });
const text = scalar('string'),
  u32 = scalar('u32'),
  u64 = scalar('u64'),
  bool = scalar('bool'),
  unit = scalar('unit');
export const EFFECT_REQUESTS = Object.freeze({
  http: record({
    method: text,
    path: text,
    body: option(text),
    bytes: option(list(u32)),
    expected: option(text),
  }),
  file: record({
    action: text,
    name: text,
    value: option(text),
    bytes: option(list(u32)),
    expected: option(u64),
  }),
  clock: record({ delayMs: u32 }),
  random: record({ count: u32 }),
  process: record({ input: option(text), bytes: option(list(u32)) }),
  subscription: record({ action: text, handle: option(text) }),
});
export const EFFECT_RESPONSES = Object.freeze({
  http: record({
    status: u32,
    body: option(text),
    bytes: list(u32),
    etag: option(text),
  }),
  file: record({
    exists: bool,
    value: option(text),
    bytes: list(u32),
    version: u64,
  }),
  clock: record({ unixMs: u64 }),
  random: record({ bytes: list(u32) }),
  process: record({
    stdout: option(text),
    stderr: option(text),
    stdoutBytes: list(u32),
    stderrBytes: list(u32),
    exitCode: scalar('i32'),
    signal: option(text),
  }),
  subscription: record({
    handle: text,
    version: u64,
    event: option(
      record({ type: text, id: text, namespace: text, version: u64 }),
    ),
  }),
});
export const EFFECT_ERROR = record({
  code: text,
  message: text,
  certainty: text,
  retryable: bool,
});
export function resolveEffectType(type, named, seen = new Set()) {
  if (!type || typeof type !== 'object') fail('Missing checked effect type');
  if (type.kind === 'ref') {
    if (seen.has(type.name) || !named[type.name])
      fail('Effect boundary types must be finite checked values');
    return resolveEffectType(
      named[type.name],
      named,
      new Set([...seen, type.name]),
    );
  }
  if (type.kind === 'record')
    return record(
      Object.fromEntries(
        type.fields.map((field) => [
          field.name,
          resolveEffectType(field.type, named, seen),
        ]),
      ),
    );
  if (['option', 'list', 'vector'].includes(type.kind))
    return { ...type, element: resolveEffectType(type.element, named, seen) };
  if (type.kind === 'result')
    return {
      kind: 'result',
      ok: resolveEffectType(type.ok, named, seen),
      error: resolveEffectType(type.error, named, seen),
    };
  return type;
}
export function effectTypeEqual(a, b) {
  if (a?.kind !== b?.kind) return false;
  if (a.kind === 'record')
    return (
      a.fields.length === b.fields.length &&
      a.fields.every((field) => {
        const other = b.fields.find((value) => value.name === field.name);
        return other && effectTypeEqual(field.type, other.type);
      })
    );
  if (['option', 'list', 'vector'].includes(a.kind))
    return (
      JSON.stringify(
        Object.keys(a)
          .filter((key) => key !== 'element')
          .sort()
          .map((key) => [key, a[key]]),
      ) ===
        JSON.stringify(
          Object.keys(b)
            .filter((key) => key !== 'element')
            .sort()
            .map((key) => [key, b[key]]),
        ) && effectTypeEqual(a.element, b.element)
    );
  if (a.kind === 'result')
    return effectTypeEqual(a.ok, b.ok) && effectTypeEqual(a.error, b.error);
  return JSON.stringify(a) === JSON.stringify(b);
}
export function inkEffectProtocols(spec, entries, named) {
  const protocols = [];
  for (const protocol of spec.effects?.protocols || []) {
    const begin = entries.find((entry) => entry.name === protocol.entry),
      resume = entries.find((entry) => entry.name === protocol.resume);
    if (
      !begin ||
      !resume ||
      begin.action ||
      resume.action ||
      !spec.exports.includes(begin.name) ||
      spec.exports.includes(resume.name) ||
      spec.view === begin.name ||
      spec.host?.bindings.some((binding) => binding.entry === begin.name) ||
      resume.params.length !== 2
    )
      fail(
        'Effect protocols require an exported pure begin and a private pure two-argument resume; views and legacy bindings cannot dispatch effects',
      );
    const step = resolveEffectType(begin.result, named),
      resumed = resolveEffectType(resume.result, named);
    if (
      step.kind !== 'result' ||
      !effectTypeEqual(step, resumed) ||
      step.error.kind !== 'record' ||
      step.error.fields.length !== 2
    )
      fail('Effect functions must return the same Result<Output,Pending>');
    const pending = Object.fromEntries(
      step.error.fields.map((field) => [field.name, field.type]),
    );
    if (
      !pending.state ||
      !pending.request ||
      !effectTypeEqual(
        resolveEffectType(resume.params[0].type, named),
        pending.state,
      )
    )
      fail('Protocol continuation state type mismatch');
    const request = pending.request,
      reply = resolveEffectType(resume.params[1].type, named);
    const requestFields = {
      operation: text,
      ...Object.fromEntries(
        EFFECT_KINDS.map((kind) => [
          kind,
          option(kind === 'app' ? unit : EFFECT_REQUESTS[kind]),
        ]),
      ),
    };
    const replyFields = {
      operation: text,
      sequence: u32,
      version: option(text),
      error: option(EFFECT_ERROR),
      ...Object.fromEntries(
        EFFECT_KINDS.map((kind) => [
          kind,
          option(kind === 'app' ? unit : EFFECT_RESPONSES[kind]),
        ]),
      ),
    };
    const requestApp = request.fields?.find(
        (field) => field.name === 'app',
      )?.type,
      replyApp = reply.fields?.find((field) => field.name === 'app')?.type;
    if (requestApp?.kind !== 'option' || replyApp?.kind !== 'option')
      fail('Protocol app slots must be typed Options');
    requestFields.app = requestApp;
    replyFields.app = replyApp;
    if (
      !effectTypeEqual(request, record(requestFields)) ||
      !effectTypeEqual(reply, record(replyFields))
    )
      fail(
        'Protocol request/reply must use the version 1 typed effect boundary',
      );
    protocols.push({
      ...protocol,
      output: step.ok,
      state: pending.state,
      request,
      reply,
      appInput: requestApp.element,
      appOutput: replyApp.element,
    });
  }
  return protocols;
}
