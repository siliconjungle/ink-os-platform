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
// - a durable run journal (host namespace `ink-tasks`, key `run:<runId>`):
//   each effect reply and step result is kept before it is used, so a run
//   interrupted by a restart resumes where it stopped instead of repeating
//   effects. Changes and app writes carry step-keyed request identities, so a
//   step that committed before its result was kept is not applied twice
//   (while the target's receipt is retained);
// - a trace in World (`ink-task-run`) bound to the release. It replays
//   offline (`ink replay-task SOURCE TRACE --restore SNAPSHOT`) or in the
//   platform (`replay`) against a scratch copy of the state the run started
//   from, with every effect answered from the trace.
import { createHash, randomBytes } from 'node:crypto';
import { installedInk, runInstalledInk } from './ink-apps.mjs';
import { runTask, replayTask, TaskFailed, effectPrompt, replyValue, MANIFEST_FORMAT } from './ink-task-runner.mjs';
import { httpEffect, effectFailure } from './ink-effect-io.mjs';
import { actorType } from './ink-effects.mjs';
import { hostBudget } from './execution-budget.mjs';
import { TASK_CAPABILITIES } from '../shared/ink-tasks.mjs';
import { EFFECT_REQUESTS, EFFECT_RESPONSES, EFFECT_ERROR, resolveEffectType, effectTypeEqual } from '../shared/ink-effects.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { displayWire } from '../shared/ink-values.mjs';

const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
// Run journals live under the host's `os` namespace, which only the owner and
// the host write (apps write only their own namespace).
const RUNS = 'os',
  RUN = 'ink-task:run:',
  JOURNAL_FORMAT = 'ink-os-task-journal-v1',
  MAX_JOURNAL = 768 * 1024,
  MAX_START = 1024 * 1024,
  MAX_TRACE = 256 * 1024,
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

