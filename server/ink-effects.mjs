import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from './world.mjs';
import { installedInk, runInstalledInk } from './ink-apps.mjs';
import { InkEffectsStore } from './ink-effects-store.mjs';
import { effectPolicy, loadEffectPolicy } from './ink-effects-policy.mjs';
import { EffectSubscriptions } from './ink-effect-subscriptions.mjs';
import {
  httpEffect,
  processEffect,
  optional,
  NONE,
  SOME,
  textBytes,
  requestBytes,
  effectFailure,
} from './ink-effect-io.mjs';
import {
  EFFECT_KINDS,
  EFFECT_CAPABILITIES,
  inkEffectProtocols,
  resolveEffectType,
  effectTypeEqual,
} from '../shared/ink-effects.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { displayWire } from '../shared/ink-values.mjs';

const terminal = (run) =>
  ['done', 'failed', 'cancelled', 'fenced'].includes(run.status);
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
const nowId = () => Date.now() + ':' + globalThis.crypto.randomUUID();
const MAX_AGE = 86400000;
const actorType = {
  kind: 'record',
  fields: [
    { name: 'appId', type: { kind: 'string' } },
    { name: 'releaseId', type: { kind: 'string' } },
  ],
};
export class InkEffects {
  constructor({
    platform,
    directory = join(platform.directory, 'effects'),
    policy,
    policyFile = process.env.INK_OS_EFFECTS_POLICY_FILE,
    allowHttp = false,
    autoStart = true,
    concurrency = 4,
  } = {}) {
    Object.assign(this, {
      platform,
      directory,
      policyInput: policy,
      policyFile,
      allowHttp,
      autoStart,
      concurrency,
    });
    this.store = new InkEffectsStore(directory);
    this.tasks = new Map();
    this.queue = new Set();
    this.controllers = new Map();
    this.subscriptions = new EffectSubscriptions(platform.world);
    this.accepting = false;
    this.started = false;
    this.error = null;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
      throw Error('Effect concurrency must be 1–4');
  }
  async open() {
    this.policy = this.policyFile
      ? await loadEffectPolicy(this.policyFile, { allowHttp: this.allowHttp })
      : await effectPolicy(this.policyInput, { allowHttp: this.allowHttp });
    await this.store.open();
    for (const run of this.store.runs.values())
      if (!terminal(run)) this.queue.add(run.id);
    this.ready = true;
    if (this.autoStart) this.resumeAdmission();
    return this;
  }
  closeAdmission() {
    this.accepting = false;
  }
  drainAccepted() {
    this.started = true;
    this.pump();
  }
  resumeAdmission() {
    this.accepting = true;
    this.drainAccepted();
  }
  authorize(run, principal) {
    if (principal?.appId === run.appId && !principal.owner) return;
    if (
      principal?.owner &&
      (run.owner === 'account:' + (principal.accountId || 'owner') ||
        principal.admin === true)
    )
      return;
    fail(403, 'This effect run belongs to another application or account');
  }
  get(appId, id, principal) {
    if (!/^[a-f0-9]{32}$/.test(id || ''))
      fail(400, 'Invalid effect run identity');
    const run = this.store.read(id);
    if (!run || run.appId !== appId) fail(404, 'Effect run not found');
    this.authorize(run, principal);
    return this.public(run);
  }
  public(run) {
    return {
      id: run.id,
      requestId: run.requestId,
      appId: run.appId,
      releaseId: run.releaseId,
      entry: run.entry,
      status: run.status,
      phase: run.phase,
      sequence: run.sequence,
      createdAt: run.createdAt,
      deadlineAt: run.deadlineAt,
      ...(run.lastReceipt ? { lastEffect: run.lastReceipt } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(terminal(run) && run.replyWire
        ? {
            observationWire: run.replyWire,
            observation: displayWire(run.replyWire),
          }
        : {}),
      ...(run.valueWire !== undefined
        ? {
            valueWire: run.valueWire,
            value: displayWire(run.valueWire),
            backend: run.backend,
          }
        : {}),
      cancellation: {
        requested: !!run.cancelRequested,
        mayHaveTakenEffect: !!run.mayHaveTakenEffect,
      },
    };
  }
  async program(appId, releaseId, entry) {
    const app = await installedInk(this.platform, appId, releaseId),
      compiled = await this.platform.code.compile(app.source),
      protocol = inkEffectProtocols(
        app.spec,
        compiled.entries,
        compiled.artifact.manifest.named_types,
      ).find((protocol) => protocol.entry === entry);
    if (!protocol) fail(400, 'Select a declared Ink effect protocol');
    return { app, compiled, protocol };
  }
  capabilities(appId, operations) {
    const app = JSON.parse(this.platform.app(appId).body);
    if (!app.capabilities?.includes('code.execute'))
      fail(403, 'Application does not declare code.execute');
    for (const operation of operations)
      if (!app.capabilities?.includes(EFFECT_CAPABILITIES[operation.kind]))
        throw effectFailure(
          'Denied',
          'Application does not declare ' + EFFECT_CAPABILITIES[operation.kind],
        );
  }
  async start(appId, input, principal) {
    if (!this.accepting || this.error) fail(503, 'Effect admission is closed');
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'entry',
            'input',
            'args',
            'requestId',
            'backend',
            'releaseId',
          ].includes(key),
      )
    )
      fail(400, 'Invalid effect start request');
    if (!principal?.owner && principal?.appId !== appId)
      fail(403, 'Wrong app identity');
    const releaseId =
      principal?.releaseId ||
      input.releaseId ||
      JSON.parse(this.platform.app(appId).body).releaseId;
    if (
      principal?.releaseId &&
      input.releaseId &&
      principal.releaseId !== input.releaseId
    )
      fail(403, 'A runtime cannot change its release identity');
    const program = await this.program(appId, releaseId, input.entry);
    this.capabilities(appId, program.protocol.operations);
    this.platform.runtime
      .bind({ appId, namespace: appId, releaseId })
      .writeAccess.check();
    if (
      input.backend !== undefined &&
      !['javascript', 'auto', 'native'].includes(input.backend)
    )
      fail(400, 'Invalid effect execution backend');
    const wire = input.input ?? stringifyExactJSON(input.args || []);
    if (typeof wire !== 'string' || Buffer.byteLength(wire) > 128 * 1024)
      fail(413, 'Effect arguments exceed 128 KiB');
    const requestId = input.requestId || nowId(),
      match =
        /^([0-9]{1,16}):([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(
          requestId,
        );
    if (!match || !Number.isSafeInteger(Number(match[1])))
      fail(400, 'Use a timestamped effect request identity');
    const stamp = Number(match[1]);
    if (stamp > Date.now() + 60000)
      fail(400, 'Effect request identity is in the future');
    if (Date.now() - stamp > MAX_AGE)
      fail(410, 'Effect request identity expired; it cannot execute again');
    const id = hash(appId + '\0' + requestId).slice(0, 32),
      requestHash = hash(JSON.stringify([appId, releaseId, input.entry, wire])),
      owner = principal?.owner
        ? 'account:' + (principal.accountId || 'owner')
        : 'app:' + appId;
    const run = await this.store.transact(async () => {
      if (!this.accepting || this.error)
        fail(503, 'Effect admission is closed');
      this.platform.runtime
        .bind({ appId, namespace: appId, releaseId })
        .writeAccess.check();
      const existing = this.store.read(id);
      if (existing) {
        this.authorize(existing, principal);
        if (existing.requestHash !== requestHash)
          fail(409, 'Effect request identity was used for another call');
        return existing;
      }
      const active = [...this.store.runs.values()].filter(
        (run) => !terminal(run),
      );
      const expired = [...this.store.runs.values()]
        .filter(
          (run) => terminal(run) && Date.now() - run.requestTimestamp > MAX_AGE,
        )
        .map((run) => [run.id, null]);
      if (
        this.store.bytes -
          expired.reduce(
            (bytes, [id]) => bytes + (this.store.sizes.runs.get(id) || 0),
            0,
          ) +
          (active.length + 1) * 2 * 1024 * 1024 >
        128 * 1024 * 1024
      )
        fail(429, 'Effect journal capacity needs free receipt space');
      if (
        active.length >= 64 ||
        active.filter((run) => run.appId === appId).length >= 16
      )
        fail(429, 'Effect run capacity is busy');
      if (this.store.runs.size - expired.length >= 10000)
        fail(429, 'Effect receipt capacity exceeded');
      const current = {
        id,
        requestId,
        requestTimestamp: stamp,
        requestHash,
        owner,
        appId,
        releaseId,
        entry: input.entry,
        sourceIdentity: program.compiled.digest,
        contractHash: hash(JSON.stringify(program.app.spec.effects)),
        policyHash: this.policy.hash,
        inputWire: wire,
        status: 'queued',
        phase: 'begin',
        sequence: 0,
        attempt: 0,
        backend: input.backend || 'auto',
        createdAt: Date.now(),
        deadlineAt: Date.now() + program.protocol.deadlineMs,
        cancelRequested: false,
        mayHaveTakenEffect: false,
      };
      await this.store.commit({ runs: [...expired, [id, current]] });
      return current;
    });
    if (!terminal(run) && !this.tasks.has(id)) this.queue.add(id);
    this.pump();
    return this.public(run);
  }
  pump() {
    if (!this.started || this.error || this.closing) return;
    while (this.tasks.size < this.concurrency && this.queue.size) {
      const id = this.queue.values().next().value;
      this.queue.delete(id);
      if (this.tasks.has(id)) continue;
      const task = Promise.resolve()
        .then(() => this.execute(id))
        .catch(async (error) => {
          if (this.store.journal.error) {
            this.error = error;
            return;
          }
          try {
            await this.store.update(id, (run) =>
              terminal(run)
                ? null
                : {
                    ...run,
                    status: 'failed',
                    error: {
                      code: error.effectCode || 'Protocol',
                      message: String(error.message).slice(0, 500),
                    },
                    inputWire: null,
                    pendingWire: null,
                    phase: 'terminal',
                  },
            );
          } catch (storageError) {
            this.error = storageError;
          }
        })
        .finally(() => {
          this.tasks.delete(id);
          this.controllers.delete(id);
          this.subscriptions.release(id);
          this.pump();
        });
      this.tasks.set(id, task);
    }
  }
  async cancel(appId, id, principal) {
    const run = this.store.read(id);
    if (!run || run.appId !== appId) fail(404, 'Effect run not found');
    this.authorize(run, principal);
    if (terminal(run)) return this.public(run);
    const cancelled = await this.store.update(id, (current) =>
      terminal(current) ? null : { ...current, cancelRequested: true },
    );
    this.controllers
      .get(id)
      ?.abort(
        effectFailure('Cancelled', 'Effect cancellation requested', 'unknown'),
      );
    if (!this.tasks.has(id)) {
      await this.stop(
        id,
        'cancelled',
        'Cancelled',
        'Effect cancellation requested',
      );
      this.queue.delete(id);
      this.subscriptions.release(id);
    }
    return this.public(this.store.read(id) || cancelled);
  }
  async wait(appId, id, principal) {
    for (;;) {
      const run = this.get(appId, id, principal);
      if (['done', 'failed', 'cancelled', 'fenced'].includes(run.status))
        return run;
      const task = this.tasks.get(id);
      if (task) await task;
      else {
        if (this.error) throw this.error;
        this.pump();
        await delay(10);
      }
    }
  }
  async run(appId, input, principal) {
    const start = await this.start(appId, input, principal),
      result = await this.wait(appId, start.id, principal);
    if (result.status !== 'done')
      throw Object.assign(
        Error(result.error?.message || 'Effect protocol ' + result.status),
        { status: 409, effectRun: result, current: result },
      );
    return {
      output: result.value,
      wire: result.valueWire,
      value: result.value,
      valueWire: result.valueWire,
      releaseId: result.releaseId,
      selected: result.entry,
      backend: result.backend,
      effectRun: result,
    };
  }
  async pure(run, program, entry, wire, signal) {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      try {
        return await this.platform.code.run({
          source: program.app.source,
          entry,
          input: wire,
          namespace: run.appId,
          stateKey: 'ink-effect:' + run.entry,
          backend: run.backend,
          principal: {
            appId: run.appId,
            namespace: run.appId,
            releaseId: run.releaseId,
          },
          signal,
        });
      } catch (error) {
        if (error.status !== 429 || signal.aborted) throw error;
        await delay(10, undefined, { signal });
      }
    }
  }
  async step(run, result) {
    if (Buffer.byteLength(result.wire) > 512 * 1024)
      throw effectFailure('ResourceLimit', 'Protocol step exceeds 512 KiB');
    const step = parseExactJSON(result.wire);
    if (Object.hasOwn(step, 'Ok'))
      return this.store.update(run.id, (current) =>
        current.cancelRequested
          ? {
              ...current,
              status: 'cancelled',
              phase: 'terminal',
              inputWire: null,
              pendingWire: null,
            }
          : {
              ...current,
              status: 'done',
              phase: 'terminal',
              valueWire: stringifyExactJSON(step.Ok),
              inputWire: null,
              pendingWire: null,
              replyWire: null,
              backend: result.backend,
            },
      );
    if (!Object.hasOwn(step, 'Err') || !step.Err?.request)
      throw effectFailure('Protocol', 'Invalid typed protocol step');
    if (Buffer.byteLength(stringifyExactJSON(step.Err.state)) > 65536)
      throw effectFailure('ResourceLimit', 'Protocol state exceeds 64 KiB');
    return this.store.update(run.id, (current) =>
      current.cancelRequested
        ? {
            ...current,
            status: 'cancelled',
            phase: 'terminal',
            inputWire: null,
            pendingWire: null,
          }
        : {
            ...current,
            status: 'running',
            phase: 'ready',
            attempt: 0,
            pendingWire: result.wire,
            inputWire: null,
            replyWire: null,
            backend: result.backend,
          },
    );
  }
  reply(operation, run, value, error, version) {
    return {
      operation: operation.name,
      sequence: run.sequence,
      version: version === undefined ? NONE() : SOME(String(version)),
      error: error
        ? SOME({
            code: error.effectCode || 'Transport',
            message: error.effectCode
              ? String(error.message).slice(0, 500)
              : 'Effect driver did not complete',
            certainty: error.certainty || 'unknown',
            retryable:
              operation.retry === 'observe-again' &&
              ['Interrupted', 'Transport', 'Timeout'].includes(
                error.effectCode,
              ),
          })
        : NONE(),
      ...Object.fromEntries(
        EFFECT_KINDS.map((kind) => [
          kind,
          kind === operation.kind && !error ? SOME(value) : NONE(),
        ]),
      ),
    };
  }
  receipt(run, operation, reply) {
    const error = optional(reply.error);
    return {
      operation: operation.name,
      kind: operation.kind,
      sequence: run.sequence,
      attempt: run.attempt,
      version: optional(reply.version) ?? null,
      error: error || null,
    };
  }
  async observe(run, operation, reply, mayHaveTakenEffect) {
    return this.store.update(run.id, (current) => ({
      ...current,
      phase: 'observed',
      replyWire: stringifyExactJSON(reply),
      lastReceipt: this.receipt(current, operation, reply),
      mayHaveTakenEffect:
        !!current.priorMayHaveTakenEffect || mayHaveTakenEffect,
    }));
  }
  async stop(id, status, code, message) {
    return this.store.update(id, (current) => {
      if (terminal(current)) return null;
      let observation = {};
      if (current.phase === 'dispatching' && current.operation) {
        const certainty = ['file', 'clock', 'random'].includes(
          current.operation.kind,
        )
          ? 'not-applied'
          : 'unknown';
        const reply = this.reply(
          current.operation,
          current,
          null,
          effectFailure(code, message, certainty),
        );
        observation = {
          replyWire: stringifyExactJSON(reply),
          lastReceipt: this.receipt(current, current.operation, reply),
        };
      }
      return {
        ...current,
        ...observation,
        status,
        phase: 'terminal',
        error: { code, message },
        inputWire: null,
        pendingWire: null,
      };
    });
  }
  async execute(id) {
    let run = this.store.read(id);
    if (!run || terminal(run)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const timer = setTimeout(
      () =>
        controller.abort(
          effectFailure(
            'Timeout',
            'Effect protocol deadline elapsed',
            'unknown',
          ),
        ),
      Math.max(1, run.deadlineAt - Date.now()),
    );
    try {
      if (run.cancelRequested || Date.now() >= run.deadlineAt) {
        await this.stop(
          id,
          run.cancelRequested ? 'cancelled' : 'failed',
          run.cancelRequested ? 'Cancelled' : 'Timeout',
          run.cancelRequested
            ? 'Effect cancellation requested'
            : 'Effect protocol deadline elapsed',
        );
        return;
      }
      const program = await this.program(run.appId, run.releaseId, run.entry);
      if (
        run.sourceIdentity !== program.compiled.digest ||
        run.contractHash !== hash(JSON.stringify(program.app.spec.effects))
      )
        throw effectFailure('Fenced', 'Effect source or contract changed');
      const authority = this.platform.runtime.bind({
        appId: run.appId,
        namespace: run.appId,
        releaseId: run.releaseId,
      });
      await authority.writeAccess.run(async () => {
        while (!terminal(run)) {
          if (controller.signal.aborted || run.cancelRequested) {
            await this.stop(
              id,
              run.cancelRequested ? 'cancelled' : 'failed',
              run.cancelRequested ? 'Cancelled' : 'Timeout',
              run.cancelRequested
                ? 'Effect cancellation requested'
                : 'Effect deadline elapsed',
            );
            break;
          }
          if (run.phase === 'begin') {
            run = await this.step(
              run,
              await this.pure(
                run,
                program,
                program.protocol.entry,
                run.inputWire,
                controller.signal,
              ),
            );
            continue;
          }
          if (run.phase === 'observed') {
            const pending = parseExactJSON(run.pendingWire).Err,
              reply = parseExactJSON(run.replyWire);
            run = await this.step(
              run,
              await this.pure(
                run,
                program,
                program.protocol.resume,
                stringifyExactJSON([pending.state, reply]),
                controller.signal,
              ),
            );
            continue;
          }
          const pending = parseExactJSON(run.pendingWire).Err,
            request = pending.request,
            operation = program.protocol.operations.find(
              (operation) => operation.name === request.operation,
            );
          if (
            !operation ||
            EFFECT_KINDS.filter((kind) =>
              Object.hasOwn(request[kind] || {}, 'Some'),
            ).join(',') !== operation.kind
          )
            throw effectFailure(
              'Denied',
              'Protocol request is outside its declared operation set',
            );
          if (run.phase === 'dispatching') {
            if (
              operation.kind === 'file' ||
              ['clock', 'random'].includes(operation.kind)
            ) {
              run = await this.store.update(id, (current) => ({
                ...current,
                attempt: current.attempt + 1,
              }));
            } else if (
              operation.kind === 'http' &&
              operation.retry === 'observe-again' &&
              run.attempt < 3
            ) {
              run = await this.store.update(id, (current) => ({
                ...current,
                attempt: current.attempt + 1,
              }));
            } else {
              run = await this.observe(
                run,
                operation,
                this.reply(
                  operation,
                  run,
                  null,
                  effectFailure(
                    operation.kind === 'subscription' ? 'Gap' : 'Interrupted',
                    'The previous host ended before recording this effect outcome',
                    'unknown',
                  ),
                ),
                operation.effect === 'write',
              );
              continue;
            }
          }
          authority.writeAccess.check();
          this.capabilities(run.appId, [operation]);
          if (run.policyHash !== this.policy.hash)
            throw effectFailure(
              'Fenced',
              'Private effect resource policy changed',
            );
          if (run.phase === 'ready') {
            if (run.sequence >= program.protocol.maxSteps)
              throw effectFailure(
                'ResourceLimit',
                'Effect step budget exceeded',
              );
            run = await this.store.update(id, (current) => ({
              ...current,
              phase: 'dispatching',
              sequence: current.sequence + 1,
              attempt: 1,
              priorMayHaveTakenEffect: current.mayHaveTakenEffect,
              mayHaveTakenEffect:
                current.mayHaveTakenEffect || operation.effect === 'write',
              operation,
              operationDeadlineAt: Math.min(
                current.deadlineAt,
                Date.now() + operation.deadlineMs,
              ),
            }));
          }
          if (operation.kind === 'file') {
            try {
              run = await this.file(run, operation, optional(request.file));
            } catch (error) {
              if (this.store.journal.error) throw error;
              run = await this.observe(
                run,
                operation,
                this.reply(operation, run, null, error),
                false,
              );
            }
            continue;
          }
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(
              Math.min(
                operation.deadlineMs,
                Math.max(
                  1,
                  (run.operationDeadlineAt || run.deadlineAt) - Date.now(),
                ),
                Math.max(1, run.deadlineAt - Date.now()),
              ),
            ),
          ]);
          let value,
            error,
            version,
            dispatched = false;
          try {
            if (signal.aborted)
              throw effectFailure(
                'Cancelled',
                'Effect cancelled before dispatch',
              );
            const payload = optional(request[operation.kind]);
            if (operation.kind === 'clock') {
              if (operation.resource !== 'wall-clock')
                throw effectFailure('Denied', 'Unknown clock resource');
              if (payload.delayMs)
                await delay(Number(payload.delayMs), undefined, { signal });
              value = { unixMs: BigInt(Date.now()) };
              version = String(value.unixMs);
            } else if (operation.kind === 'random') {
              if (operation.resource !== 'system' || payload.count > 1024)
                throw effectFailure(
                  'Denied',
                  'Randomness resource or byte budget is invalid',
                );
              value = { bytes: [...randomBytes(Number(payload.count))] };
            } else if (operation.kind === 'subscription') {
              if (operation.resource !== 'world')
                throw effectFailure('Denied', 'Unknown subscription resource');
              const handle = optional(payload.handle);
              if (payload.action === 'open' && handle === undefined)
                value = this.subscriptions.open(run);
              else if (payload.action === 'next' && handle)
                value = await this.subscriptions.next(run, handle, signal);
              else if (payload.action === 'close' && handle)
                value = this.subscriptions.close(run, handle);
              else
                throw effectFailure(
                  'Invalid',
                  'Invalid subscription transition',
                );
              version = String(value.version);
            } else if (operation.kind === 'app') {
              const result = await this.app(
                run,
                operation,
                payload,
                program,
                signal,
                () => {
                  dispatched = true;
                },
              );
              value = result.value;
              version = result.version;
            } else {
              const profile = this.policy.resources.get(operation.resource);
              if (
                !profile ||
                profile.kind !== operation.kind ||
                !profile.namespaces.some(
                  (namespace) => namespace === '*' || namespace === run.appId,
                )
              )
                throw effectFailure(
                  'Denied',
                  'Named effect resource is not granted to this application',
                );
              if (operation.kind === 'http') {
                if (
                  operation.effect === 'read' &&
                  !['GET', 'HEAD'].includes(payload.method)
                )
                  throw effectFailure(
                    'Denied',
                    'A read effect cannot dispatch an HTTP write',
                  );
                value = await httpEffect(profile, payload, signal, () => {
                  dispatched = true;
                },run.appId);
                version = optional(value.etag);
              } else
                value = await processEffect(
                  profile,
                  payload,
                  signal,
                  join(this.directory, 'work'),
                  () => {
                    dispatched = true;
                  },
                  run.appId,
                );
            }
          } catch (caught) {
            error = caught.effectCode
              ? caught
              : effectFailure(
                  signal.aborted ? 'Timeout' : 'Transport',
                  signal.aborted
                    ? 'Effect deadline or cancellation interrupted the operation'
                    : 'Effect driver did not complete',
                  dispatched ? 'unknown' : 'not-applied',
                );
          }
          run = await this.observe(
            run,
            operation,
            this.reply(operation, run, value, error, version),
            dispatched && operation.effect === 'write',
          );
        }
      });
    } catch (error) {
      if (this.store.journal.error) throw error;
      const current = this.store.read(id);
      await this.stop(
        id,
        current.cancelRequested
          ? 'cancelled'
          : error.status === 409 || error.effectCode === 'Fenced'
            ? 'fenced'
            : 'failed',
        error.effectCode || 'Protocol',
        String(error.message).slice(0, 500),
      );
    } finally {
      clearTimeout(timer);
      this.subscriptions.release(id);
    }
  }
  async file(run, operation, request) {
    if (
      typeof request.name !== 'string' ||
      !request.name ||
      request.name.length > 240 ||
      request.name.startsWith('/') ||
      request.name.includes('\\') ||
      request.name.includes('\0') ||
      request.name
        .split('/')
        .some((part) => !part || part === '.' || part === '..')
    )
      throw effectFailure(
        'Denied',
        'File name is outside its virtual resource root',
      );
    return this.store.transact(async () => {
      const current = this.store.read(run.id),
        key = run.appId + '\0' + operation.resource + '\0' + request.name,
        previous = this.store.files.get(key) || {
          exists: false,
          bytes: '',
          version: 0,
        };
      let next = previous,
        error;
      if (
        Date.now() >=
        Math.min(
          current.deadlineAt,
          current.operationDeadlineAt || current.deadlineAt,
        )
      )
        error = effectFailure('Timeout', 'File deadline elapsed before commit');
      else if (current.cancelRequested)
        error = effectFailure(
          'Cancelled',
          'File operation cancelled before commit',
        );
      else if (
        !['read', 'write', 'remove'].includes(request.action) ||
        (operation.effect === 'read' && request.action !== 'read')
      )
        error = effectFailure(
          'Denied',
          'File operation is outside its read/write contract',
        );
      else if (
        (request.action !== 'read' &&
          optional(request.expected) === undefined) ||
        (optional(request.expected) !== undefined &&
          BigInt(optional(request.expected)) !== BigInt(previous.version))
      )
        error = effectFailure(
          'Conflict',
          'File version changed; read its current version',
        );
      else if (
        (request.action === 'read' &&
          (optional(request.value) !== undefined ||
            optional(request.bytes) !== undefined)) ||
        (request.action === 'remove' &&
          (optional(request.value) !== undefined ||
            optional(request.bytes) !== undefined))
      )
        error = effectFailure(
          'Invalid',
          'This file transition does not accept contents',
        );
      else if (request.action !== 'read') {
        try {
          const bytes =
            request.action === 'write'
              ? requestBytes(request.value, request.bytes, { required: true })
              : Buffer.alloc(0);
          if (previous.version >= Number.MAX_SAFE_INTEGER)
            throw effectFailure(
              'ResourceLimit',
              'File version budget exceeded',
            );
          next = {
            exists: request.action === 'write',
            bytes: bytes.toString('base64'),
            version: previous.version + 1,
          };
          const total =
            [...this.store.files].reduce(
              (n, [id, file]) =>
                id === key ? n : n + Buffer.byteLength(file.bytes, 'base64'),
              0,
            ) + bytes.length;
          if (
            total > 32 * 1024 * 1024 ||
            (!this.store.files.has(key) && this.store.files.size >= 512)
          )
            throw effectFailure(
              'ResourceLimit',
              'Virtual file storage budget exceeded',
            );
        } catch (caught) {
          error = caught;
          next = previous;
        }
      }
      const bytes = Buffer.from(next.bytes, 'base64'),
        value = {
          exists: next.exists,
          value: next.exists ? textBytes(bytes) : NONE(),
          bytes: [...bytes],
          version: BigInt(next.version),
        },
        reply = this.reply(operation, current, value, error, next.version),
        updated = {
          ...current,
          phase: 'observed',
          replyWire: stringifyExactJSON(reply),
          lastReceipt: this.receipt(current, operation, reply),
          mayHaveTakenEffect:
            !!current.priorMayHaveTakenEffect ||
            (!error && request.action !== 'read'),
        };
      await this.store.commit({
        runs: [[run.id, updated]],
        ...(!error && request.action !== 'read'
          ? { files: [[key, next]] }
          : {}),
      });
      return structuredClone(updated);
    });
  }
  async app(run, operation, input, program, signal, markDispatched) {
    const target = operation.resource;
    if (target.appId === run.appId && target.entry === run.entry)
      throw effectFailure(
        'Denied',
        'Recursive effect protocols are not direct app calls',
      );
    const app = await installedInk(
        this.platform,
        target.appId,
        target.releaseId,
      ),
      compiled = await this.platform.code.compile(app.source),
      entry = app.entries.find((entry) => entry.name === target.entry);
    if (
      !entry ||
      !app.spec.exports.includes(target.entry) ||
      entry.effectProtocol ||
      entry.hostBinding ||
      (operation.effect === 'read' && entry.change) ||
      entry.params.length > 2
    )
      throw effectFailure(
        'Denied',
        'Target is not an exported direct typed Ink call',
      );
    const named = compiled.artifact.manifest.named_types,
      params = entry.params.map((param) =>
        resolveEffectType(param.type, named),
      );
    let args;
    if (params.length === 2) {
      if (
        !effectTypeEqual(params[0], actorType) ||
        !effectTypeEqual(params[1], program.protocol.appInput)
      )
        throw effectFailure('TypeMismatch', 'Typed app input ABI mismatch');
      args = [{ appId: run.appId, releaseId: run.releaseId }, input];
    } else if (params.length === 1) {
      if (!effectTypeEqual(params[0], program.protocol.appInput))
        throw effectFailure('TypeMismatch', 'Typed app input ABI mismatch');
      args = [input];
    } else {
      if (program.protocol.appInput.kind !== 'unit')
        throw effectFailure(
          'TypeMismatch',
          'Zero-argument app calls require Unit',
        );
      args = [];
    }
    if (
      !effectTypeEqual(
        resolveEffectType(entry.result, named),
        program.protocol.appOutput,
      )
    )
      throw effectFailure('TypeMismatch', 'Typed app output ABI mismatch');
    if (signal.aborted)
      throw effectFailure('Cancelled', 'App call cancelled before dispatch');
    markDispatched();
    const result = await runInstalledInk(
      this.platform,
      target.appId,
      {
        entry: target.entry,
        input: stringifyExactJSON(args),
        requestId: 'effect:' + run.id + ':' + run.sequence,
        backend: 'auto',
      },
      undefined,
      target.releaseId,
      { signal },
    );
    return {
      value: parseExactJSON(result.valueWire),
      version: target.releaseId + ':' + (result.output?.version ?? 'pure'),
    };
  }
  async close() {
    this.closeAdmission();
    if (this.error) {
      for (const controller of this.controllers.values()) controller.abort();
      this.closing = true;
    } else this.drainAccepted();
    while (this.tasks.size || (!this.error && this.queue.size)) {
      await Promise.allSettled([...this.tasks.values()]);
      if (!this.tasks.size) this.pump();
    }
    this.closing = true;
    this.subscriptions.shutdown();
    await this.store.tail;
    if (!this.store.journal.error) await this.store.persist();
  }
}
