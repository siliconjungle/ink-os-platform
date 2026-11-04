# Typed queries through the Tables storage boundary

The SDK Tables reader now sends a serializable `ink-relational-v1` query through
`world.query` / `data.query`. Storage validates column types and executes the
complete query before returning a page. A point lookup uses a key lookup rather
than fetching the table through the legacy object query. Existing application
bundles need the updated SDK to use this path.

## Tables API

```js
import { createTableReader } from '@ink-os/platform/tables';

const orders = createTableReader(client, { namespace: appId, tableId });
const dashboard = await orders.query({
  where: { status: 'open', amount: { gte: 100 } },
  orderBy: { field: 'amount', direction: 'desc' },
  select: ['customer', 'amount'],
  limit: 20,
  explain: true,
});
// dashboard.rows: requested columns plus $id, $key, $revision
// dashboard.total: exact count before offset/limit, at the same World version
// dashboard.plan: selected access, dependency ranges, setup and execution work

const order = await orders.get('customer-order-42');
for await (const row of orders.iterate({ select: ['customer'], limit: 100 })) {
  consume(row);
}
```

`query`, `get`, and `watch` retain their existing entry points. `select` is new.
`pages()` yields bounded pages; `iterate()` yields rows with `count:false` so an
eligible query can stop after its page/lookahead. `limit` defaults to 500 and is
bounded to 1–500 **per page**, rather than limiting the whole table to 500 rows.
The old standalone `decodeTable` / `selectTable` helpers and `MAX_TABLE_ROWS`
remain for compatibility with explicitly materialized legacy results;
`MAX_TABLE_PAGE_SIZE` names the new page bound.

Predicates support equality, inequality, numeric/text ranges, `in` (up to 100
values), and case-insensitive text `contains`. The shorthand object used by
Tables is an AND; JSON equality uses `{eq: jsonValue}`. Unknown columns,
operators, malformed orders, and incompatible operand types are rejected. Fields
retain the existing text, finite binary64 number, safe integer, boolean, JSON,
nullable/default contracts. This format does not add Ink `u64`/`Int` carriers.

The response contains typed `schema`, source `tables`, and `dependencies` with
namespace, alias, table ID, schema revision/hash, required columns, and selected
key/range access. Rows contain values rather than opaque World record bodies.
Projection keeps unused fields out of execution intermediates and the wire.
A newly opened table must still parse/validate its JSON row bodies once; the
current on-disk record representation is unchanged.

## Relational representation

The public constructors and TypeScript declarations are exported at
`@ink-os/platform/relations`:

```js
import { relational as r, compare } from '@ink-os/platform/relations';

const openOrders = r.filter(
  r.scan(appId, tableId, 'sale'),
  compare('eq', 'sale.status', 'open'),
);
const totals = r.group(openOrders, { customer: 'sale.customer' }, {
  orders: { op: 'count' },
  amount: { op: 'sum', field: 'sale.amount' },
});
const request = r.query(r.order(totals, [
  { field: 'amount', direction: 'desc' },
]), { limit: 20, explain: true });
const result = await client.data.query(request);
```

Version 1 retains scans with explicit source aliases; filter expressions with
AND/OR/NOT; field projections; inner, left, and anti equijoins with multiple typed
keys; grouping with count/sum/average/min/max; distinct; multi-column ordering;
offset/limit; and snapshot/chunk requirements. Every operator is schema-checked
before decoding source rows or planning execution. Self-joins require distinct
aliases. Other joins, windows, computed projection expressions, external-source
adapters, and other versions are rejected rather than silently approximated.

Equality is null-safe and follows the JSON value encoding, including object key
order. Null join keys do not match; a left join makes unmatched right columns
nullable. Ranges exclude nulls. `count(field)` skips nulls; `count` without a field
counts rows. An empty global aggregate yields count 0 and null sum/average/min/max;
an empty grouped aggregate has no groups. Group and join results without an
explicit order have no promised row order. Callers should include a unique key
in multi-column orders when ties matter.

Binary order uses UTF-16 code units. `natural` and `key` use explicit English ICU
collations (natural additionally enables numeric comparison). Tables uses key
order by default and natural order for an explicitly ordered column, with key/ID
tie breakers. A future backend must implement the same declared collation or
decline that capability. The ICU version and resolved collation options are
bound into the query/cursor identity and reported by `explain`.

Sums accumulate the exact binary64 input values and round once, ties to even;
averages divide the exact total before rounding. Thus index selection and
incremental delete/reinsert cannot change the answer through floating-point
reassociation. Non-finite final sums are explicit 422 errors. This is the new
relational aggregate's semantics; it is **not** permission to rewrite an existing
Ink ordered floating-point fold into this operator without a checked equivalence.

## Storage implementation and planning

`TableStorage` is a rebuildable in-memory adapter over authoritative World
records. Its catalogue is initialized once from World; tables decode lazily. It
maintains key maps, order-statistics indexes, and selected grouped aggregates
from committed World action records, after durable append. Ordinary row writes,
archives, moves, deletes, and replay keep it coherent. A schema/image change
invalidates derived state. A cache maintenance failure discards the adapter;
it cannot reject a World commit or become a second durable store. Restart,
namespace copies, migration, and backups continue to use the original records.

