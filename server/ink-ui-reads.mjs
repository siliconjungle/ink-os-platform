import { installedInk, runInstalledInk } from './ink-apps.mjs';
import { stateObjectId } from './app-data.mjs';
import { resolveEffectType, effectTypeEqual } from '../shared/ink-effects.mjs';
import { parseExactJSON } from '../shared/exact-json.mjs';
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
/** Data snapshots are shared only inside the same pinned authority and arguments. */
export class InkUiReads {
  constructor(platform) {
    this.platform = platform;
    this.cache = new Map();
    this.reads = 0;
    this.hits = 0;
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
      return (
        snapshot &&
        snapshot.stamp ===
          this.stamp(snapshot.binding.appId, snapshot.binding.releaseId)
      );
    } catch {
      return false;
    }
  }
  async read(binding, expected, signal) {
    await this.platform.code.readState(binding.appId, 'ink-app:state');
    const key = JSON.stringify([binding, expected]),
      prior = this.cache.get(key);
    if (prior && this.current(prior)) {
      this.hits++;
      return prior.promise;
    }
    const snapshot = {
      binding,
      stamp: this.stamp(binding.appId, binding.releaseId),
    };
    snapshot.promise = (async () => {
      const provider = await installedInk(
        this.platform,
        binding.appId,
        binding.releaseId,
      );
      checkUiRead(provider, binding.entry, expected);
      for (let attempt = 0; attempt < 3; attempt++) {
        snapshot.stamp = this.stamp(binding.appId, binding.releaseId);
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
        this.reads++;
        snapshot.value = parseExactJSON(result.valueWire);
        return snapshot;
      }
      throw Object.assign(
        Error('Exported query changed during rendering; refresh'),
        { status: 409, current: { uiRetry: true, notApplied: true } },
      );
    })();
    this.cache.set(key, snapshot);
    snapshot.promise.catch(() => {
      if (this.cache.get(key) === snapshot) this.cache.delete(key);
    });
    while (this.cache.size > 8)
      this.cache.delete(this.cache.keys().next().value);
    return snapshot.promise;
  }
  close() {
    this.cache.clear();
  }
}
