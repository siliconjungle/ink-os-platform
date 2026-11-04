// Ink tasks run through the effect system's checks and drivers.
//
// A task (ink-lang docs/effect-tasks.md) orchestrates typed external effects
// around exact state. The compiler lowers it to generated readonly queries
// and a manifest of steps and dependencies; the vendored runner
// (ink-task-runner.mjs) schedules the steps, so independent effects overlap
// while the result stays that of sequential execution. This service supplies:
//
// - state calls: only the running task's generated queries and the queries
//   and changes its steps name, on the app's own state, with stable request
//   identities for changes;
// - effects: each Ink effect is performed by the driver its binding names
//   (shared/ink-tasks.mjs), after the same capability and operator-resource
//   checks protocols use. Driver failures of http/clock/random become typed
//   EffectError values; model and app replies are checked by the step's
//   generated accept query like any other reply;
// - a durable trace in World (`ink-task-run`) bound to the release. It replays
//   offline without any effect: `ink replay-task SOURCE TRACE --restore SNAPSHOT`
//   or the runtime's replayTask against a snapshot taken before the run.
import { createHash, randomBytes } from 'node:crypto';
import { installedInk, runInstalledInk } from './ink-apps.mjs';
import { runTask, TaskFailed, effectPrompt, replyValue, MANIFEST_FORMAT } from './ink-task-runner.mjs';
import { httpEffect, effectFailure } from './ink-effect-io.mjs';
import { hostBudget } from './execution-budget.mjs';
import { TASK_CAPABILITIES } from '../shared/ink-tasks.mjs';
import { EFFECT_REQUESTS, EFFECT_RESPONSES, EFFECT_ERROR, resolveEffectType, effectTypeEqual } from '../shared/ink-effects.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { displayWire } from '../shared/ink-values.mjs';

const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
const MAX_TRACE = 256 * 1024,
  MAX_PROMPT = 64 * 1024,
  MAX_REPLY = 256 * 1024;
const RECORD_KINDS = ['http', 'clock', 'random'];

/** The task manifest of a compiled program, or null. */
export function taskManifest(artifact) {
  const core = typeof artifact.core === 'string' ? JSON.parse(artifact.core) : artifact.core,
    tasks = core?.program?.contracts?.tasks;
  return tasks?.tasks?.length ? { format: MANIFEST_FORMAT, effects: tasks.effects || [], tasks: tasks.tasks } : null;
}

/** Descriptor types of each effect, read from the generated queries that feed and check it. */
function effectTypes(manifest, artifact) {
  const actions = new Map((artifact.manifest.state?.actions || []).map((a) => [a.name, a])),
    types = new Map();
  for (const task of manifest.tasks)
    for (const step of task.steps)
      if (step.kind === 'effect' && !types.has(step.callee)) {
        const accept = actions.get(step.accept);
        types.set(step.callee, {
          params: (step.args || []).map((name) => actions.get(name).result),
          reply: accept.params.at(-1).type,
        });
      }
  return types;
}

/**
 * Release admission: every declared effect has exactly one binding, writes
 * are ordered, record-typed drivers match the effect library's types, and the
 * listed tasks exist.
 */
export function checkTaskContract(contract, artifact) {
  const manifest = taskManifest(artifact);
  if (!manifest) fail(400, 'The tasks contract names tasks the program does not declare');
  const named = artifact.manifest.named_types,
    declared = new Map(manifest.effects.map((e) => [e.name, e])),
    types = effectTypes(manifest, artifact);
  for (const name of contract.entries)
    if (!manifest.tasks.some((t) => t.name === name)) fail(400, 'Unknown Ink task ' + name);
  for (const effect of manifest.effects)
    if (!contract.effects.some((b) => b.name === effect.name)) fail(400, 'Bind Ink effect ' + effect.name + ' to a driver');
  for (const binding of contract.effects) {
    const effect = declared.get(binding.name);
    if (!effect) fail(400, 'Task effect binding ' + binding.name + ' names no declared effect');
    if (binding.effect === 'write' && !effect.ordered)
      fail(400, 'Effect ' + binding.name + ' writes, so declare it as an ordered effect');
    const type = types.get(binding.name);
    if (type && RECORD_KINDS.includes(binding.kind)) {
      const expected = { kind: 'result', ok: EFFECT_RESPONSES[binding.kind], error: EFFECT_ERROR };
      if (
        type.params.length !== 1 ||
        !effectTypeEqual(resolveEffectType(type.params[0], named), EFFECT_REQUESTS[binding.kind]) ||
        !effectTypeEqual(resolveEffectType(type.reply, named), expected)
      )
        fail(400, `Effect ${binding.name} must take the ${binding.kind} effect request and return Result of its response and EffectError`);
    }
  }
  return manifest;
}

