import { installedInk, runInstalledInk } from './ink-apps.mjs';
import { resolveEffectType, effectTypeEqual } from '../shared/ink-effects.mjs';
import { parseExactJSON } from '../shared/exact-json.mjs';
import { RootVersions } from './ink-root-versions.mjs';
import { readRoots } from './ink-footprints.mjs';
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
/**
 * Data snapshots are shared only inside the same pinned authority and arguments.
 * A snapshot stays current until a commit writes a state root its exported
 * query reads (see RootVersions); a recomputed snapshot with identical exact
 * bytes keeps its identity, so consumers whose inputs did not change do not
 * recompute their views.
 */
export class InkUiReads {
  constructor(platform) {
    this.platform = platform;
    this.cache = new Map();
    this.latest = new Map();
    this.versions = new RootVersions(platform);
    this.links = new InkLinks(platform, this);
    this.reads = 0;
    this.hits = 0;
    this.reused = 0;
  }
  stamp(appId, releaseId, roots = null) {
    const app = this.platform.app(appId),
      meta = JSON.parse(app.body);
    if (meta.releaseId !== releaseId)
      fail(409, 'The exported query release changed; rebuild its consumers');
    if (!meta.capabilities?.includes('code.execute'))
      fail(403, 'The exported query app cannot execute');
    return JSON.stringify([
      app.revision,
      releaseId,
      roots ? this.versions.versions(appId, roots) : this.versions.token(appId),
    ]);
  }
  current(snapshot) {
    try {
      return (
        snapshot &&
        snapshot.stamp ===
          this.stamp(
            snapshot.binding.appId,
            snapshot.binding.releaseId,
            snapshot.roots,
          )
      );
    } catch {
      return false;
    }
  }
  /** Record a World event; returns the provider whose roots changed, if tracked. */
  observe(event) {
    this.links.observe(event);
    return this.versions.observe(event);
  }
  async roots(binding) {
    const provider = await installedInk(
        this.platform,
        binding.appId,
        binding.releaseId,
      ),
      compiled = await this.platform.code.compile(provider.source),
      entry = compiled.entries.find((entry) => entry.name === binding.entry);
    return {
      provider,
      roots: entry
        ? readRoots(await this.platform.code.footprints(compiled), compiled, entry)
        : null,
    };
  }
  async read(binding, expected, signal, consumer) {
    if (binding.plan)
      return this.links.read(binding, expected, { signal, consumer });
    await this.platform.code.readState(binding.appId, 'ink-app:state');
    const key = JSON.stringify([binding, expected]),
      prior = this.cache.get(key);
    if (prior && (prior.pending || this.current(prior))) {
      this.hits++;
      return prior.promise;
    }
    const snapshot = { binding, roots: null, pending: true };
    snapshot.promise = (async () => {
      const { provider, roots } = await this.roots(binding);
      checkUiRead(provider, binding.entry, expected);
      snapshot.roots = roots;
      for (let attempt = 0; attempt < 3; attempt++) {
        snapshot.stamp = this.stamp(binding.appId, binding.releaseId, roots);
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
        snapshot.pending = false;
        this.reads++;
        const previous = this.latest.get(key);
        if (previous && previous.wire === result.valueWire) {
          // Same exact value: keep the identity consumers cached their views on.
          previous.stamp = snapshot.stamp;
          previous.roots = roots;
          this.reused++;
          return previous;
        }
        snapshot.wire = result.valueWire;
        snapshot.value = parseExactJSON(result.valueWire);
        this.latest.set(key, snapshot);
        while (this.latest.size > 32)
          this.latest.delete(this.latest.keys().next().value);
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
        // A reused snapshot is the cache entry from now on.
        if (value !== snapshot && this.cache.get(key) === snapshot)
          this.cache.set(key, value);
      },
      () => {
        snapshot.pending = false;
        if (this.cache.get(key) === snapshot) this.cache.delete(key);
      },
    );
    while (this.cache.size > 8)
      this.cache.delete(this.cache.keys().next().value);
    return snapshot.promise;
  }
  close() {
    this.cache.clear();
    this.latest.clear();
    this.links.close();
  }
}
