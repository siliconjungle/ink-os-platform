// Per-root versions of installed apps' Ink state, for precise cross-app reads.
//
// A read of another app's exported query is current while no commit has
// changed a state path that query reads (shared/ink-state-paths.mjs: roots,
// filtered views and keyed rows). Commits announce the paths they changed
// through the code service's commit hints: the runtime's own report, else
// every path of the IR write roots (or of every touched root with an older
// compiler). Any change to an app's state that is
// not explained by a hint, such as a restore, a migration or a replicated
// commit from another device, advances every root of that app. Versions only
// grow, so a stale read is never mistaken for a current one.
import { stateObjectId } from './app-data.mjs';

const STATE = 'ink-app:state',
  PATH_LIMIT = 4096;

export class RootVersions {
  constructor(platform) {
    this.platform = platform;
    this.apps = new Map();
    this.counter = 0;
  }
  token(appId) {
    const authority = this.platform.world.stateCommits?.get(appId + '\0' + STATE);
    if (authority) return 'c:' + authority.revision + ':' + authority.body;
    const state = this.platform.world.get(stateObjectId(appId, STATE));
    return 'w:' + (state?.revision || 0) + ':' + (state?.archived ? '' : state?.body || '');
  }
  entry(appId) {
    let entry = this.apps.get(appId);
    if (!entry) {
      entry = { token: this.token(appId), all: ++this.counter, roots: new Map() };
      this.apps.set(appId, entry);
    }
    return entry;
  }
  /**
   * Record a World event. Returns {appId, roots} for a tracked app whose state
   * changed (roots null when every root may have changed), otherwise null.
   */
  observe(event) {
    if (event.type === 'deleted') {
      for (const id of event.ids || []) this.apps.delete(id);
      return null;
    }
    const appId =
      event.type === 'ink-state' && (event.key === undefined || event.key === STATE)
        ? event.appId
        : event.type === 'object' && event.object?.kind === 'state' && event.object.title === STATE
          ? event.object.namespace
          : null;
    const entry = appId && this.apps.get(appId);
    if (!entry) return null;
    const token = this.token(appId);
    if (token === entry.token) return null;
    entry.token = token;
    const version = ++this.counter,
      hint = event.restore ? null : this.platform.code?.commitHints?.get(appId + '\0' + STATE);
    if (!hint) {
      entry.all = version;
      return { appId, roots: null };
    }
    for (const root of hint.roots) entry.roots.set(root, version);
    // Row paths accumulate with distinct keys: past the bound, forget them all
    // and advance every path once instead.
    if (entry.roots.size > PATH_LIMIT) {
      entry.roots.clear();
      entry.all = version;
    }
    return { appId, roots: [...hint.roots] };
  }
  /** Current versions of an app's roots; an unexplained change advances them all. */
  versions(appId, roots) {
    const entry = this.entry(appId), token = this.token(appId);
    if (token !== entry.token) {
      entry.token = token;
      entry.all = ++this.counter;
    }
    return roots.map((root) => Math.max(entry.all, entry.roots.get(root) || 0));
  }
}
