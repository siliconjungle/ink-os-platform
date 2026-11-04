import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
export const storageIdentity = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const target = storageIdentity({
  node: process.versions.node,
  icu: process.versions.icu,
  platform: process.platform,
  arch: process.arch,
  cpu: cpus()[0]?.model,
});
export const storageTarget = () => target;
export const fixtureNamespace = '1'.repeat(32);
export function scopeStorageQuery(input, namespace) {
  const result = structuredClone(input);
  let nodes = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || ++nodes > 64)
      invalid('Invalid bounded relational source tree');
    if (node.op === 'scan') {
      if (node.namespace !== 'self')
        invalid('Planned app queries use self sources');
      node.namespace = namespace;
    } else if (node.op === 'join') {
      visit(node.left);
      visit(node.right);
    } else if (node.input) visit(node.input);
  };
  visit(result.relation);
  return result;
}
export function unScopeContract(contract) {
  const value = structuredClone(contract),
    visit = (node) => {
      if (node.op === 'scan') node.namespace = 'self';
      else if (node.left) {
        visit(node.left);
        visit(node.right);
      } else if (node.input) visit(node.input);
    };
  visit(value.logical.relation);
  for (const schema of value.schemas) schema.namespace = 'self';
  for (const dep of value.dependencies) dep.namespace = 'self';
  return value;
}
export function scopeContract(contract, namespace) {
  const value = structuredClone(contract);
  value.logical.relation = scopeStorageQuery(
    { relation: value.logical.relation },
    namespace,
  ).relation;
  for (const schema of value.schemas) schema.namespace = namespace;
  for (const dep of value.dependencies) dep.namespace = namespace;
  return value;
}
const plain = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed, required = allowed) =>
  plain(value) &&
  Object.keys(value).every((k) => allowed.includes(k)) &&
  required.every((k) => Object.hasOwn(value, k));
const id = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const invalid = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
const rowShape = (row) =>
  fields(row, ['key', 'values', 'id'], ['key', 'values']) &&
  typeof row.key === 'string' &&
  row.key.length <= 1024 &&
  plain(row.values) &&
  (row.id === undefined || id(row.id));
export function validateStorageWorkload(value) {
  if (
    !fields(value, ['version', 'tables', 'history']) ||
    value.version !== 1 ||
    !Array.isArray(value.tables) ||
    value.tables.length < 1 ||
    value.tables.length > 8 ||
    !Array.isArray(value.history) ||
    value.history.length > 256 ||
    Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024
  )
    invalid('Declare a bounded version 1 storage workload');
  let rows = 0;
  const ids = new Set(),
    rowIds = new Set();
  for (const table of value.tables) {
    if (
      !fields(table, ['id', 'columns', 'rows']) ||
      !id(table.id) ||
      ids.has(table.id) ||
      !Array.isArray(table.columns) ||
      !Array.isArray(table.rows) ||
      table.rows.length > 10000
    )
      invalid('Invalid storage workload table');
    ids.add(table.id);
    rows += table.rows.length;
  }
  for (const table of value.tables)
    for (const row of table.rows) {
      if (!rowShape(row)) invalid('Invalid workload row');
      const key =
        row.id ||
        storageIdentity([fixtureNamespace, table.id, row.key]).slice(0, 32);
      if (!rowShape(row) || ids.has(key) || rowIds.has(key))
        invalid('Invalid or duplicate workload row');
      rowIds.add(key);
    }
  if (rows > 10000) invalid('Storage planning fixture exceeds 10000 rows');
  for (const op of value.history) {
    const allowed =
      op?.op === 'read'
        ? ['op', 'query']
        : op?.op === 'put'
          ? ['op', 'tableId', 'key', 'values', 'id']
          : op?.op === 'delete'
            ? ['op', 'tableId', 'key', 'id']
            : ['op'];
    const required = allowed.filter((k) => k !== 'id');
    if (
      !fields(op, allowed, required) ||
      !['read', 'put', 'delete', 'evict'].includes(op.op)
    )
      invalid('Unknown storage workload operation');
    if (
      op.op === 'read' &&
      (typeof op.query !== 'string' || !op.query || op.query.length > 256)
    )
      invalid('Invalid workload query');
    if (
      ['put', 'delete'].includes(op.op) &&
      (!ids.has(op.tableId) ||
        typeof op.key !== 'string' ||
        op.key.length > 1024 ||
        (op.id !== undefined && (!id(op.id) || ids.has(op.id))))
    )
      invalid('Invalid workload mutation');
    if (op.op === 'put' && !plain(op.values))
      invalid('Invalid workload values');
  }
  return structuredClone(value);
}
export class StorageFixture {
  constructor(workload, { namespace = fixtureNamespace } = {}) {
    this.namespace = namespace;
    this.version = 0;
    this.state = {};
    this.records = new Map();
    this.journal = { check() {} };
    for (const table of workload.tables) {
      this.records.set(table.id, {
        id: table.id,
        namespace,
        kind: 'ink-table',
        title: 'Planning fixture',
        tags: ['ink-table:' + table.id],
        revision: 1,
        body: JSON.stringify({
          format: 'ink-table',
          version: 1,
          columns: table.columns,
        }),
      });
      for (const row of table.rows) this.put({ ...row, tableId: table.id });
    }
  }
  all() {
    return [...this.records.values()];
  }
  rowId(op) {
    return (
      op.id ||
      storageIdentity([this.namespace, op.tableId, op.key]).slice(0, 32)
    );
  }
  put(op) {
    const id = this.rowId(op),
      previous = this.records.get(id),
      record = {
        id,
        namespace: this.namespace,
        kind: 'ink-table-row',
        tags: ['ink-table:' + op.tableId],
        revision: (previous?.revision || 0) + 1,
        body: JSON.stringify({
          format: 'ink-table-row',
          version: 1,
          tableId: op.tableId,
          key: op.key,
          values: op.values,
        }),
      };
    this.records.set(id, record);
    this.version++;
    this.relationalStorage?.apply([{ name: 'put', object: record }]);
  }
  apply(op) {
    if (op.op === 'put') this.put(op);
    else if (op.op === 'delete') {
      const id = this.rowId(op);
      this.records.delete(id);
      this.version++;
      this.relationalStorage?.apply([{ name: 'remove', id }]);
    } else if (op.op === 'evict') this.relationalStorage?.loaded.clear();
  }
}

export function workloadRanges(workload) {
  const rows = new Map(),
    counts = new Map(workload.tables.map((t) => [t.id, 0])),
    ranges = {};
  const id = (op) =>
    op.id ||
    storageIdentity([fixtureNamespace, op.tableId, op.key]).slice(0, 32);
  const put = (op) => {
    const key = id(op),
      old = rows.get(key);
    if (old) counts.set(old, counts.get(old) - 1);
    rows.set(key, op.tableId);
    counts.set(op.tableId, counts.get(op.tableId) + 1);
  };
  for (const table of workload.tables)
    for (const row of table.rows) put({ ...row, tableId: table.id });
  for (const [table, n] of counts) ranges[table] = { min: n, max: n };
  for (const op of workload.history) {
    if (op.op === 'put') put(op);
    else if (op.op === 'delete') {
      const key = id(op),
        old = rows.get(key);
      if (old) {
        counts.set(old, counts.get(old) - 1);
        rows.delete(key);
      }
    }
    for (const [table, n] of counts) {
      ranges[table].min = Math.min(ranges[table].min, n);
      ranges[table].max = Math.max(ranges[table].max, n);
    }
  }
  return ranges;
}
