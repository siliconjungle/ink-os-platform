/** Serializable relational requests. Field references are schema-checked by storage. */
export const RELATIONAL_FORMAT = 'ink-relational-v1';
export const relational = Object.freeze({
  scan: (namespace, tableId, as = 'row') => ({
    op: 'scan',
    namespace,
    tableId,
    as,
  }),
  filter: (input, predicate) => ({ op: 'filter', input, predicate }),
  project: (input, fields) => ({ op: 'project', input, fields }),
  join: (left, right, on, kind = 'inner') => ({
    op: 'join',
    left,
    right,
    on,
    kind,
  }),
  group: (input, by, aggregates) => ({ op: 'group', input, by, aggregates }),
  order: (input, by) => ({ op: 'order', input, by }),
  distinct: (input) => ({ op: 'distinct', input }),
  query: (relation, options = {}) => ({
    format: RELATIONAL_FORMAT,
    relation,
    ...options,
  }),
});
export const column = (field) => ({ column: field });
export const literal = (value) => ({ literal: value });
export const compare = (op, field, value) => ({
  op,
  left: column(field),
  right: literal(value),
});

/** Translate the existing Tables API without fetching rows or knowing their schema. */
export function tableQuery(namespace, tableId, query = {}) {
  const allowed = new Set([
    'where',
    'orderBy',
    'select',
    'offset',
    'limit',
    'count',
    'consistency',
    'cursor',
    'explain',
  ]);
  if (
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    Object.keys(query).some((key) => !allowed.has(key))
  )
    throw Error('Unknown table query option');
  if (
    query.where !== undefined &&
    (!query.where ||
      typeof query.where !== 'object' ||
      Array.isArray(query.where))
  )
    throw Error('where must be an object');
  let relation = relational.scan(namespace, tableId);
  const predicates = [];
  for (const [field, test] of Object.entries(query.where || {})) {
    if (test && typeof test === 'object' && !Array.isArray(test)) {
      if (!Object.keys(test).length)
        throw Error('Use an explicit comparison operator');
      for (const [op, value] of Object.entries(test))
        predicates.push(compare(op, 'row.' + field, value));
    } else predicates.push(compare('eq', 'row.' + field, test));
  }
  if (predicates.length)
    relation = relational.filter(relation, { op: 'and', args: predicates });
  const order = query.orderBy;
  if (
    order !== undefined &&
    (!order ||
      typeof order !== 'object' ||
      Array.isArray(order) ||
      typeof order.field !== 'string' ||
      !order.field ||
      Object.keys(order).some((key) => !['field', 'direction'].includes(key)) ||
      !['asc', 'desc', undefined].includes(order.direction))
  )
    throw Error('Invalid table order');
  relation = relational.order(relation, [
    {
      field: 'row.' + (order?.field || '$key'),
      direction: order?.direction || 'asc',
      collation: order ? 'natural' : 'key',
    },
  ]);
  if (query.select !== undefined) {
    if (
      !Array.isArray(query.select) ||
      !query.select.length ||
      query.select.some((field) => typeof field !== 'string')
    )
      throw Error('select must contain column names');
    relation = relational.project(
      relation,
      Object.fromEntries(
        [...new Set([...query.select, '$id', '$key', '$revision'])].map(
          (field) => [field, 'row.' + field],
        ),
      ),
    );
  } else relation = relational.project(relation, { '*': 'row' });
  const { where, orderBy, select, ...options } = query;
  return relational.query(relation, {
    limit: 500,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  });
}
