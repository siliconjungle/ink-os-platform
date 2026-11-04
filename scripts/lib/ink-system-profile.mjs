import { AsyncLocalStorage } from 'node:async_hooks';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { InkAppJournal } from '../../server/ink-app-journal.mjs';

// Benchmark-only observers: no payloads, traces or hooks are enabled by the host.
const context = new AsyncLocalStorage();
const now = () => performance.timeOrigin + performance.now();
export function jsonBytes(value) {
  const text = JSON.stringify(value), fields = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.forEach(([key, v], i) => {
      fields[key] = Buffer.byteLength(JSON.stringify(key) + ':' + JSON.stringify(v)) + (i ? 1 : 0);
    });
    fields.$braces = 2;
  } else fields.$value = Buffer.byteLength(text);
  return { bytes: Buffer.byteLength(text), fields };
}
export class SystemProfile {
  constructor({ limit = 200000 } = {}) {
    this.limit = limit;
    this.spans = [];
    this.rpc = [];
    this.wal = [];
    this.checkpoints = [];
    this.dropped = 0;
    this.sequence = 0;
    this.restores = [];
    this.documents = new WeakSet();
    this.endpoints = new WeakSet();
  }
  get current() { return context.getStore(); }
  record(span) {
    if (this.spans.length < this.limit) this.spans.push(span);
    else this.dropped++;
  }
  run(trace, name, detail, run) {
    return context.run({ trace, profile: this }, () => this.span(name, detail, run));
  }
  span(name, detail, run) {
    const parent = this.current;
    if (parent?.profile !== this) return run();
    const span = { trace: parent.trace, id: ++this.sequence, parent: parent.id ?? null, name, start: now(), detail };
    const finish = (failed = false) => { this.record({ ...span, end: now(), failed }); };
    return context.run({ trace: parent.trace, profile: this, id: span.id }, () => {
      try {
        const value = run();
        if (value && typeof value.then === 'function')
          return value.then(value => { finish(); return value; }, error => { finish(true); throw error; });
        finish(); return value;
      } catch (error) { finish(true); throw error; }
    });
  }
  mark(name, detail) {
    const ctx = this.current;
    if (ctx?.profile === this) this.record({ trace: ctx.trace, id: ++this.sequence, parent: ctx.id ?? null, name, start: now(), end: now(), detail });
  }
  wrap(object, method, name, detail = () => ({}), transform) {
    const original = object[method], profile = this;
    object[method] = function (...args) {
      return profile.span(name, detail(args), () => transform
        ? transform.call(this, original.bind(this), args)
        : original.apply(this, args));
    };
    this.restores.push(() => { object[method] = original; });
  }
  async attach(platform) {
    const profile = this, code = platform.code;
    for (const method of ['compile', 'readState', 'writeStates', 'execute'])
      this.wrap(code, method, 'code.' + method, args => ({ entry: args[0]?.entry }));
    this.wrap(code, 'serializeState', 'state.lane', () => ({}), function (run, args) {
      const started = now(), ctx = profile.current, callback = args[2];
      args[2] = () => {
        if (ctx?.profile === profile) profile.record({ trace: ctx.trace, id: ++profile.sequence, parent: ctx.id, name: 'state.queue', start: started, end: now(), detail: {} });
        return callback();
      };
      return run(...args);
    });
    this.wrap(code.residents, 'acquire', 'resident.acquire', () => ({}), async function (run, args) {
      const session = await run(...args), endpoint = session.endpoint;
      if (!profile.endpoints.has(endpoint)) {
        profile.endpoints.add(endpoint);
        const previousDiagnostic = endpoint.onDiagnostic;
        profile.wrap(endpoint, 'request', 'resident.request', args => ({ op: args[0].op, entry: args[0].entry }), function (run, args) {
          const ctx = profile.current;
          // Only the JS resident has internal timing telemetry. Native round trips
          // include IPC and codecs and are deliberately reported as such.
          endpoint.onDiagnostic = ctx?.profile === profile ? spans => {
            for (const span of spans) profile.record({ ...span, trace: ctx.trace, parent: ctx.id, id: ++profile.sequence, detail: {} });
          } : undefined;
          return run(...args);
        });
        profile.restores.push(() => { endpoint.onDiagnostic = previousDiagnostic; });
      }
      return session;
    });
    for (const method of ['render', 'frame', 'refresh', 'invalidate'])
      this.wrap(platform.inkViews, method, 'view.' + method);
    this.wrap(platform.inkViews.reads, 'read', 'query.snapshot', args => ({ entry: args[0].entry }));
    for (const method of ['commit', 'projectNow'])
      this.wrap(platform.collaboration, method, 'collaboration.' + method);
    this.wrap(platform.collaboration, 'checkpoint', 'collaboration.checkpoint', () => ({}), async function (run, args) {
      const result = await run(...args), ctx = profile.current;
      if (ctx?.profile === profile) await profile.span('profile.accounting', {}, async () => {
        const values = [...args[0].replica.values.values()];
        profile.checkpoints.push({ trace: ctx.trace, bytes: (await stat(join(args[0].dir, 'checkpoint.json'))).size,
          registers: values.length, tombstones: values.filter(value => value.deleted).length });
      });
      return result;
    });
    for (const task of platform.collaboration.documents.values()) {
      const doc = await task;
      if (this.documents.has(doc)) continue;
      this.documents.add(doc);
      this.wrap(doc.replica, 'apply', 'collaboration.apply');
      this.wrap(doc.replica, 'checkpoint', 'collaboration.snapshot');
      this.wrap(doc.journal, 'sync', 'wal.fsync');
      this.wrap(doc.journal, 'write', 'wal.write', args => ({ bytes: args[2] }), async function (run, args) {
        const result = await run(...args), ctx = profile.current;
        if (ctx?.profile === profile) profile.wal.push({ trace: ctx.trace, bytes: result.bytesWritten });
        return result;
      });
    }
    for (const method of ['commit', 'recover', 'collect'])
      this.wrap(InkAppJournal.prototype, method, 'journal.' + method);
    this.wrap(InkAppJournal.prototype, 'stage', 'journal.stage', args => ({ kind: Object.hasOwn(args[0], 'snapshot') ? 'checkpoint' : 'transaction' }));
  }
  close() { for (const restore of this.restores.reverse()) restore(); this.restores.length = 0; }
}

export function summary(values) {
  if (!values.length) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}

// Inclusive spans overlap; exclusive durations subtract the UNION of children.
export function exclusive(spans) {
  const children = new Map();
  for (const span of spans) {
    if (!children.has(span.parent)) children.set(span.parent, []);
    children.get(span.parent).push(span);
  }
  return spans.map(span => {
    const intervals = (children.get(span.id) || []).map(child => [Math.max(span.start, child.start), Math.min(span.end, child.end)])
      .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let covered = 0, end = span.start;
    for (const [a, b] of intervals) { covered += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
    return { ...span, duration: span.end - span.start, exclusive: Math.max(0, span.end - span.start - covered) };
  });
}
