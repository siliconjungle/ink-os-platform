// Cross-app read plans: how a consumer's typed data port reads another app.
//
// A plan narrows an exported `UiData<Row>` query with consumer functions. Its
// meaning is fixed by this definition, whatever executes it:
//
//   data   = provider.entry(input)
//   kept   = where ? data.rows.filter(where) : data.rows
//   total  = aggregate ? Some(op over kept, `value` per row; min/max of none is None)
//          : where ? Some(kept.length) : data.total
//   rows   = kept.drop(offset).take(limit)
//   result = UiData { rows, total, version: data.version }
//
// `where` and `value` must be pure consumer functions over the exact row type.
// A plan without other fields still moves the read onto a read-only copy.
export const LINK_PLAN_VERSION = 1;
export const LINK_AGGREGATES = ['count', 'sum', 'min', 'max'];
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
const symbol = (value) =>
  typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value) && !value.startsWith('__');
const plain = (value, allowed) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
const count = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Validate and normalize a plan; returns a new plain object. */
export function inkLinkPlan(plan) {
  if (!plain(plan, ['version', 'where', 'offset', 'limit', 'aggregate']) || plan.version !== LINK_PLAN_VERSION)
    fail('A link plan is a version 1 object with where, offset, limit and aggregate');
  if (plan.where !== undefined && !symbol(plan.where)) fail('Link plan where names a consumer function');
  if (plan.offset !== undefined && !count(plan.offset, 0, 1_000_000)) fail('Link plan offset is 0–1000000');
  if (plan.limit !== undefined && !count(plan.limit, 1, 1000)) fail('Link plan limit is 1–1000');
  let aggregate;
  if (plan.aggregate !== undefined) {
    const a = plan.aggregate;
    if (!plain(a, ['op', 'value']) || !LINK_AGGREGATES.includes(a.op) || (a.op === 'count') !== (a.value === undefined) || (a.value !== undefined && !symbol(a.value)))
      fail('Link aggregates are count, or sum/min/max of a consumer value function');
    aggregate = a.op === 'count' ? { op: 'count' } : { op: a.op, value: a.value };
  }
  return {
    version: LINK_PLAN_VERSION,
    ...(plan.where !== undefined ? { where: plan.where } : {}),
    ...(plan.offset !== undefined ? { offset: plan.offset } : {}),
    ...(plan.limit !== undefined ? { limit: plan.limit } : {}),
    ...(aggregate ? { aggregate } : {}),
  };
}

/** Consumer functions a plan runs, with the result type each must return. */
export function linkPlanFunctions(plan) {
  return [
    ...(plan.where ? [{ name: plan.where, role: 'where', result: 'bool' }] : []),
    ...(plan.aggregate?.value ? [{ name: plan.aggregate.value, role: 'value', result: 'u64' }] : []),
  ];
}
