import { ExactSum } from './relational-numeric.mjs';
import { OrderedIndex } from './ordered-index.mjs';
import {
  valueMatchesType,
  TABLE_KIND,
  ROW_KIND,
  tableTag,
} from '../sdk/src/tables.js';

export const LOW = Symbol('low'),
  HIGH = Symbol('high');
const natural = new Intl.Collator('en', { numeric: true }),
  keys = new Intl.Collator('en');
export function compareValues(a, b, collation = 'natural') {
  if (a === b) return 0;
  if (a === LOW || b === HIGH) return -1;
  if (a === HIGH || b === LOW) return 1;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? 1 : -1;
  a = typeof a === 'object' ? JSON.stringify(a) : String(a);
  b = typeof b === 'object' ? JSON.stringify(b) : String(b);
  if (collation === 'binary') return a < b ? -1 : a > b ? 1 : 0;
  return (collation === 'key' ? keys : natural).compare(a, b);
}
export const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
export const collationProfile = () => ({
  binary: 'utf16-code-unit-v1',
  icu: process.versions.icu,
  natural: natural.resolvedOptions(),
  key: keys.resolvedOptions(),
});
const identity = (namespace, tableId) => namespace + ':' + tableId;
function schema(record) {
  if (record.body.length > 512 * 1024)
    fail(413, 'Table schema exceeds the storage byte budget');
  let value;
  try {
    value = JSON.parse(record.body);
  } catch {
    fail(422, 'Invalid Ink table schema JSON');
  }
  if (
    value?.format !== TABLE_KIND ||
    value.version !== 1 ||
    !Array.isArray(value.columns) ||
    value.columns.length > 64
  )
    fail(422, 'Unsupported Ink table schema');
  const fields = new Map();
  for (const column of value.columns) {
    if (
      !column ||
      typeof column.key !== 'string' ||
      !column.key ||
      column.key.length > 128 ||
      column.key.startsWith('$') ||
      fields.has(column.key) ||
      !['text', 'number', 'integer', 'boolean', 'json'].includes(column.type) ||
      (column.nullable !== undefined && typeof column.nullable !== 'boolean') ||
      (Object.hasOwn(column, 'default') &&
        !valueMatchesType(column.default, column))
    )
      fail(422, 'Invalid Ink table column');
    fields.set(column.key, { type: column.type, nullable: !!column.nullable });
  }
  for (const key of ['$key', '$id', '$revision'])
    fields.set(key, {
      type: key === '$revision' ? 'integer' : 'text',
      nullable: false,
    });
  return {
    table: {
      ...value,
      id: record.id,
      name: record.title,
      namespace: record.namespace,
      revision: record.revision,
    },
    fields,
  };
}
function decode(object, table) {
  const record = JSON.parse(object.body);
  if (
    record?.format !== ROW_KIND ||
    record.version !== 1 ||
    record.tableId !== table.id ||
    typeof record.key !== 'string' ||
    record.key.length > 1024 ||
    !record.values ||
    typeof record.values !== 'object' ||
    Array.isArray(record.values)
  )
    throw Error('Invalid Ink table row');
  const values = Object.fromEntries(
    table.columns.map((column) => {
      const value = Object.hasOwn(record.values, column.key)
        ? record.values[column.key]
        : column.default;
      if (!valueMatchesType(value, column))
        throw Error('Invalid ' + column.key + ' in row ' + record.key);
      return [column.key, value];
    }),
  );
  return {
    ...values,
    $id: object.id,
    $key: record.key,
    $revision: object.revision,
  };
}
class Table {
  constructor(record, objects, stats) {
    Object.assign(this, schema(record));
    this.rows = new Map();
    this.errors = new Map();
    this.keys = new Map();
    this.indexes = new Map();
    this.groups = new Map();
    for (const object of objects) this.put(object, stats);
  }
  remove(id) {
    const row = this.rows.get(id);
    if (row) {
      for (const group of this.groups.values()) group.change(row, -1);
      this.rows.delete(id);
      const bucket = this.keys.get(row.$key);
      bucket.delete(id);
      if (!bucket.size) this.keys.delete(row.$key);
      for (const index of this.indexes.values())
        index.tree.remove(index.key(row));
    }
    this.errors.delete(id);
  }
  put(object, stats) {
    this.remove(object.id);
    try {
      if (stats) stats.decodedRows++;
      const row = decode(object, this.table);
      this.rows.set(row.$id, row);
      for (const group of this.groups.values()) group.change(row, 1);
      if (!this.keys.has(row.$key)) this.keys.set(row.$key, new Set());
      this.keys.get(row.$key).add(row.$id);
      for (const index of this.indexes.values())
        index.tree.insert(index.key(row), row);
    } catch (error) {
      this.errors.set(object.id, error.message);
    }
  }
  check() {
    if (this.errors.size) fail(422, this.errors.values().next().value);
  }
  groupAggregates(id, fields, aggregates, accept, stats) {
    let view = this.groups.get(id);
    if (view) {
      this.groups.delete(id);
      this.groups.set(id, view);
      return view;
    }
    if (this.groups.size >= 2)
      this.groups.delete(this.groups.keys().next().value);
    const groups = new Map(),
      make = (values) => ({
        values,
        rows: 0,
        counts: aggregates.map(() => 0),
        sums: aggregates.map(() => new ExactSum()),
      });
    if (!fields.length) groups.set('[]', make([]));
    view = {
      groups,
      change(row, direction) {
        if (!accept(row)) return;
        const values = fields.map((field) => row[field]),
          key = JSON.stringify(values);
        let group = groups.get(key);
        if (!group) {
          group = make(values);
          groups.set(key, group);
        }
        group.rows += direction;
        aggregates.forEach((aggregate, index) => {
          if (!aggregate.field || row[aggregate.field] !== null) {
            group.counts[index] += direction;
            if (['sum', 'avg'].includes(aggregate.op))
              group.sums[index].add(direction * row[aggregate.field]);
          }
        });
        if (!group.rows && fields.length) groups.delete(key);
      },
    };
    for (const row of this.rows.values()) {
      stats.aggregateBuildRows++;
      view.change(row, 1);
    }
    this.groups.set(id, view);
    return view;
  }
  index(fields, collation, stats, tieDirection = 'asc') {
    const id = JSON.stringify([fields, collation, tieDirection]);
    let index = this.indexes.get(id);
    if (index) {
      this.indexes.delete(id);
      this.indexes.set(id, index);
      return index;
    }
    if (this.indexes.size >= 4)
      this.indexes.delete(this.indexes.keys().next().value);
    const compare = (a, b) => {
      for (let i = 0; i < a.length; i++) {
        let left = a[i],
          right = b[i];
        const bound =
          left === LOW || left === HIGH || right === LOW || right === HIGH;
        const order = compareValues(
          left,
          right,
          i < fields.length
            ? Array.isArray(collation)
              ? collation[i]
              : collation
            : i === fields.length
              ? 'key'
              : 'binary',
        );
        if (order)
          return !bound && i >= fields.length && tieDirection === 'desc'
            ? -order
            : order;
      }
      return 0;
    };
    const encode = (field, value) =>
      this.fields.get(field).type === 'json' ? JSON.stringify(value) : value;
    index = {
      fields,
      encode,
      tree: new OrderedIndex(compare),
      key: (row) => [
        ...fields.map((field) => encode(field, row[field])),
        row.$key,
        row.$id,
      ],
    };
    for (const row of this.rows.values()) {
      index.tree.insert(index.key(row), row);
      stats.indexBuildRows++;
    }
    this.indexes.set(id, index);
    return index;
  }
}
function memberships(object) {
  return object?.kind === ROW_KIND && !object.archived
    ? [...new Set(object.tags || [])]
        .filter((tag) => /^ink-table:[a-f0-9]{32}$/.test(tag))
        .map((tag) => identity(object.namespace, tag.slice(10)))
    : [];
}
/** Rebuildable read-side adapter. World remains authoritative for transactions. */
export class TableStorage {
  constructor(world, options = {}) {
    this.world = world;
    this.limits = {
      rows: 100000,
      tableBytes: 64 * 1024 * 1024,
      cacheRows: 200000,
      cacheBytes: 128 * 1024 * 1024,
      tables: 8,
      ...options,
    };
    if (
      Object.values(this.limits).some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    )
      throw Error('Invalid table storage budget');
    this.memberBytes = new Map();
    this.objects = new Map();
    this.members = new Map();
    this.loaded = new Map();
    this.reset();
  }
  reset() {
    this.objects.clear();
    this.members.clear();
    this.memberBytes.clear();
    this.loaded.clear();
    for (const object of this.world.all()) this.catalogue(object);
    this.state = this.world.state;
    this.version = this.world.version;
  }
  ensure() {
    this.world.journal.check();
    if (this.state !== this.world.state || this.version !== this.world.version)
      this.reset();
  }
  catalogue(object) {
    if (![TABLE_KIND, ROW_KIND].includes(object.kind) || object.archived)
      return;
    this.objects.set(object.id, object);
    for (const key of memberships(object)) {
      if (!this.members.has(key)) this.members.set(key, new Map());
      this.members.get(key).set(object.id, object);
      this.memberBytes.set(
        key,
        (this.memberBytes.get(key) || 0) + object.body.length * 2,
      );
    }
  }
  apply(actions) {
    if (this.state !== this.world.state) {
      this.state = null;
      return;
    }
    for (const action of actions) {
      const id = action.name === 'put' ? action.object.id : action.id,
        old = this.objects.get(id),
        next = action.name === 'put' ? action.object : null;
      for (const key of memberships(old)) {
        this.members.get(key)?.delete(id);
        this.memberBytes.set(
          key,
          (this.memberBytes.get(key) || 0) - old.body.length * 2,
        );
        const table = this.loaded.get(key);
        if (table) {
          table.remove(id);
          table.sourceRows = this.members.get(key)?.size || 0;
          table.sourceBytes = this.memberBytes.get(key) || 0;
        }
      }
      this.objects.delete(id);
      if (old?.kind === TABLE_KIND)
        this.loaded.delete(identity(old.namespace, id));
      if (next) {
        this.catalogue(next);
        if (next.kind === TABLE_KIND)
          this.loaded.delete(identity(next.namespace, id));
        for (const key of memberships(next)) {
          const table = this.loaded.get(key);
          if (table) {
            if (
              (this.members.get(key)?.size || 0) > this.limits.rows ||
              (this.memberBytes.get(key) || 0) > this.limits.tableBytes
            )
              this.loaded.delete(key);
            else {
              table.put(next);
              table.sourceRows = this.members.get(key).size;
              table.sourceBytes = this.memberBytes.get(key);
            }
          }
        }
      }
    }
    this.trim();
    this.version = this.world.version;
  }
  trim(extraRows = 0, extraBytes = 0, reserve = false) {
    while (
      this.loaded.size &&
      (this.loaded.size + (reserve ? 1 : 0) > this.limits.tables ||
        [...this.loaded.values()].reduce(
          (n, table) => n + table.sourceRows,
          0,
        ) +
          extraRows >
          this.limits.cacheRows ||
        [...this.loaded.values()].reduce(
          (n, table) => n + table.sourceBytes,
          0,
        ) +
          extraBytes >
          this.limits.cacheBytes)
    )
      this.loaded.delete(this.loaded.keys().next().value);
  }
  footprint(namespace, tableId) {
    const key = identity(namespace, tableId);
    return {
      rows: this.members.get(key)?.size || 0,
      bytes: this.memberBytes.get(key) || 0,
    };
  }
  describe(namespace, tableId) {
    const record = this.objects.get(tableId);
    if (
      !record ||
      record.namespace !== namespace ||
      record.kind !== TABLE_KIND ||
      record.archived ||
      !record.tags.includes(tableTag(tableId))
    )
      fail(404, 'Table is unavailable');
    return this.loaded.get(identity(namespace, tableId)) || schema(record);
  }
  table(namespace, tableId, stats) {
    const key = identity(namespace, tableId),
      record = this.objects.get(tableId);
    if (
      !record ||
      record.namespace !== namespace ||
      record.kind !== TABLE_KIND ||
      record.archived ||
      !record.tags.includes(tableTag(tableId))
    )
      fail(404, 'Table is unavailable');
    let table = this.loaded.get(key);
    if (!table) {
      const objects = this.members.get(key) || new Map();
      const bytes = this.memberBytes.get(key) || 0;
      if (
        objects.size > this.limits.rows ||
        objects.size > this.limits.cacheRows ||
        bytes > this.limits.tableBytes ||
        bytes > this.limits.cacheBytes
      )
        fail(413, 'Table exceeds the in-memory storage row or byte budget');
      this.trim(objects.size, bytes, true);
      table = new Table(record, objects.values(), stats);
      table.sourceRows = objects.size;
      table.sourceBytes = bytes;
      this.loaded.set(key, table);
    } else {
      this.loaded.delete(key);
      this.loaded.set(key, table);
    }
    table.check();
    return table;
  }
}
