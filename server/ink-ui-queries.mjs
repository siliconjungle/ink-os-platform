import { stringifyExactJSON } from '../shared/exact-json.mjs';
import { queryRelational } from './relational-query.mjs';
import { DataPaths } from './data-path-planning.mjs';
export function scopedUiQuery(query, appId) {
  const result = structuredClone(query),
    visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.op === 'scan') {
        if (node.namespace !== 'self')
          throw Error('UI query namespace changed');
        node.namespace = appId;
      } else if (node.op === 'join') {
        visit(node.left);
        visit(node.right);
      } else if (node.input) visit(node.input);
    };
  visit(result.relation);
  return result;
}
export function currentUiQuery(world, snapshot) {
  if (!snapshot || world.relationalStorage !== snapshot.storage) return false;
  try {
    return snapshot.tokens.every(
      ([namespace, id, token]) =>
        snapshot.storage.dependencyToken(namespace, id) === token,
    );
  } catch {
    return false;
  }
}
export class UiQueries {
  constructor(world) {
    this.world = world;
    this.cache = new Map();
    this.plans = new Map();
    this.reads = 0;
    this.hits = 0;
  }
  control(app, appId, name) {
    if (!app.dataPaths?.plans[name]) return null;
    const key = appId + ':' + app.releaseId + ':' + app.dataPaths.identity;
    if (!this.plans.has(key)) {
      this.plans.set(key, new DataPaths(this.world, app.dataPaths, appId));
      while (this.plans.size > 8)
        this.plans.delete(this.plans.keys().next().value);
    }
    const manager = this.plans.get(key);
    return {
      identity: key + ':' + name,
      query: (query) => manager.query(name, query),
    };
  }
  read(query, control) {
    const key = JSON.stringify([query, control?.identity || null]),
      previous = this.cache.get(key);
    if (currentUiQuery(this.world, previous)) {
      this.hits++;
      this.cache.delete(key);
      this.cache.set(key, previous);
      return previous;
    }
    const result = control
      ? control.query(query)
      : queryRelational(this.world, query);
    this.reads++;
    const snapshot = {
      storage: this.world.relationalStorage,
      tokens: result.dependencies.map((dependency) => [
        dependency.namespace,
        dependency.tableId,
        this.world.relationalStorage.dependencyToken(
          dependency.namespace,
          dependency.tableId,
        ),
      ]),
      data: {
        rows: result.rows,
        total:
          result.total == null
            ? { None: null }
            : { Some: BigInt(result.total) },
        version: BigInt(result.version),
      },
    };
    if (Buffer.byteLength(stringifyExactJSON(snapshot.data)) > 128 * 1024)
      throw Object.assign(Error('UI data input exceeds 128 KiB'), {
        status: 413,
      });
    this.cache.set(key, snapshot);
    while (this.cache.size > 8)
      this.cache.delete(this.cache.keys().next().value);
    return snapshot;
  }
  close() {
    this.cache.clear();
    this.plans.clear();
  }
}