The physical planner chooses key lookup, ordered/equality-prefix/range access,
sequential scans, or selective range access plus a bounded sort. Cardinalities
from maintained index sizes let a dashboard return a page **and exact count**
without visiting every matching row. At most two additional range alternatives
are considered. Required columns propagate backwards through the operator tree.
Scans/projections/filters produce iterators; joins build a bounded hash table;
general grouping uses bounded group state. Count/sum/average over eligible single
source pipelines have maintained grouped views; min/max and general joins/grouping
retain explicit hash/sort implementations. Aggregate views are bounded and
updated only by committed changes.

`explain:true` reports the backend, typed-query hash (including schemas), selected
operators, candidate cardinalities, and work counters: cold row decoding, index
and aggregate setup, index nodes, row visits across operators, returned rows,
and complete response bytes. Range alternative costs are heuristics, not timing
proofs. Index/aggregate construction and write amplification remain costs, even
when a hot read visits only its page.

This is a trusted JavaScript storage adapter behind a typed relational boundary.
It does not modify Ink's kernel or claim its indexes/aggregates have Ink equality
certificates. It does not run implementation discovery on each query. The current
placement is the host and the wire format is JSON rows; remote execution,
columnar/native wire formats, and an Ink-authored storage backend remain future
adapters. Those integrations must bind this schema/observation/consistency
contract and preserve the existing implementation planner's proof and comparable
cost-evidence gates.

## Snapshots, watching, and bounds

Each request executes synchronously against one World version. An optional
`consistency:{mode:'snapshot',version}` requires that exact version. Cursors bind
the typed query, schemas, backend implementation hash, collations, and version.
Source scans and group enumeration use canonical internal order so cache eviction
or a restart cannot silently change an unordered cursor's enumeration. A changed snapshot or query returns 409;
clients must restart rather than combine pages from different versions. This is
a stateless cursor, not retained historical MVCC: even an unrelated World commit
invalidates it. Breaking iteration stops further requests. Complex plans can
repeat work between pages; eligible ordered pages seek by rank without
materializing the whole result.

SDK live queries accept relational responses and invalidate conservatively on
changes in every source namespace, including updates outside the returned page
and rows leaving a predicate. They do not yet use the carried key/range metadata
to narrow notifications. The existing `world:read` scope and browser
`world.read` capability apply; the relational request grants no new authority.

Default in-memory limits are 100,000 source rows and 64 MiB of UTF-16 body
carrier bytes per table; eight decoded tables, 200,000 source rows, and 128 MiB of
body carriers in the cache and any one query's distinct source set; table schema
JSON is bounded to 512 Ki code units. There are four ordered indexes and two aggregate views per
table; 64 operators, 256 predicate-expression nodes, 100,000 materialized
intermediate/group/join rows, 500,000 row visits, a 128 KiB request, and an 8 MiB
response. Cache limits describe retained data carriers, not total process memory.
Exceeding a budget returns 413, never a partial successful result. Invalid stored
table data returns 422 and can be repaired through normal World writes.

## Validation and measurements

`tests/relational-query.test.mjs` covers a 1,200-row dashboard, warm point lookup,
selective range planning, independent comparisons with the legacy reader,
randomized bounds/mutations, joins/aggregates, maintained views, schema changes,
restart/deletion, actual HTTP/SDK authorization, live watches, ownership of
returned values, cache failure, read budgets, snapshots, and pre-sync visibility.
The CLI browser SDK is rebuilt from the source SDK by `npm run build:sdk` (also
part of `npm run build`). Its public bridge test watches typed rows and preserves
the selection/preview APIs. Numeric tests cover cancellation, ties, subnormals,
overflow, incremental changes, and 1,000 held-out IEEE bit-pattern pairs.

Run `node scripts/benchmark-relational.mjs` for a matched HTTP/SDK comparison on a
400-row table that the legacy reader supports. Both paths consume and verify the
same twenty complete rows plus count; trials alternate order. Synthetic source
construction is reported separately, and the first typed HTTP read includes cold
setup. [The recorded local result](benchmarks/typed-storage-2026-11-04.json) on
Node 24 / Apple M4 Pro measured median 4.67 ms legacy versus 0.68 ms typed, with
637,707 versus 24,638 response bytes. Explicit column projection used 4,319 bytes.
The cold typed request took about 40.7 ms; these are local workload measurements,
not a general performance guarantee. The 1,200-row correctness test additionally
checks twenty-one visits for a twenty-row indexed page with an exact count,
zero warm row decodes, and zero warm index rebuilds. Cursor tests also cover
view eviction and restart without an intervening World write.

## Build-time data-path control

Opt-in Ink app releases can now bind declared typed UI queries to measured scan, fixed-index or maintained-result recipes, with replay checks and guarded scan fallback. See [data-path planning](data-path-planning.md) for the manifest, trusted-adapter proof boundary, measurements and remaining limits.
