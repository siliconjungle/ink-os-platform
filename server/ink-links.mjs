// Cross-app read plans: admission, read-only provider copies and shared results.
//
// A consumer's typed data port may carry a plan (shared/ink-link-plan.mjs):
// its own pure `where` filter, page bounds and an aggregate over the
// provider's exported rows. Plans run in a link worker that holds a read-only
// copy of the provider release's state, so:
//
// - only the selected rows cross to the consumer (filter and page pushdown);
// - reads neither queue behind the provider's writes nor enter its worker, and
//   no provider handle is present where consumer code runs;
// - one result per plan code and binding serves every consumer, and it is
//   recomputed after a commit writes a root the provider query reads.
//
// The copy follows the provider by replaying each committed record, the same
// deterministic replay recovery performs, and reloads from the journal after
// any gap. Worker memory is leased from the shared resident pool and charged
// to the consumer whose read started it; each evaluation is charged to the
// consumer it runs for. Results live only in this bounded cache, never in
// either app's state, and leave with the consumer or provider.
import { createHash } from 'node:crypto';
import { installedInk } from './ink-apps.mjs';
import { InkAppJournal } from './ink-app-journal.mjs';
import { javascriptResident } from './ink-residents.mjs';
import { admitLinkPlan } from './ink-link-plans.mjs';
import { readRoots } from './ink-footprints.mjs';
import { inkProgramKey } from './ink-compiler.mjs';
import { hostBudget } from './execution-budget.mjs';
import { parseExactJSON } from '../shared/exact-json.mjs';
import { checkUiRead } from './ink-ui-reads.mjs';

const STATE = 'ink-app:state',
  WORKER = new URL('./ink-link-worker.mjs', import.meta.url),
  RESULT_LIMIT = 128 * 1024,
  CACHE_BYTES = 32 * 1024 * 1024,
  CACHE_ENTRIES = 64,
  WARM_MS = 60_000;
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
const canonical = (value) =>
  Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
      : JSON.stringify(value);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const meta = (platform, appId) => JSON.parse(platform.app(appId).body);

function declares(read, binding, consumer) {
  const self = read.appId === 'self';
  return (
    (self
      ? binding.appId === consumer.appId && binding.releaseId === consumer.releaseId
      : read.appId === binding.appId && read.releaseId === binding.releaseId) &&
    read.entry === binding.entry &&
    (read.input || '[]') === (binding.input || '[]') &&
    canonical(read.plan) === canonical(binding.plan)
  );
}