/** One run's durable record; writes are serialized and compare revisions. */
class RunJournal {
  constructor(code, runId) {
    Object.assign(this, { code, key: RUN + runId, revision: 0, chain: Promise.resolve() });
  }
  async read() {
    const saved = await this.code.storage.read(RUNS, this.key);
    this.revision = saved.revision;
    return saved.value;
  }
  write(value) {
    const next = this.chain.then(async () => {
      const saved = await this.code.storage.batch(RUNS, this.key, this.revision, [{ key: this.key, value }]);
      this.revision = saved.revision;
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export class InkTasks {
  constructor({ platform }) {
    this.platform = platform;
    this.runs = 0;
    this.resumed = 0;
    this.active = new Map();
  }
  /** Resume every run a previous host left running. */
  async resume() {
    const keys = (await this.platform.code.stateKeys(RUNS, RUN)).filter((k) => /^ink-task:run:[a-f0-9]{32}$/.test(k)),
      results = [];
    for (const key of keys) {
      const journal = new RunJournal(this.platform.code, key.slice(RUN.length)),
        record = await journal.read().catch(() => null);
      if (record?.format !== JOURNAL_FORMAT || record.status !== 'running' || this.active.has(record.runId)) continue;
      const task = this.continue(record, journal).catch((error) => ({ runId: record.runId, error: error.message }));
      results.push(task);
    }
    return Promise.all(results);
  }
  async continue(record, journal) {
    const prepared = await this.prepare(record.appId, record.task, { releaseId: record.releaseId });
    if (prepared.app.releaseId !== record.releaseId) fail(409, 'The run belongs to another release');
    this.resumed++;
    return this.execute(prepared, record, journal);
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
    const targetNamed = app.namedTypes,
      params = entry.params.map((p) => resolveEffectType(p.type, targetNamed)),
      // As for protocol app effects, a two-parameter entry whose first
      // parameter is the caller identity receives it from the host; the task
      // supplies only the rest and can never name another caller.
      actor = params.length === 2 && effectTypeEqual(params[0], actorType),
      supplied = actor ? params.slice(1) : params;
    if (
      !type ||
      supplied.length !== type.params.length ||
      supplied.some((p, i) => !effectTypeEqual(p, resolveEffectType(type.params[i], named))) ||
      !effectTypeEqual(resolveEffectType(entry.result, targetNamed), resolveEffectType(type.reply, named))
    )
      throw effectFailure('TypeMismatch', 'Task app effect types differ from the target entry');
    if (actor) values = [{ appId: caller.appId, releaseId: caller.releaseId }, ...values];
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
  /**
   * State calls of a run. A change's request identity is its step, so a
   * resumed run that repeats the step receives the original reply. `target`
   * redirects every call to scratch state (replay).
   */
  caller({ app, compiled, allowed, authority }, runId, signal, target = { namespace: app.appId, stateKey: 'ink-app:state', principal: authority }) {
    return async (name, args, { step } = {}) => {
      if (!allowed.has(name)) fail(403, 'A task may call only its own steps');
      const action = compiled.artifact.manifest.state?.actions?.find((a) => a.name === name);
      const result = await this.platform.code.run({
        source: app.source,
        entry: name,
        args,
        task: name.startsWith('__task_'),
        ...target,
        signal,
        ...(action?.change ? { requestId: `task:${runId}:s${step}` } : {}),
      });
      return parseExactJSON(result.wire).result;
    };
  }
  /** Run a task; returns its exact result, its trace and the stored run's id. */
  async run(appId, input = {}, principal, { signal } = {}) {
    if (typeof input.task !== 'string') fail(400, 'Name the Ink task to run');
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !input.requestId.length || input.requestId.length > 128))
      fail(400, 'Invalid task request identity');
    const prepared = await this.prepare(appId, input.task, principal),
      wire = input.input ?? '[]',
      args = parseExactJSON(wire),
      runId = input.requestId ? sha(appId + '\0' + input.task + '\0' + input.requestId).slice(0, 32) : randomBytes(16).toString('hex');
    if (!Array.isArray(args)) fail(400, 'Task input is a JSON argument array');
    if (this.active.has(runId)) return this.active.get(runId);
    const journal = new RunJournal(this.platform.code, runId),
      existing = await journal.read();
    if (existing) {
      if (existing.appId !== appId || existing.task !== input.task || existing.input !== wire)
        fail(409, 'Task request identity was already used for a different run');
      if (existing.status === 'running') {
        if (existing.releaseId !== prepared.app.releaseId) fail(409, 'The run belongs to another release');
        return this.execute(prepared, existing, journal, signal);
      }
      return this.finished(existing);
    }
    const record = {
      format: JOURNAL_FORMAT,
      runId,
      appId,
      releaseId: prepared.app.releaseId,
      task: input.task,
      input: wire,
      status: 'running',
      started: Date.now(),
      records: '[]',
    };
    await journal.write(record);
    // The state the run starts from, for in-platform replay (small states only).
    try {
      const start = await this.platform.code.loadCheckpoint(appId, 'ink-app:state'),
        value = start.value === null ? { empty: true } : start.value.snapshot && start.value.snapshot.length <= MAX_START ? start.value : null;
      if (value) await this.platform.code.storage.batch(RUNS, RUN + runId + ':start', 0, [{ key: RUN + runId + ':start', value }]);
    } catch {}
    return this.execute(prepared, record, journal, signal);
  }
  execute(prepared, record, journal, cancel) {
    const task = this.perform(prepared, record, journal, cancel).finally(() => this.active.delete(record.runId));
    this.active.set(record.runId, task);
    return task;
  }
  async perform(prepared, record, journal, cancel) {
    const { contract, compiled, manifest, app } = prepared,
      { runId } = record,
      // A cancelled run stays `running` in its journal and resumes later.
      signal = cancel ? AbortSignal.any([cancel, AbortSignal.timeout(contract.deadlineMs)]) : AbortSignal.timeout(contract.deadlineMs),
      // Exact JSON reads integers as BigInt; steps are indices.
      kept = parseExactJSON(record.records).map((r) => ({ ...r, step: Number(r.step) })),
      effects = new Map(kept.filter((r) => r.effect).map((r) => [r.step, r])),
      calls = new Map(kept.filter((r) => r.call).map((r) => [r.step, r.result]));
    let entries = [...kept],
      bounded = false;
    // Each reply and step result is durable before the task uses it.
    const onRecord = (entry) => {
      if (bounded) return;
      const text = stringifyExactJSON([...entries, entry]);
      if (Buffer.byteLength(text) > MAX_JOURNAL) {
        bounded = true;
        return;
      }
      entries.push(entry);
      return journal.write({ ...record, records: text });
    };
    const types = effectTypes(manifest, compiled.artifact);
    let outcome;
    try {
      outcome = await runTask({
        manifest,
        call: this.caller(prepared, runId, signal),
        task: record.task,
        args: parseExactJSON(record.input),
        effects: this.handlers(app, contract, types, compiled.artifact.manifest.named_types, runId),
        journal: { effects, calls },
        onRecord,
        concurrency: contract.concurrency,
        signal,
      });
    } catch (error) {
      if (!(error instanceof TaskFailed)) throw error;
      outcome = { trace: error.trace, failed: error.message };
    }
    this.runs++;
    const trace = stringifyExactJSON(outcome.trace),
      kept_trace = Buffer.byteLength(trace) <= MAX_TRACE ? trace : null,
      stored = await this.platform.world.create(
        {
          namespace: record.appId,
          kind: 'ink-task-run',
          title: 'Task ' + record.task + (outcome.failed ? ' failed' : ''),
          tags: ['ink-task-run'],
          body: JSON.stringify({ format: 'ink-os-task-run-v1', runId, releaseId: app.releaseId, task: record.task, trace: kept_trace }),
        },
        { writer: record.appId, actor: 'Ink task', action: 'ran task ' + record.task },
      );
    const finished = {
      ...record,
      status: outcome.failed ? 'failed' : 'done',
      records: '[]',
      finished: Date.now(),
      outcome: outcome.failed ? { failed: outcome.failed } : { valueWire: stringifyExactJSON(outcome.result) },
      trace: kept_trace,
      traceId: stored.id,
    };
    await journal.write(finished);
    return this.finished(finished);
  }
  finished(record) {
    if (record.outcome.failed) fail(422, record.outcome.failed);
    const valueWire = record.outcome.valueWire;
    return {
      runId: record.runId,
      task: record.task,
      releaseId: record.releaseId,
      valueWire,
      value: displayWire(valueWire),
      trace: record.trace,
      traceId: record.traceId,
    };
  }
  /**
   * Re-run a finished run in the platform: every effect is answered from its
   * trace, and its queries and changes run on a scratch copy of the state the
   * run started from. The replay must reproduce the recorded outcomes and
   * result exactly (it does when no other commit interleaved with the run).
   * Live state is never touched.
   */
  async replay(appId, runId, principal) {
    if (!/^[a-f0-9]{32}$/.test(runId)) fail(400, 'Invalid task run identity');
    const record = await new RunJournal(this.platform.code, runId).read();
    if (record?.format !== JOURNAL_FORMAT || record.appId !== appId) fail(404, 'No such task run');
    if (record.status === 'running') fail(409, 'The task run has not finished');
    if (!record.trace) fail(409, 'The task run kept no trace');
    const startKey = RUN + runId + ':start',
      start = await this.platform.code.storage.read(RUNS, startKey);
    if (!start.value) fail(409, 'The task run kept no start state');
    const prepared = await this.prepare(appId, record.task, { ...principal, releaseId: record.releaseId });
    if (prepared.app.releaseId !== record.releaseId) fail(409, 'The run belongs to another release');
    const scratch = 'ink-task:replay:' + runId + ':' + randomBytes(8).toString('hex'),
      code = this.platform.code;
    // A run that started before the app's first commit replays on fresh state.
    if (!start.value.empty) await code.saveCheckpoint(RUNS, scratch, start.value, 0);
    try {
      const parsed = parseExactJSON(record.trace),
        trace = { ...parsed, effects: parsed.effects.map((e) => ({ ...e, step: Number(e.step) })) },
        replayed = await replayTask({
          manifest: prepared.manifest,
          call: this.caller(prepared, 'replay-' + runId, AbortSignal.timeout(prepared.contract.deadlineMs), { namespace: RUNS, stateKey: scratch }),
          trace,
        });
      return { runId, task: record.task, releaseId: record.releaseId, matches: true, effects: replayed.effects.length, valueWire: stringifyExactJSON(replayed.result) };
    } catch (error) {
      if (/replay differs/.test(error.message)) fail(409, 'Replay differs from the recorded run');
      throw error;
    } finally {
      // Scratch state and its journal payloads leave with the replay.
      const own = [...new Set([...(await code.stateKeys(RUNS, scratch)), ...(await code.stateKeys(RUNS, '@ink:' + sha(scratch) + ':'))])].filter(
        (k) => k === scratch || k.startsWith('@ink:' + sha(scratch) + ':'),
      );
      const saved = await code.readState(RUNS, scratch);
      await code.storage.batch(RUNS, scratch, saved.revision, own.map((key) => ({ key, delete: true }))).catch(() => {});
    }
  }
}