const typedError = (error) => ({
  Err: {
    code: error.effectCode || 'Transport',
    message: String(error.message).slice(0, 500),
    certainty: error.certainty || 'unknown',
    retryable: false,
  },
});

/** One completion from an operator model resource (Anthropic Messages API). */
export async function modelComplete(profile, prompt, signal, owner) {
  if (Buffer.byteLength(prompt) > MAX_PROMPT) throw effectFailure('ResourceLimit', 'Model prompt exceeds 64 KiB');
  return hostBudget.run({ owner, resources: { network: 1 }, signal, label: 'model effect' }, async () => {
    const response = await fetch(profile.origin + '/v1/messages', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...profile.headers },
      body: JSON.stringify({ model: profile.model, max_tokens: profile.maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    const text = await response.text();
    if (text.length > MAX_REPLY) throw effectFailure('ResourceLimit', 'Model reply exceeds 256 KiB', 'applied');
    if (!response.ok) throw effectFailure('Transport', 'Model request failed with status ' + response.status, 'applied');
    const body = JSON.parse(text);
    return (body.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  });
}

export class InkTasks {
  constructor({ platform }) {
    this.platform = platform;
    this.runs = 0;
  }
  policy() {
    const policy = this.platform.effects?.policy;
    if (!policy) fail(503, 'The effect service is unavailable');
    return policy;
  }
  resource(binding, appId) {
    const profile = this.policy().resources.get(binding.resource);
    if (!profile || profile.kind !== binding.kind || !profile.namespaces.some((n) => n === '*' || n === appId))
      throw effectFailure('Denied', 'Named effect resource is not granted to this application');
    return profile;
  }
  handlers(app, contract, types, named, runId) {
    const appId = app.appId,
      handlers = {};
    for (const binding of contract.effects) {
      handlers[binding.name] = async (...values) => {
        const context = values.pop(),
          signal = AbortSignal.any([context.signal, AbortSignal.timeout(binding.deadlineMs)]);
        if (binding.kind === 'model') {
          const text = await modelComplete(this.resource(binding, appId), effectPrompt(context.effect, values), signal, appId);
          return replyValue(text);
        }
        if (binding.kind === 'app') return this.app(app, binding, types.get(binding.name), named, values, signal, `task:${runId}:${context.step}`);
        try {
          const payload = values[0];
          if (binding.kind === 'http') {
            const profile = this.resource(binding, appId);
            if (binding.effect === 'read' && !['GET', 'HEAD'].includes(payload.method))
              throw effectFailure('Denied', 'A read effect cannot dispatch an HTTP write');
            return { Ok: await httpEffect(profile, payload, signal, () => {}, appId) };
          }
          if (binding.kind === 'clock') {
            if (payload.delayMs) await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, Number(payload.delayMs));
              signal.addEventListener('abort', () => { clearTimeout(timer); reject(effectFailure('Cancelled', 'Clock wait cancelled')); }, { once: true });
            });
            return { Ok: { unixMs: BigInt(Date.now()) } };
          }
          if (Number(payload.count) > 1024) throw effectFailure('Denied', 'Randomness byte budget is invalid');
          return { Ok: { bytes: [...randomBytes(Number(payload.count))] } };
        } catch (error) {
          if (!error.effectCode) throw error;
          return typedError(error);
        }
      };
    }
    return handlers;
  }
  /** Call an exported entry of an exact app release with the effect's own types. */
  async app(caller, binding, type, named, values, signal, requestId) {
    const target = binding.resource;
    if (target.appId === caller.appId) throw effectFailure('Denied', 'Task app effects call another app');
    const app = await installedInk(this.platform, target.appId, target.releaseId),
      entry = app.entries.find((e) => e.name === target.entry);
    if (!entry || !app.spec.exports.includes(target.entry) || entry.effectProtocol || entry.hostBinding || (binding.effect === 'read' && entry.change))
      throw effectFailure('Denied', 'Target is not an exported direct typed Ink call');
    const targetNamed = app.namedTypes;
    if (
      type &&
      (entry.params.length !== type.params.length ||
        entry.params.some((p, i) => !effectTypeEqual(resolveEffectType(p.type, targetNamed), resolveEffectType(type.params[i], named))) ||
        !effectTypeEqual(resolveEffectType(entry.result, targetNamed), resolveEffectType(type.reply, named)))
    )
      throw effectFailure('TypeMismatch', 'Task app effect types differ from the target entry');
    const result = await runInstalledInk(
      this.platform,
      target.appId,
      { entry: target.entry, input: stringifyExactJSON(values), ...(binding.effect === 'write' ? { requestId } : {}) },
      undefined,
      target.releaseId,
      { signal },
    );
    return parseExactJSON(result.valueWire);
  }
  async prepare(appId, task, principal) {
    const app = await installedInk(this.platform, appId, principal?.releaseId),
      contract = app.spec.tasks;
    if (!contract?.entries.includes(task)) fail(404, 'This app exposes no Ink task ' + task);
    const meta = JSON.parse(this.platform.app(appId).body),
      missing = ['code.execute', ...contract.effects.map((b) => TASK_CAPABILITIES[b.kind])].find((c) => !meta.capabilities?.includes(c));
    if (missing) fail(403, 'Application does not declare ' + missing);
    const compiled = await this.platform.code.compile(app.source),
      manifest = checkTaskContract(contract, compiled.artifact),
      steps = manifest.tasks.find((t) => t.name === task).steps,
      allowed = new Set(manifest.tasks.find((t) => t.name === task).steps.flatMap((s) => [...(s.args || []), s.accept, s.fallback, s.kind === 'effect' ? null : s.callee]).filter(Boolean));
    allowed.add(manifest.tasks.find((t) => t.name === task).ret);
    const authority = this.platform.runtime.bind({ owner: false, appId, namespace: appId, releaseId: app.releaseId });
    return { app: { ...app, appId }, contract, compiled, manifest, steps, allowed, authority };
  }
  caller({ app, compiled, allowed, authority }, runId, signal) {
    let changes = 0;
    return async (name, args) => {
      if (!allowed.has(name)) fail(403, 'A task may call only its own steps');
      const action = compiled.artifact.manifest.state?.actions?.find((a) => a.name === name);
      const result = await this.platform.code.run({
        source: app.source,
        entry: name,
        args,
        task: name.startsWith('__task_'),
        namespace: app.appId,
        stateKey: 'ink-app:state',
        principal: authority,
        signal,
        ...(action?.change ? { requestId: `task:${runId}:c${changes++}` } : {}),
      });
      return parseExactJSON(result.wire).result;
    };
  }
  /** Run a task; returns its exact result, its trace and the stored run's id. */
  async run(appId, input = {}, principal) {
    if (typeof input.task !== 'string') fail(400, 'Name the Ink task to run');
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !input.requestId.length || input.requestId.length > 128))
      fail(400, 'Invalid task request identity');
    const prepared = await this.prepare(appId, input.task, principal),
      { contract, compiled, manifest, app } = prepared,
      args = parseExactJSON(input.input ?? '[]'),
      runId = input.requestId ? sha(appId + '\0' + input.task + '\0' + input.requestId).slice(0, 32) : randomBytes(16).toString('hex'),
      signal = AbortSignal.timeout(contract.deadlineMs);
    if (!Array.isArray(args)) fail(400, 'Task input is a JSON argument array');
    const types = effectTypes(manifest, compiled.artifact);
    let outcome;
    try {
      outcome = await runTask({
        manifest,
        call: this.caller(prepared, runId, signal),
        task: input.task,
        args,
        effects: this.handlers(app, contract, types, compiled.artifact.manifest.named_types, runId),
        concurrency: contract.concurrency,
        signal,
      });
    } catch (error) {
      if (!(error instanceof TaskFailed)) throw error;
      outcome = { trace: error.trace, failed: error.message };
    }
    this.runs++;
    const trace = stringifyExactJSON(outcome.trace),
      record = await this.platform.world.create(
        {
          namespace: appId,
          kind: 'ink-task-run',
          title: 'Task ' + input.task + (outcome.failed ? ' failed' : ''),
          tags: ['ink-task-run'],
          body: JSON.stringify({ format: 'ink-os-task-run-v1', runId, releaseId: app.releaseId, task: input.task, trace: Buffer.byteLength(trace) <= MAX_TRACE ? trace : null }),
        },
        { writer: appId, actor: 'Ink task', action: 'ran task ' + input.task },
      );
    if (outcome.failed) fail(422, outcome.failed);
    const valueWire = stringifyExactJSON(outcome.result);
    return { runId, task: input.task, releaseId: app.releaseId, valueWire, value: displayWire(valueWire), trace, traceId: record.id };
  }
}