export class InkLinks {
  constructor(platform, reads) {
    Object.assign(this, { platform, reads });
    this.links = new Map();
    this.plans = new Map();
    this.results = new Map();
    this.bytes = 0;
    this.counts = { admitted: 0, evaluations: 0, hits: 0, reused: 0, loads: 0, applies: 0, refreshed: 0 };
    this.listener = (commit) => this.onCommit(commit);
    platform.code.commitListeners?.add(this.listener);
  }
  stats() {
    return { ...this.counts, links: this.links.size, results: this.results.size, bytes: this.bytes };
  }
  /** Both releases are current and still hold the link's capabilities. */
  authorize(binding, consumer) {
    const c = meta(this.platform, consumer.appId);
    if (c.releaseId !== consumer.releaseId) fail(409, 'The consumer release changed; reopen it');
    if (!c.capabilities?.includes('code.execute') || (binding.appId !== consumer.appId && !c.capabilities.includes('apps.invoke')))
      fail(403, 'The consumer no longer holds the capabilities this link needs');
    this.reads.stamp(binding.appId, binding.releaseId);
  }
  admit(binding, expected, consumer) {
    const key = canonical([binding, expected, consumer.appId, consumer.releaseId]);
    if (!this.plans.has(key)) {
      const task = (async () => {
        const code = this.platform.code,
          provider = await installedInk(this.platform, binding.appId, binding.releaseId),
          reader = await installedInk(this.platform, consumer.appId, consumer.releaseId);
        checkUiRead(provider, binding.entry, expected);
        if (!reader.spec.ui?.components.some((c) => c.read && declares(c.read, binding, consumer)))
          fail(403, 'The consumer release does not declare this link plan');
        const pCompiled = await code.compile(provider.source),
          cCompiled = await code.compile(reader.source),
          [pFootprints, cFootprints] = await Promise.all([code.footprints(pCompiled), code.footprints(cCompiled)]),
          plan = admitLinkPlan({
            binding,
            data: expected,
            provider: { compiled: pCompiled, footprints: pFootprints, capabilities: meta(this.platform, binding.appId).capabilities },
            consumer: { ...consumer, compiled: cCompiled, footprints: cFootprints, capabilities: meta(this.platform, consumer.appId).capabilities },
          }),
          named = cCompiled.artifact.manifest.named_types,
          functions = Object.fromEntries(
            plan.code.map(({ function: name }) => {
              const fn = cCompiled.artifact.manifest.functions.find((f) => f.name === name);
              return [name, { param: fn.params[0].type, result: fn.result }];
            }),
          );
        this.counts.admitted++;
        return Object.freeze({
          plan,
          binding,
          compiled: pCompiled,
          roots: readRoots(pFootprints, pCompiled, pCompiled.entries.find((e) => e.name === binding.entry)),
          consumerCode: plan.code.length
            ? { id: sha(canonical([cCompiled.artifact.manifest.core_sha256, plan.code])), javascript: cCompiled.artifact.javascript, functions, named }
            : null,
        });
      })();
      this.plans.set(key, task);
      task.catch(() => this.plans.delete(key));
      while (this.plans.size > 64) this.plans.delete(this.plans.keys().next().value);
    }
    return this.plans.get(key);
  }
  link(admitted) {
    const { appId, releaseId } = admitted.binding,
      source = inkProgramKey(admitted.compiled.source),
      key = 'link:' + sha(canonical([appId, releaseId, source]));
    let link = this.links.get(key);
    if (!link) {
      link = { key, appId, releaseId, source, compiled: admitted.compiled, session: null, revision: null, consumers: new Set(), chain: Promise.resolve() };
      this.links.set(key, link);
    }
    return link;
  }
  serial(link, task) {
    const next = link.chain.catch(() => {}).then(task);
    link.chain = next.catch(() => {});
    return next;
  }
  async session(link, owner, signal) {
    const residents = this.platform.code.residents,
      session = await residents.acquire(
        link.key,
        (options) => javascriptResident(link.compiled, { ...options, worker: WORKER }),
        { owner, signal },
      );
    if (session !== link.session) {
      link.session = session;
      link.revision = null;
      link.consumers = new Set();
    }
    return session;
  }
  request(session, owner, message, signal) {
    return hostBudget.run({ owner, resources: { cpu: 1 }, signal, label: 'link plan' }, () => session.endpoint.request(message));
  }
  /** Bring the copy to the provider's committed journal revision. */
  async sync(link, session, owner, signal) {
    const authority = this.platform.runtime.bind({ owner: false, appId: link.appId, namespace: link.appId, releaseId: link.releaseId }),
      journal = new InkAppJournal(this.platform.code.storage, link.appId, STATE, authority),
      saved = await journal.read();
    if (link.revision === saved.revision) return;
    if (saved.value && saved.value.digest !== link.compiled.digest)
      fail(409, 'The provider state belongs to another source revision');
    const recovery = saved.value ? await journal.recover(saved) : { snapshot: null, records: [] };
    link.revision = null;
    await this.request(session, owner, { op: 'load', snapshot: recovery.snapshot, records: recovery.records }, signal);
    link.revision = saved.revision;
    this.counts.loads++;
  }
  evaluate(admitted, owner, signal) {
    const link = this.link(admitted);
    return this.serial(link, async () => {
      const residents = this.platform.code.residents,
        session = await this.session(link, owner, signal);
      try {
        await this.sync(link, session, owner, signal);
        const c = admitted.consumerCode;
        if (c && !link.consumers.has(c.id)) {
          await this.request(session, owner, { op: 'consumer', id: c.id, javascript: c.javascript, functions: c.functions, named: c.named }, signal);
          link.consumers.add(c.id);
        }
        this.counts.evaluations++;
        return await this.request(
          session,
          owner,
          { op: 'evaluate', entry: admitted.binding.entry, input: admitted.binding.input || '[]', plan: admitted.plan.plan, consumer: c?.id },
          signal,
        );
      } catch (error) {
        // An evaluation error with a status (overflow, size) keeps the copy.
        if (!error.status) {
          await residents.drop(session).catch(() => {});
          link.session = null;
          link.revision = null;
        }
        throw error;
      } finally {
        residents.release(session);
      }
    });
  }
  compute(entry, owner, signal) {
    const { admitted } = entry,
      snapshot = { binding: admitted.binding, roots: admitted.roots, plan: admitted.plan.identity, pending: true };
    snapshot.promise = (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          snapshot.stamp = this.reads.stamp(admitted.binding.appId, admitted.binding.releaseId, admitted.roots);
          const result = await this.evaluate(admitted, owner, signal);
          if (Buffer.byteLength(result.wire) > RESULT_LIMIT) fail(413, 'Linked UI data exceeds 128 KiB');
          if (!this.reads.current(snapshot)) continue;
          const previous = entry.snapshot;
          if (previous && previous.wire === result.wire) {
            previous.stamp = snapshot.stamp;
            this.counts.reused++;
            return previous;
          }
          Object.assign(snapshot, { wire: result.wire, value: parseExactJSON(result.wire), scanned: result.scanned, matched: result.matched });
          this.bytes += Buffer.byteLength(result.wire) - (entry.bytes || 0);
          entry.bytes = Buffer.byteLength(result.wire);
          entry.snapshot = snapshot;
          this.trim();
          return snapshot;
        }
        fail(409, 'Linked data changed during rendering; refresh');
      } finally {
        snapshot.pending = false;
        if (entry.pending === snapshot.promise) entry.pending = null;
      }
    })();
    entry.pending = snapshot.promise;
    return snapshot.promise;
  }
  async read(binding, expected, { signal, consumer } = {}) {
    if (!consumer?.appId || !consumer.releaseId) fail(400, 'Link plans run for an installed consumer release');
    this.authorize(binding, consumer);
    const admitted = await this.admit(binding, expected, consumer),
      key = admitted.plan.shared;
    let entry = this.results.get(key);
    if (!entry) this.results.set(key, (entry = { admitted, consumers: new Set(), bytes: 0, snapshot: null, pending: null }));
    this.results.delete(key);
    this.results.set(key, entry);
    entry.consumers.add(consumer.appId);
    entry.owner = consumer.appId;
    entry.used = Date.now();
    if (entry.pending) return entry.pending;
    if (entry.snapshot && this.reads.current(entry.snapshot)) {
      this.counts.hits++;
      return entry.snapshot;
    }
    return this.compute(entry, consumer.appId, signal);
  }
  /** Follow a provider commit on its copies and refresh results that read a written root. */
  onCommit({ namespace, stateKey, before, after, record, source, roots }) {
    if (stateKey !== STATE) return;
    const residents = this.platform.code.residents;
    for (const link of this.links.values()) {
      if (link.appId !== namespace || link.source !== source) continue;
      const session = link.session;
      this.serial(link, async () => {
        // Apply only to the live copy that is exactly one commit behind;
        // anything else reloads from the journal on its next read.
        if (!session || link.session !== session || link.revision !== before || residents.sessions.get(link.key) !== session || session.busy) {
          link.revision = null;
          return;
        }
        await residents.acquire(link.key, () => fail(500, 'Link worker was evicted'));
        try {
          await session.endpoint.request({ op: 'apply', records: [record] });
          link.revision = after;
          this.counts.applies++;
        } catch {
          link.revision = null;
        } finally {
          residents.release(session);
        }
      });
    }
    // Keep recently used results of this provider current.
    const written = roots ? new Set(roots) : null,
      now = Date.now();
    for (const entry of this.results.values())
      if (
        entry.admitted.binding.appId === namespace &&
        now - entry.used < WARM_MS &&
        !entry.pending &&
        (!written || entry.admitted.roots.some((root) => written.has(root)))
      ) {
        this.counts.refreshed++;
        this.compute(entry, entry.owner).catch(() => {});
      }
  }
  observe(event) {
    if (event.type !== 'deleted') return;
    for (const id of event.ids || []) {
      for (const [key, link] of this.links) if (link.appId === id) this.links.delete(key);
      for (const [key, entry] of this.results) {
        entry.consumers.delete(id);
        if (entry.admitted.binding.appId === id || !entry.consumers.size) this.forget(key, entry);
      }
    }
  }
  forget(key, entry) {
    this.results.delete(key);
    this.bytes -= entry.bytes || 0;
  }
  trim() {
    for (const [key, entry] of this.results) {
      if (this.results.size <= CACHE_ENTRIES && this.bytes <= CACHE_BYTES) break;
      if (!entry.pending) this.forget(key, entry);
    }
  }
  close() {
    this.platform.code.commitListeners?.delete(this.listener);
    this.links.clear();
    this.plans.clear();
    this.results.clear();
    this.bytes = 0;
  }
}
