import { stringifyExactJSON } from '../shared/exact-json.mjs';
import { queryRelational } from './relational-query.mjs';
const canonical = (value) =>
  JSON.stringify(value, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
export function scopedUiQuery(query, appId) {
  const result = structuredClone(query),
    visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.op === 'scan') {
        if (node.namespace !== 'self')
          throw Error('UI query namespace changed');
        node.namespace = appId;
      }
      for (const value of Object.values(node))
        if (value && typeof value === 'object')
          Array.isArray(value) ? value.forEach(visit) : visit(value);
    };
  visit(result);
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
    this.reads = 0;
    this.hits = 0;
  }
  read(query) {
    const key = canonical(query),
      previous = this.cache.get(key);
    if (currentUiQuery(this.world, previous)) {
      this.hits++;
      this.cache.delete(key);
      this.cache.set(key, previous);
      return previous;
    }
    const result = queryRelational(this.world, query);
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
  }
}
