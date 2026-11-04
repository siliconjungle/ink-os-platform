import { installedInk, runInstalledInk } from './ink-apps.mjs';
import { stateObjectId } from './app-data.mjs';
import { resolveEffectType, effectTypeEqual } from '../shared/ink-effects.mjs';
import { randomBytes } from 'node:crypto';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { RootVersions } from './ink-root-versions.mjs';
import { readPaths } from './ink-footprints.mjs';
import { InkLinks } from './ink-links.mjs';
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
export function checkUiRead(provider, entryName, expected) {
  const entry = provider.entries.find((entry) => entry.name === entryName);
  if (
    !provider.spec.exports.includes(entryName) ||
    !entry ||
    entry.change ||
    entry.effectProtocol ||
    entry.hostBinding
  )
    fail(400, 'UI reads require an exported readonly Ink entry');
  if (
    !effectTypeEqual(
      resolveEffectType(entry.result, provider.namedTypes),
      expected,
    )
  )
    fail(400, 'Exported query result does not match the UI data port');
  return entry;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function queryPageDelta(previous, value) {
  const before = previous?.rows || [],
    after = value.rows;
  let prefix = 0,
    suffix = 0;
  while (
    prefix < Math.min(before.length, after.length) &&
    stringifyExactJSON(before[prefix]) === stringifyExactJSON(after[prefix])
  )
    prefix++;
  while (
    suffix < Math.min(before.length, after.length) - prefix &&
    stringifyExactJSON(before[before.length - 1 - suffix]) ===
      stringifyExactJSON(after[after.length - 1 - suffix])
  )
    suffix++;
  return freeze({
    start: prefix,
    deleteCount: before.length - prefix - suffix,
    rows: after.slice(prefix, after.length - suffix),
    total: value.total,
    versionWire: stringifyExactJSON(value.version),
  });
}
/** One retained, checked latest-snapshot query per exact authority and input.
 * Intermediate commits may coalesce; source versions and page/aggregate are
 * always published together. This does not authorize incremental query rewrites.
 *
 * A snapshot stays current until a commit writes a state root its exported
 * query reads (RootVersions, from IR write roots); its stateRevision then
 * names the commit it was computed at, and the value is unchanged since. A
 * recomputed result with identical exact bytes keeps its snapshot identity,
 * so no new sequence is delivered. Bindings with a link plan are served by
 * InkLinks (server/ink-links.mjs).
 */
export class InkUiReads {
  constructor(platform) {
    this.platform = platform;
    this.cache = new Map();
    this.retained = new Map();
    this.tasks = new Set();
    this.controllers = new Set();
    this.reads = 0;
    this.hits = 0;
    this.reused = 0;
    this.accepting = true;
    this.versions = new RootVersions(platform);
    this.links = new InkLinks(platform, this);
  }
  key(binding, expected, consumer) {
    return JSON.stringify([
      {
        appId: binding.appId,
        releaseId: binding.releaseId,
        entry: binding.entry,
        input: stringifyExactJSON(parseExactJSON(binding.input || '[]')),
        // Plan code belongs to the consumer release; InkLinks shares results
        // across consumers whose plan code is identical.
        ...(binding.plan
          ? { plan: binding.plan, consumer: [consumer?.appId, consumer?.releaseId] }
          : {}),
      },
      expected,
    ]);
  }
  /** Versions of the roots a read depends on, with the provider's release fence. */
  precise(appId, releaseId, roots) {
    this.stamp(appId, releaseId);
    return JSON.stringify([
      this.platform.app(appId).revision,
      releaseId,
      this.versions.versions(appId, roots),
    ]);
  }
  stamp(appId, releaseId) {
    const app = this.platform.app(appId),
      meta = JSON.parse(app.body);
    if (meta.releaseId !== releaseId)
      fail(409, 'The exported query release changed; rebuild its consumers');
    if (!meta.capabilities?.includes('code.execute'))
      fail(403, 'The exported query app cannot execute');
    const authority = this.platform.world.stateCommits?.get(
      appId + '\0ink-app:state',
    );
    if (authority)
      return JSON.stringify([app.revision, authority.revision, authority.body]);
    const state = this.platform.world.get(
      stateObjectId(appId, 'ink-app:state'),
    );
    return JSON.stringify([
      app.revision,
      state?.revision || 0,
      state?.body || '',
    ]);
  }
  current(snapshot) {
    try {
      if (!snapshot) return false;
      const { appId, releaseId } = snapshot.binding;
      return snapshot.roots
        ? snapshot.precise === this.precise(appId, releaseId, snapshot.roots)
        : snapshot.stamp === this.stamp(appId, releaseId);
    } catch {
      return false;
    }
  }
  async roots(binding) {
    const provider = await installedInk(this.platform, binding.appId, binding.releaseId),
      compiled = await this.platform.code.compile(provider.source),
      entry = compiled.entries.find((entry) => entry.name === binding.entry);
    return {
      provider,
      roots: entry ? readPaths(await this.platform.code.footprints(compiled), compiled, entry, binding.input) : null,
    };
  }
  trim() {
    for (const [key, snapshot] of this.cache) {
      if (this.cache.size <= 8 + this.retained.size) break;
      if (!this.retained.has(key) && snapshot.settled) this.cache.delete(key);
    }
  }
  retain(binding, expected, listener, consumer) {
    if (!this.accepting) fail(503, 'Query admission is closed');
    const key = this.key(binding, expected, consumer);
    let record = this.retained.get(key);
    if (!record) {
      if (this.retained.size >= 32)
        fail(429, 'Retained query capacity is busy');
      const prior = this.cache.get(key);
      record = {
        key,
        binding,
        expected,
        consumer,
        id: prior?.id || randomBytes(16).toString('hex'),
        sequence: prior?.sequence || 0,
        last: prior?.settled ? prior : null,
        listeners: new Set(),
        dirty: true,
        controller: new AbortController(),
      };
      this.retained.set(key, record);
    }
    record.listeners.add(listener);
    this.pump(record);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      record.listeners.delete(listener);
      if (!record.listeners.size) {
        clearTimeout(record.timer);
        this.retained.delete(key);
        this.trim();
      }
    };
  }
  /** Record a World event; returns the provider whose roots changed, if tracked. */
  invalidate(event) {
    this.links.observe(event);
    const provider = this.versions.observe(event);
    for (const record of this.retained.values()) {
      if (event.restore) {
        record.id = randomBytes(16).toString('hex');
        record.sequence = 0;
        this.cache.delete(record.key);
        record.last = null;
      }
      if (!this.current(record.last) || event.restore) {
        record.dirty = true;
        this.pump(record);
      }
    }
    return provider;
  }
  pump(record) {
    if (
      !this.accepting ||
      record.task ||
      !record.listeners.size ||
      !record.dirty
    )
      return;
    clearTimeout(record.timer);
    record.timer = undefined;
    this.controllers.add(record.controller);
    const task = (async () => {
      while (this.accepting && record.listeners.size && record.dirty) {
        record.dirty = false;
        try {
          const snapshot = await this.read(
            record.binding,
            record.expected,
            AbortSignal.any([
              record.controller.signal,
              AbortSignal.timeout(30000),
            ]),
            record.consumer,
          );
          if (
            !record.listeners.size ||
            this.retained.get(record.key) !== record
          )
            return;
          if (record.last !== snapshot) {
            record.last = snapshot;
            record.error = null;
            record.failures = 0;
            for (const notify of record.listeners) {
              try {
                notify({ snapshot });
              } catch {}
            }
          }
        } catch (error) {
          if (record.controller.signal.aborted || !this.accepting) return;
          const quiet =
            error.current?.uiRetry || [429, 503].includes(error.status);
          const retry =
            quiet || ![400, 401, 403, 404, 409, 413].includes(error.status);
          if (!quiet) {
            record.error = error;
            for (const notify of record.listeners) {
              try {
                notify({ error });
              } catch {}
            }
          }
          if (retry) {
            record.dirty = true;
            record.timer = setTimeout(
              () => {
                record.timer = undefined;
                this.pump(record);
              },
              Math.min(
                quiet ? 1000 : 30000,
                50 *
                  2 **
                    Math.min(
                      (record.failures = (record.failures || 0) + 1),
                      10,
                    ),
              ),
            );
            record.timer.unref();
          }
          return;
        }
      }
    })();
    record.task = task;
    this.tasks.add(task);
    task
      .finally(() => {
        record.task = null;
        this.tasks.delete(task);
        this.controllers.delete(record.controller);
        if (record.dirty && !record.timer)
          queueMicrotask(() => this.pump(record));
      })
      .catch(() => {});
  }
  async read(binding, expected, signal, consumer) {
    if (binding.plan)
      return this.links.read(binding, expected, { signal, consumer });
    await this.platform.code.readState(binding.appId, 'ink-app:state');
    const key = this.key(binding, expected, consumer),
      prior = this.cache.get(key);
    if (prior && (!prior.settled || this.current(prior))) {
      this.hits++;
      return prior.promise;
    }
    if (!prior && this.cache.size >= 40)
      fail(429, 'Query snapshot capacity is busy');
    const record = this.retained.get(key),
      snapshot = {
        binding,
        id: record?.id || randomBytes(16).toString('hex'),
        stamp: this.stamp(binding.appId, binding.releaseId),
        settled: false,
      };
    snapshot.promise = (async () => {
      const { provider, roots } = await this.roots(binding);
      checkUiRead(provider, binding.entry, expected);
      snapshot.roots = roots;
      for (let attempt = 0; attempt < 3; attempt++) {
        snapshot.stamp = this.stamp(binding.appId, binding.releaseId);
        if (roots) snapshot.precise = this.precise(binding.appId, binding.releaseId, roots);
        const result = await runInstalledInk(
          this.platform,
          binding.appId,
          { entry: binding.entry, input: binding.input || '[]' },
          undefined,
          binding.releaseId,
          { signal },
        );
        if (Buffer.byteLength(result.valueWire) > 128 * 1024)
          fail(413, 'Exported UI data exceeds 128 KiB');
        if (!this.current(snapshot)) continue;
        const previous = prior?.settled ? prior : record?.last;
        if (previous?.wire === result.valueWire && previous.roots) {
          // Same exact value: keep the identity consumers already hold.
          previous.stamp = snapshot.stamp;
          previous.precise = snapshot.precise;
          this.reused++;
          return previous;
        }
        snapshot.wire = result.valueWire;
        snapshot.value = freeze(parseExactJSON(result.valueWire));
        snapshot.delta = queryPageDelta(
          prior?.value || record?.last?.value,
          snapshot.value,
        );
        snapshot.stateRevision = JSON.parse(snapshot.stamp)[1];
        snapshot.versionWire = stringifyExactJSON(snapshot.value.version);
        const active = this.retained.get(key);
        if (active) snapshot.id = active.id;
        snapshot.bytes =
          Buffer.byteLength(result.valueWire) +
          Buffer.byteLength(stringifyExactJSON(snapshot.delta));
        if (
          [...this.retained.keys()].reduce(
            (n, k) =>
              n +
              (k === key
                ? snapshot.bytes
                : this.retained.get(k)?.last?.bytes ||
                  this.cache.get(k)?.bytes ||
                  0),
            0,
          ) >
          8 * 1024 * 1024
        )
          fail(429, 'Retained query memory budget is busy');
        snapshot.sequence = active ? ++active.sequence : 1;
        this.reads++;
        return snapshot;
      }
      throw Object.assign(
        Error('Exported query changed during rendering; refresh'),
        { status: 409, current: { uiRetry: true, notApplied: true } },
      );
    })();
    this.cache.set(key, snapshot);
    snapshot.promise.then(
      (value) => {
        snapshot.settled = true;
        if (value !== snapshot && this.cache.get(key) === snapshot)
          this.cache.set(key, value);
        this.trim();
      },
      () => {
        snapshot.settled = true;
        if (this.cache.get(key) === snapshot) this.cache.delete(key);
      },
    );
    this.trim();
    return snapshot.promise;
  }
  pause() {
    this.accepting = false;
    for (const record of this.retained.values()) clearTimeout(record.timer);
  }
  resume() {
    this.accepting = true;
    for (const record of this.retained.values()) {
      record.dirty = true;
      this.pump(record);
    }
  }
  async close() {
    this.links.close();
    this.pause();
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.tasks]);
    this.retained.clear();
    this.cache.clear();
  }
}
