import { ExactSum, aggregateValue } from './relational-numeric.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RELATIONAL_FORMAT } from '../sdk/src/relations.js';
import { valueMatchesType } from '../sdk/src/tables.js';
import {
  TableStorage,
  compareValues,
  collationProfile,
  LOW,
  HIGH,
  fail,
} from './table-storage.mjs';

// A stateless cursor cannot cross a storage implementation upgrade silently.
const backendDigest = createHash('sha256');
for (const path of [
  './relational-query.mjs',
  './table-storage.mjs',
  './ordered-index.mjs',
  './relational-numeric.mjs',
  '../sdk/src/tables.js',
  '../sdk/src/relations.js',
])
  backendDigest
    .update(path + '\0')
    .update(readFileSync(new URL(path, import.meta.url)));
const backendHash = backendDigest.digest('hex');
const orderedGroups = (groups) =>
  [...groups.entries()]
    .sort(([a], [b]) => compareValues(a, b, 'binary'))
    .map(([, value]) => value);
const own = (value, key) => Object.hasOwn(value, key),
  equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function shape(value, allowed, required = []) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !own(value, key))
  )
    fail(400, 'Invalid relational request fields');
}
function name(value) {
  if (typeof value !== 'string' || !value || value.length > 256)
    fail(400, 'Invalid relational field name');
  return value;
}
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numeric = (type) => ['integer', 'number'].includes(type);
function compatible(a, b) {
  return a.type === b.type || (numeric(a.type) && numeric(b.type));
}
function field(schema, ref) {
  name(ref);
  const type = schema.get(ref);
  if (!type) fail(400, 'Unknown relational column: ' + ref);
  return type;
}
function expression(input, schema, budget) {
  if (++budget.expressions > 256)
    fail(413, 'Relational predicate budget exceeded');
  if (own(input || {}, 'column')) {
    shape(input, ['column'], ['column']);
    const type = field(schema, input.column);
    return {
      type,
      refs: [input.column],
      get: (row) => row[input.column],
      column: input.column,
    };
  }
  if (own(input || {}, 'literal')) {
    shape(input, ['literal'], ['literal']);
    const value = input.literal;
    return {
      type: {
        type:
          value === null
            ? 'null'
            : typeof value === 'string'
              ? 'text'
              : typeof value === 'boolean'
                ? 'boolean'
                : typeof value === 'number'
                  ? Number.isSafeInteger(value)
                    ? 'integer'
                    : 'number'
                  : 'json',
        nullable: value === null,
      },
      refs: [],
      get: () => value,
      literal: true,
      value,
    };
  }
  fail(400, 'Use a column reference or a typed literal');
}
function predicate(input, schema, budget) {
  if (++budget.expressions > 256)
    fail(413, 'Relational predicate budget exceeded');
  if (['and', 'or'].includes(input?.op)) {
    shape(input, ['op', 'args'], ['op', 'args']);
    if (!Array.isArray(input.args) || input.args.length > 32)
      fail(400, 'Invalid relational conjunction');
    const args = input.args.map((value) => predicate(value, schema, budget));
    return {
      refs: args.flatMap((arg) => arg.refs),
      atoms:
        input.op === 'and' && args.every((arg) => arg.atoms)
          ? args.flatMap((arg) => arg.atoms)
          : null,
      test: (row) =>
        input.op === 'and'
          ? args.every((arg) => arg.test(row))
          : args.some((arg) => arg.test(row)),
    };
  }
  if (input?.op === 'not') {
    shape(input, ['op', 'arg'], ['op', 'arg']);
    const arg = predicate(input.arg, schema, budget);
    return { refs: arg.refs, atoms: null, test: (row) => !arg.test(row) };
  }
  shape(input, ['op', 'left', 'right'], ['op', 'left', 'right']);
  if (
    !['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'].includes(input.op)
  )
    fail(400, 'Unknown relational comparison');
  const left = expression(input.left, schema, budget),
    right = expression(input.right, schema, budget),
    op = input.op;
  if (op === 'in') {
    if (
      !right.literal ||
      !Array.isArray(right.value) ||
      right.value.length > 100 ||
      right.value.some((value) => !valueMatchesType(value, left.type))
    )
      fail(400, 'in requires up to 100 typed values');
  } else if (op === 'contains') {
    if (left.type.type !== 'text' || right.type.type !== 'text')
      fail(400, 'contains requires text');
  } else if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
    if (
      !compatible(left.type, right.type) ||
      !['text', 'integer', 'number'].includes(left.type.type) ||
      right.type.type === 'null'
    )
      fail(400, 'Range comparisons require matching ordered values');
  } else if (left.type.type === 'null' || right.type.type === 'null') {
    if (!(left.type.nullable || right.type.nullable))
      fail(400, 'Null requires a nullable column');
  } else if (
    !compatible(left.type, right.type) &&
    !(left.type.type === 'json' && right.literal)
  )
    fail(400, 'Relational comparison type mismatch');
  if (
    right.literal &&
    op !== 'in' &&
    right.type.type !== 'null' &&
    !valueMatchesType(right.value, left.type)
  )
    fail(400, 'Invalid relational literal');
  const test = (row) => {
    const a = left.get(row),
      b = right.get(row);
    switch (op) {
      case 'eq':
        return equal(a, b);
      case 'ne':
        return !equal(a, b);
      case 'in':
        return b.some((value) => equal(a, value));
      case 'contains':
        return (
          typeof a === 'string' &&
          typeof b === 'string' &&
          a.toLowerCase().includes(b.toLowerCase())
        );
      default:
        if (a === null || b === null) return false;
        const n = compareValues(a, b, 'binary');
        return op === 'gt'
          ? n > 0
          : op === 'gte'
            ? n >= 0
            : op === 'lt'
              ? n < 0
              : n <= 0;
    }
  };
  return {
    refs: [...left.refs, ...right.refs],
    test,
    atoms:
      left.column && right.literal
        ? [{ ref: left.column, op, value: right.value }]
        : null,
  };
}
function compile(relation, context) {
  if (++context.nodes > 64) fail(413, 'Relational operator budget exceeded');
  const op = relation?.op;
  if (op === 'scan') {
    shape(
      relation,
      ['op', 'namespace', 'tableId', 'as'],
      ['op', 'namespace', 'tableId', 'as'],
    );
    if (
      !/^[a-f0-9]{32}$/.test(relation.namespace) ||
      !/^[a-f0-9]{32}$/.test(relation.tableId) ||
      !/^[$A-Za-z_][$A-Za-z_0-9]{0,31}$/.test(relation.as)
    )
      fail(400, 'Invalid relational table identity');
    if (context.aliases.has(relation.as))
      fail(400, 'Relational source aliases must be unique');
    context.aliases.add(relation.as);
    const table = context.storage.describe(
        relation.namespace,
        relation.tableId,
      ),
      schema = new Map(),
      lineage = new Map();
    for (const [key, type] of table.fields) {
      schema.set(relation.as + '.' + key, type);
      lineage.set(relation.as + '.' + key, { alias: relation.as, field: key });
    }
    const node = { op, ...relation, table, schema, lineage };
    context.sources.set(relation.as, node);
    return node;
  }
  if (op === 'join') {
    shape(
      relation,
      ['op', 'left', 'right', 'on', 'kind'],
      ['op', 'left', 'right', 'on', 'kind'],
    );
    if (
      !['inner', 'left', 'anti'].includes(relation.kind) ||
      !Array.isArray(relation.on) ||
      !relation.on.length ||
      relation.on.length > 8
    )
      fail(400, 'Invalid equijoin');
    const left = compile(relation.left, context),
      right = compile(relation.right, context);
    for (const key of right.schema.keys())
      if (left.schema.has(key)) fail(400, 'Ambiguous joined column');
    for (const pair of relation.on) {
      shape(pair, ['left', 'right'], ['left', 'right']);
      const a = field(left.schema, pair.left),
        b = field(right.schema, pair.right);
      if (!compatible(a, b)) fail(400, 'Join keys have different types');
    }
    const schema = new Map(left.schema);
    if (relation.kind !== 'anti')
      for (const [key, type] of right.schema)
        schema.set(key, {
          ...type,
          nullable: relation.kind === 'left' || type.nullable,
        });
    return {
      op,
      left,
      right,
      on: relation.on,
      kind: relation.kind,
      schema,
      lineage: new Map([
        ...left.lineage,
        ...(relation.kind === 'anti' ? [] : right.lineage),
      ]),
    };
  }
  shape(
    relation,
    op === 'filter'
      ? ['op', 'input', 'predicate']
      : op === 'project'
        ? ['op', 'input', 'fields']
        : op === 'group'
          ? ['op', 'input', 'by', 'aggregates']
          : op === 'order'
            ? ['op', 'input', 'by']
            : ['op', 'input'],
    ['op', 'input'],
  );
  const input = compile(relation.input, context);
  if (op === 'filter') {
    const pred = predicate(relation.predicate, input.schema, context);
    return { op, input, pred, schema: input.schema, lineage: input.lineage };
  }
  if (op === 'project') {
    if (
      !object(relation.fields) ||
      !Object.keys(relation.fields).length ||
      Object.keys(relation.fields).length > 128
    )
      fail(400, 'Invalid relational projection');
    const fields = new Map(),
      schema = new Map(),
      lineage = new Map();
    for (const [key, ref] of Object.entries(relation.fields)) {
      if (key === '*') {
        name(ref);
        for (const full of input.schema.keys())
          if (full.startsWith(ref + '.'))
            fields.set(full.slice(ref.length + 1), full);
        if (!fields.size) fail(400, 'Unknown projection source');
      } else {
        name(key);
        fields.set(key, ref);
      }
    }
    for (const [key, ref] of fields) {
      schema.set(key, field(input.schema, ref));
      if (input.lineage.has(ref)) lineage.set(key, input.lineage.get(ref));
    }
    return { op, input, fields, schema, lineage };
  }
  if (op === 'order') {
    if (
      !Array.isArray(relation.by) ||
      !relation.by.length ||
      relation.by.length > 8
    )
      fail(400, 'Invalid relational order');
    const by = relation.by.map((value) => {
      shape(value, ['field', 'direction', 'collation'], ['field']);
      if (
        field(input.schema, value.field).type === 'json' ||
        !['asc', 'desc', undefined].includes(value.direction) ||
        !['natural', 'key', 'binary', undefined].includes(value.collation)
      )
        fail(400, 'Invalid typed relational order');
      return {
        field: value.field,
        direction: value.direction || 'asc',
        collation: value.collation || 'binary',
      };
    });
    return { op, input, by, schema: input.schema, lineage: input.lineage };
  }
  if (op === 'distinct')
    return { op, input, schema: input.schema, lineage: input.lineage };
  if (op === 'group') {
    if (
      !object(relation.by) ||
      !object(relation.aggregates) ||
      Object.keys(relation.by).length > 8 ||
      !Object.keys(relation.aggregates).length ||
      Object.keys(relation.aggregates).length > 16
    )
      fail(400, 'Invalid grouped relation');
    const schema = new Map(),
      by = new Map(),
      aggregates = new Map();
    for (const [key, ref] of Object.entries(relation.by)) {
      name(key);
      by.set(key, ref);
      schema.set(key, field(input.schema, ref));
    }
    for (const [key, value] of Object.entries(relation.aggregates)) {
      name(key);
      if (schema.has(key)) fail(400, 'Duplicate grouped output');
      shape(value, ['op', 'field'], ['op']);
      if (
        !['count', 'sum', 'min', 'max', 'avg'].includes(value.op) ||
        (value.op !== 'count' && !value.field)
      )
        fail(400, 'Invalid relational aggregate');
      const type = value.field ? field(input.schema, value.field) : null;
      if (
        (['sum', 'avg'].includes(value.op) && !numeric(type.type)) ||
        (['min', 'max'].includes(value.op) &&
          !['number', 'integer', 'text'].includes(type.type))
      )
        fail(400, 'Aggregate needs an ordered or numeric column');
      schema.set(key, {
        type:
          value.op === 'count'
            ? 'integer'
            : value.op === 'sum' || value.op === 'avg'
              ? 'number'
              : type.type,
        nullable: value.op !== 'count',
      });
      aggregates.set(key, value);
    }
    return {
      op,
      input,
      by,
      aggregates,
      schema,
      lineage: new Map(),
      logical: relation,
    };
  }
  fail(400, 'Unknown relational operator');
}
function simple(node) {
  const steps = [];
  let scan = node;
  while (['filter', 'order', 'project'].includes(scan.op)) {
    steps.unshift(scan);
    scan = scan.input;
  }
  if (
    scan.op !== 'scan' ||
    steps.filter((node) => node.op === 'order').length > 1
  )
    return null;
  const atoms = [];
  let conjunctive = true;
  for (const step of steps)
    if (step.op === 'filter') {
      if (!step.pred.atoms) {
        conjunctive = false;
        continue;
      }
      for (const atom of step.pred.atoms) {
        const source = step.input.lineage.get(atom.ref);
        if (!source || source.alias !== scan.as) {
          conjunctive = false;
          continue;
        }
        atoms.push({ ...atom, field: source.field });
      }
    }
  const order = steps.find((step) => step.op === 'order'),
    by = order?.by.map((value) => ({
      ...value,
      field: order.input.lineage.get(value.field)?.field,
    }));
  if (by?.some((value) => !value.field)) return null;
  const transform = (row) => {
    let value = Object.fromEntries(
      [...(scan.required || scan.schema.keys())].map((ref) => [
        ref,
        row[scan.lineage.get(ref).field],
      ]),
    );
    for (const step of steps) {
      if (step.op === 'filter' && !step.pred.test(value)) return null;
      if (step.op === 'project')
        value = Object.fromEntries(
          [...step.fields]
            .filter(([key]) => !step.required || step.required.has(key))
            .map(([key, ref]) => [key, value[ref]]),
        );
    }
    return value;
  };
  return { scan, steps, atoms, conjunctive, by, transform };
}
function bounds(index, equals, range, table, stats) {
  const low = [],
    high = [];
  for (const name of index.fields) {
    if (equals.has(name)) {
      low.push(index.encode(name, equals.get(name)));
      high.push(index.encode(name, equals.get(name)));
    } else {
      low.push(range?.lower?.value ?? LOW);
      high.push(
        range?.upper?.value ??
          (range && table.fields.get(name).nullable ? null : HIGH),
      );
    }
  }
  while (low.length < index.fields.length + 2)
    low.push(range?.lower && !range.lower.inclusive ? HIGH : LOW);
  while (high.length < index.fields.length + 2)
    high.push(
      range?.upper && !range.upper.inclusive
        ? LOW
        : range &&
            table.fields.get(index.fields.at(-1)).nullable &&
            !range.upper
          ? LOW
          : HIGH,
    );
  return [index.tree.rank(low, stats), index.tree.rank(high, stats)];
}
function access(path, context) {
  const { table } = path.scan;
  const equals = new Map(),
    ranges = new Map();
  for (const atom of path.atoms) {
    if (atom.op === 'eq') equals.set(atom.field, atom.value);
    if (['lt', 'lte', 'gt', 'gte'].includes(atom.op)) {
      const range = ranges.get(atom.field) || {};
      const end = atom.op === 'lt' || atom.op === 'lte' ? 'upper' : 'lower',
        inclusive = atom.op === 'lte' || atom.op === 'gte',
        previous = range[end];
      if (
        !previous ||
        (end === 'lower'
          ? compareValues(atom.value, previous.value, 'binary') > 0
          : compareValues(atom.value, previous.value, 'binary') < 0) ||
        (equal(atom.value, previous.value) && !inclusive)
      )
        range[end] = { value: atom.value, inclusive };
      ranges.set(atom.field, range);
    }
  }
  const point = equals.has('$key');
  const primary = path.by?.length === 1 ? path.by[0] : null;
  // Equality prefixes are binary (predicate equality), independent of the
  // requested natural-text ordering on the final index column.
  const prefix = [...equals.keys()]
    .filter((field) => field !== '$key')
    .sort()
    .slice(0, 3);
  if (!path.by && !point && !prefix.length && !ranges.size) {
    const exact = path.conjunctive && !path.atoms.length,
      plan = {
        operator: 'table-scan',
        tableId: table.table.id,
        estimatedRows: table.rows.size,
        ordered: false,
        exactCount: exact,
      };
    context.plans.push(plan);
    const primary = table.index(['$key'], ['key'], context.stats);
    plan.index = ['$key'];
    return {
      ...path,
      ordered: false,
      exact,
      count: table.rows.size,
      plan,
      *rows(offset = 0, limit = Infinity) {
        yield* primary.tree.range(
          offset,
          Math.min(primary.tree.size, offset + limit),
          false,
          context.stats,
        );
      },
    };
  }

  let ordered = !!primary;
  let last = primary?.field || ranges.keys().next().value || '$key';
  if (
    primary &&
    ranges.has(last) &&
    table.fields.get(last).type === 'text' &&
    primary.collation !== 'binary'
  ) {
    ordered = false;
    last = ranges.keys().next().value;
  }
  let fields = [...prefix, ...(prefix.includes(last) ? [] : [last])],
    collations = fields.map((field) =>
      field === last && !prefix.includes(field)
        ? ordered
          ? primary?.collation || 'binary'
          : 'binary'
        : 'binary',
    );
  let range = equals.has(last) ? undefined : ranges.get(last),
    index = point
      ? null
      : table.index(fields, collations, context.stats, primary?.direction);
  let start = 0,
    end = 0,
    rows;
  if (point) {
    rows = [...(table.keys.get(equals.get('$key')) || [])]
      .map((id) => table.rows.get(id))
      .sort((a, b) => compareValues(a.$id, b.$id, 'binary'));
    ordered = !primary || primary.field === '$key';
  } else [start, end] = bounds(index, equals, range, table, context.stats);
  const alternatives = [];
  if (!point && end - start > 64) {
    for (const field of ranges.keys()) {
      if (alternatives.length >= 2) break;
      if (field === last || equals.has(field)) continue;
      const candidateFields = [
          ...prefix,
          ...(prefix.includes(field) ? [] : [field]),
        ],
        candidateIndex = table.index(
          candidateFields,
          candidateFields.map(() => 'binary'),
          context.stats,
        );
      const [a, b] = bounds(
          candidateIndex,
          equals,
          ranges.get(field),
          table,
          context.stats,
        ),
        rows = Math.max(0, b - a),
        cost = rows * (primary ? 1 + Math.log2(rows + 1) : 1);
      alternatives.push({ index: candidateFields, rows, estimatedWork: cost });
      if (cost < Math.max(0, end - start)) {
        fields = candidateFields;
        collations = candidateFields.map(() => 'binary');
        index = candidateIndex;
        start = a;
        end = b;
        last = field;
        range = ranges.get(field);
        ordered = false;
      }
    }
  }
  const covered = new Set([
    ...prefix,
    ...(fields.includes(last) ? [last] : []),
  ]);
  const exact =
    path.conjunctive &&
    path.atoms.every((atom) => {
      if (point)
        return (
          atom.field === '$key' &&
          atom.op === 'eq' &&
          equal(atom.value, equals.get('$key'))
        );
      if (
        !covered.has(atom.field) ||
        !['eq', 'gt', 'gte', 'lt', 'lte'].includes(atom.op)
      )
        return false;
      if (atom.op === 'eq')
        return (
          equal(atom.value, equals.get(atom.field)) &&
          (collations[fields.indexOf(atom.field)] === 'binary' ||
            table.fields.get(atom.field).type !== 'text')
        );
      return (
        atom.field === last &&
        !equals.has(last) &&
        (collations.at(-1) === 'binary' ||
          table.fields.get(last).type !== 'text')
      );
    });
  const count = point ? rows.length : Math.max(0, end - start),
    reverse = primary?.direction === 'desc';
  const plan = {
    operator: point ? 'key-lookup' : 'ordered-index',
    tableId: table.table.id,
    index: point ? ['$key'] : fields,
    estimatedRows: count,
    ordered: ordered && !!primary,
    exactCount: exact,
    ...(alternatives.length ? { alternatives } : {}),
    keys: point ? [equals.get('$key')] : [],
    range: point
      ? null
      : {
          equals: Object.fromEntries(
            fields
              .filter((field) => equals.has(field))
              .map((field) => [field, equals.get(field)]),
          ),
          ...(range ? { field: last, ...range } : {}),
        },
  };
  context.plans.push(plan);
  return {
    ...path,
    ordered: ordered && !!primary,
    exact,
    count,
    plan,
    *rows(offset = 0, limit = Infinity) {
      if (point) {
        const selected = rows;
        yield* selected.slice(
          offset,
          Number.isFinite(limit) ? offset + limit : undefined,
        );
        return;
      }
      if (reverse)
        yield* index.tree.range(
          start,
          Math.max(start, end - offset),
          true,
          context.stats,
        );
      else
        yield* index.tree.range(
          Math.min(end, start + offset),
          end,
          false,
          context.stats,
        );
    },
  };
}
function tick(context) {
  if (++context.stats.visitedRows > 500000)
    fail(413, 'Relational query work budget exceeded');
}
function materialize(iterator, context) {
  const rows = [];
  for (const row of iterator) {
    if (rows.length >= 100000)
      fail(413, 'Relational intermediate row budget exceeded');
    rows.push(row);
  }
  return rows;
}
function orderRows(rows, by) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const order of by) {
        const result =
          compareValues(
            a.row[order.field],
            b.row[order.field],
            order.collation,
          ) * (order.direction === 'desc' ? -1 : 1);
        if (result) return result;
      }
      return a.index - b.index;
    })
    .map((value) => value.row);
}
function* executeSimple(selected, context) {
  if (selected.by && !selected.ordered) {
    const rows = [];
    for (const row of selected.rows()) {
      tick(context);
      if (selected.transform(row)) {
        if (rows.length >= 100000)
          fail(413, 'Relational sort row budget exceeded');
        rows.push(row);
      }
    }
    context.plans.push({ operator: 'sort' });
    for (const row of orderRows(rows, [
      ...selected.by,
      { field: '$key', direction: 'asc', collation: 'key' },
      { field: '$id', direction: 'asc', collation: 'binary' },
    ]))
      yield selected.transform(row);
    return;
  }
  for (const row of selected.rows()) {
    tick(context);
    const value = selected.transform(row);
    if (value) yield value;
  }
}
function* execute(node, context) {
  const path = simple(node);
  if (path) {
    yield* executeSimple(access(path, context), context);
    return;
  }
  if (node.op === 'filter') {
    for (const row of execute(node.input, context)) {
      tick(context);
      if (node.pred.test(row)) yield row;
    }
    return;
  }
  if (node.op === 'project') {
    for (const row of execute(node.input, context)) {
      tick(context);
      yield Object.fromEntries(
        [...node.fields]
          .filter(([key]) => !node.required || node.required.has(key))
          .map(([key, ref]) => [key, row[ref]]),
      );
    }
    return;
  }
  if (node.op === 'order') {
    context.plans.push({ operator: 'sort' });
    yield* orderRows(
      materialize(execute(node.input, context), context),
      node.by,
    );
    return;
  }
  if (node.op === 'distinct') {
    const seen = new Set();
    for (const row of execute(node.input, context)) {
      tick(context);
      const key = JSON.stringify(
        [...node.schema.keys()].map((key) => row[key]),
      );
      if (!seen.has(key)) {
        if (seen.size >= 100000)
          fail(413, 'Relational distinct budget exceeded');
        seen.add(key);
        yield row;
      }
    }
    return;
  }
  if (node.op === 'join') {
    context.plans.push({ operator: 'hash-join', kind: node.kind });
    const right = new Map(),
      key = (row, side) => {
        const values = node.on.map((pair) => row[pair[side]]);
        return values.includes(null) ? null : JSON.stringify(values);
      };
    let count = 0;
    for (const row of execute(node.right, context)) {
      tick(context);
      if (++count > 100000) fail(413, 'Relational join build budget exceeded');
      const value = key(row, 'right');
      if (value === null) continue;
      if (!right.has(value)) right.set(value, []);
      right.get(value).push(row);
    }
    let produced = 0;
    for (const row of execute(node.left, context)) {
      tick(context);
      const matches = right.get(key(row, 'left')) || [];
      if (node.kind === 'anti') {
        if (!matches.length) {
          if (++produced > 100000)
            fail(413, 'Relational join result budget exceeded');
          yield row;
        }
        continue;
      }
      if (!matches.length && node.kind === 'left') {
        if (++produced > 100000)
          fail(413, 'Relational join result budget exceeded');
        yield {
          ...row,
          ...Object.fromEntries(
            [...node.right.schema.keys()].map((key) => [key, null]),
          ),
        };
      } else
        for (const match of matches) {
          tick(context);
          if (++produced > 100000)
            fail(413, 'Relational join result budget exceeded');
          yield { ...row, ...match };
        }
    }
    return;
  }
  if (node.op === 'group') {
    const path = simple(node.input),
      definitions = [...node.aggregates.values()];
    if (
      path &&
      definitions.every((value) => ['count', 'sum', 'avg'].includes(value.op))
    ) {
      const source = (ref) => node.input.lineage.get(ref)?.field,
        fields = [...node.by.values()].map(source),
        aggregates = definitions.map((value) => ({
          op: value.op,
          field: value.field ? source(value.field) : null,
        }));
      if (
        fields.every(Boolean) &&
        aggregates.every(
          (value, index) => value.field || !definitions[index].field,
        )
      ) {
        const view = path.scan.table.groupAggregates(
          hash(node.logical),
          fields,
          aggregates,
          (row) => !!path.transform(row),
          context.stats,
        );
        context.plans.push({
          operator: aggregates.every((value) => value.op === 'count')
            ? 'maintained-counts'
            : 'maintained-aggregates',
          tableId: path.scan.tableId,
          groups: view.groups.size,
        });
        for (const group of orderedGroups(view.groups)) {
          tick(context);
          yield Object.fromEntries(
            [...node.by.keys()]
              .map((key, index) => [key, group.values[index]])
              .concat(
                [...node.aggregates.keys()].map((key, index) => [
                  key,
                  aggregates[index].op === 'count'
                    ? group.counts[index]
                    : aggregateValue(
                        group.sums[index],
                        group.counts[index],
                        aggregates[index].op === 'avg',
                      ),
                ]),
              ),
          );
        }
        return;
      }
    }
    context.plans.push({ operator: 'hash-aggregate' });
    const groups = new Map(),
      make = (values) => ({
        values,
        aggregates: new Map(
          [...node.aggregates].map(([key]) => [
            key,
            { count: 0, sum: new ExactSum(), value: null },
          ]),
        ),
      });
    if (!node.by.size) groups.set('[]', make([]));
    for (const row of execute(node.input, context)) {
      tick(context);
      const values = [...node.by.values()].map((key) => row[key]),
        key = JSON.stringify(values);
      if (!groups.has(key)) {
        if (groups.size >= 100000)
          fail(413, 'Relational group budget exceeded');
        groups.set(key, make(values));
      }
      const group = groups.get(key);
      for (const [key, aggregate] of node.aggregates) {
        const state = group.aggregates.get(key),
          value = aggregate.field ? row[aggregate.field] : 1;
        if (value === null) continue;
        state.count++;
        if (['sum', 'avg'].includes(aggregate.op)) state.sum.add(value);
        if (
          (aggregate.op === 'min' &&
            (state.value === null ||
              compareValues(value, state.value, 'binary') < 0)) ||
          (aggregate.op === 'max' &&
            (state.value === null ||
              compareValues(value, state.value, 'binary') > 0))
        )
          state.value = value;
      }
    }
    for (const group of orderedGroups(groups))
      yield Object.fromEntries(
        [...node.by.keys()]
          .map((key, index) => [key, group.values[index]])
          .concat(
            [...node.aggregates].map(([key, aggregate]) => {
              const state = group.aggregates.get(key);
              return [
                key,
                aggregate.op === 'count'
                  ? state.count
                  : aggregate.op === 'sum'
                    ? aggregateValue(state.sum, state.count)
                    : aggregate.op === 'avg'
                      ? aggregateValue(state.sum, state.count, true)
                      : state.value,
              ];
            }),
          ),
      );
    return;
  }
  fail(400, 'Unsupported relational execution');
}
function dependencies(node, context) {
  const required = new Map(
    [...context.sources.keys()].map((alias) => [alias, new Set()]),
  );
  const add = (node, refs) => {
    for (const ref of refs) {
      const source = node.lineage.get(ref);
      if (source) required.get(source.alias).add(source.field);
    }
  };
  const walk = (node, needed) => {
    node.required = new Set(needed);
    if (node.op === 'scan') {
      add(node, needed);
      return;
    }
    if (node.op === 'join') {
      const left = [...needed].filter((ref) => node.left.schema.has(ref)),
        right = [...needed].filter((ref) => node.right.schema.has(ref));
      walk(node.left, [...left, ...node.on.map((pair) => pair.left)]);
      walk(node.right, [...right, ...node.on.map((pair) => pair.right)]);
      return;
    }
    if (node.op === 'project')
      walk(
        node.input,
        needed.map((key) => node.fields.get(key)),
      );
    else if (node.op === 'filter')
      walk(node.input, [...needed, ...node.pred.refs]);
    else if (node.op === 'order')
      walk(node.input, [...needed, ...node.by.map((order) => order.field)]);
    else if (node.op === 'group')
      walk(node.input, [
        ...node.by.values(),
        ...[...node.aggregates.values()]
          .map((value) => value.field)
          .filter(Boolean),
      ]);
    else walk(node.input, [...node.input.schema.keys()]);
  };
  walk(node, [...node.schema.keys()]);
  return [...context.sources].map(([alias, source]) => ({
    namespace: source.namespace,
    tableId: source.tableId,
    alias,
    schemaRevision: source.table.table.revision,
    schemaHash: hash(source.table.table.columns),
    columns: [...required.get(alias)].sort(),
    consistency: 'snapshot',
    access: context.plans
      .filter((plan) => plan.tableId === source.tableId)
      .map((plan) => ({
        index: plan.index,
        operator: plan.operator,
        keys: plan.keys || [],
        range: plan.range || null,
      })),
  }));
}
export function queryRelational(world, input) {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024)
      fail(413, 'Relational request exceeds 128 KiB');
    input = structuredClone(input);
  } catch (error) {
    if (error.status) throw error;
    fail(400, 'Relational requests must be serializable JSON');
  }
  shape(
    input,
    [
      'format',
      'relation',
      'offset',
      'limit',
      'count',
      'consistency',
      'cursor',
      'explain',
    ],
    ['format', 'relation'],
  );
  if (input.format !== RELATIONAL_FORMAT)
    fail(400, 'Unsupported relational query version');
  const limit = input.limit ?? 100,
    offset = input.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    (input.count !== undefined && typeof input.count !== 'boolean') ||
    (input.explain !== undefined && typeof input.explain !== 'boolean')
  )
    fail(400, 'Invalid relational page');
  if (input.consistency !== undefined) {
    shape(input.consistency, ['mode', 'version'], ['mode']);
    if (
      input.consistency.mode !== 'snapshot' ||
      (input.consistency.version !== undefined &&
        (!Number.isSafeInteger(input.consistency.version) ||
          input.consistency.version < 0))
    )
      fail(400, 'Only exact snapshot consistency is supported');
  }
  world.relationalStorage ||= new TableStorage(world);
  const storage = world.relationalStorage;
  storage.ensure();
  const version = world.version;
  if (
    input.consistency?.version !== undefined &&
    input.consistency.version !== version
  )
    fail(409, 'Relational snapshot changed; restart the query');
  const stats = {
      decodedRows: 0,
      indexBuildRows: 0,
      indexNodes: 0,
      aggregateBuildRows: 0,
      visitedRows: 0,
      returnedRows: 0,
      wireBytes: 0,
    },
    context = {
      storage,
      stats,
      nodes: 0,
      expressions: 0,
      sources: new Map(),
      aliases: new Set(),
      plans: [],
    };
  const compiled = compile(input.relation, context),
    queryHash = hash({
      relation: input.relation,
      backend: backendHash,
      collation: collationProfile(),
      count: input.count !== false,
      schemas: [...context.sources.values()].map((source) => ({
        namespace: source.namespace,
        tableId: source.tableId,
        columns: source.table.table.columns,
      })),
    }),
    count = input.count !== false;
  let start = offset;
  if (input.cursor !== undefined) {
    if (
      typeof input.cursor !== 'string' ||
      input.cursor.length > 2048 ||
      offset !== 0
    )
      fail(400, 'Invalid relational cursor');
    let cursor;
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
    } catch {
      fail(400, 'Invalid relational cursor');
    }
    shape(
      cursor,
      ['query', 'version', 'offset'],
      ['query', 'version', 'offset'],
    );
    if (cursor.query !== queryHash || cursor.version !== version)
      fail(409, 'Relational cursor snapshot or query changed');
    if (
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > 1000000
    )
      fail(400, 'Invalid relational cursor offset');
    start = cursor.offset;
  }
  dependencies(compiled, context);
  const uniqueSources = new Map();
  let sourceRows = 0,
    sourceBytes = 0;
  for (const source of context.sources.values()) {
    const key = source.namespace + ':' + source.tableId;
    if (uniqueSources.has(key)) continue;
    const footprint = storage.footprint(source.namespace, source.tableId);
    sourceRows += footprint.rows;
    sourceBytes += footprint.bytes;
    uniqueSources.set(key, null);
  }
  if (
    sourceRows > storage.limits.cacheRows ||
    sourceBytes > storage.limits.cacheBytes
  )
    fail(413, 'Relational source set exceeds the in-memory read budget');
  for (const source of context.sources.values()) {
    const key = source.namespace + ':' + source.tableId;
    let table = uniqueSources.get(key);
    if (!table) {
      table = storage.table(source.namespace, source.tableId, stats);
      uniqueSources.set(key, table);
    }
    source.table = table;
  }
  const path = simple(compiled),
    selected = path ? access(path, context) : null;
  let rows = [],
    total = null,
    hasMore = false;
  if (selected && (selected.ordered || !selected.by) && selected.exact) {
    total = count ? selected.count : null;
    let seen = 0;
    for (const row of selected.rows(start, limit + 1)) {
      tick(context);
      if (seen++ === limit) {
        hasMore = true;
        break;
      }
      const value = selected.transform(row);
      if (!value) fail(500, 'Relational exact access invariant failed');
      rows.push(value);
    }
    hasMore = hasMore || start + rows.length < selected.count;
  } else {
    const iterator = selected
      ? executeSimple(selected, context)
      : execute(compiled, context);
    let matched = 0;
    for (const row of iterator) {
      if (matched >= start && rows.length < limit) rows.push(row);
      matched++;
      if (!count && matched > start + limit) {
        hasMore = true;
        break;
      }
    }
    if (count) {
      total = matched;
      hasMore = start + rows.length < total;
    }
  }
  rows = structuredClone(rows);
  stats.returnedRows = rows.length;
  const nextOffset = hasMore ? start + rows.length : null,
    nextCursor =
      nextOffset === null
        ? null
        : Buffer.from(
            JSON.stringify({ query: queryHash, version, offset: nextOffset }),
          ).toString('base64url');
  const result = {
    format: RELATIONAL_FORMAT,
    rows,
    total,
    offset: start,
    limit,
    nextOffset,
    nextCursor,
    version,
    schema: [...compiled.schema].map(([key, type]) => ({ key, ...type })),
    tables: [...context.sources.values()].map((source) =>
      structuredClone(source.table.table),
    ),
    dependencies: dependencies(compiled, context),
  };
  if (input.explain)
    result.plan = {
      version: 1,
      backend: 'world-memory-v1',
      backendHash,
      queryHash,
      operators: context.plans,
      stats,
      capabilities: {
        placement: 'host',
        wire: 'json-rows-v1',
        collation: collationProfile(),
        indexes: 'rebuildable',
        proof: 'trusted-adapter-semantics',
      },
    };
  for (let pass = 0; pass < 4; pass++) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes === stats.wireBytes) break;
    stats.wireBytes = bytes;
  }
  if (stats.wireBytes > 8 * 1024 * 1024)
    fail(413, 'Relational page exceeds 8 MiB; request fewer rows or columns');
  return result;
}
