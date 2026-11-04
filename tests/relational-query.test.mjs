import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { World, hash } from '../server/world.mjs';
import { queryWorld } from '../server/query.mjs';
import { platformRouter } from '../server/platform-router.mjs';
import { createClient } from '../sdk/src/server.js';
import {
  createTableReader,
  decodeTable,
  selectTable,
} from '../sdk/src/tables.js';
import { relational as r, compare, tableQuery } from '../sdk/src/relations.js';
import { queryInvalidator } from '../sdk/src/live-query.js';

const namespace = 'a'.repeat(32),
  tableId = 'b'.repeat(32),
  otherId = 'c'.repeat(32);
const columns = [
  { key: 'title', type: 'text' },
  { key: 'score', type: 'integer' },
  { key: 'status', type: 'text' },
  { key: 'team', type: 'text', nullable: true },
  { key: 'payload', type: 'json', default: null, nullable: true },
];
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-relations-'));
  const world = await new World(directory).open();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const define = (id, cols = columns) =>
    world.create({
      id,
      namespace,
      kind: 'ink-table',
      title: 'Fixture',
      tags: ['ink-table:' + id],
      body: JSON.stringify({ format: 'ink-table', version: 1, columns: cols }),
    });
  const put = (key, values, id = tableId) =>
    world.create({
      id: hash(id + ':' + key).slice(0, 32),
      namespace,
      kind: 'ink-table-row',
      tags: ['ink-table:' + id],
      body: JSON.stringify({
        format: 'ink-table-row',
        version: 1,
        tableId: id,
        key,
        values,
      }),
    });
  const update = async (key, values, id = tableId) => {
    const row = world.get(hash(id + ':' + key).slice(0, 32)),
      body = JSON.parse(row.body);
    return world.update(row.id, {
      body: JSON.stringify({ ...body, values: { ...body.values, ...values } }),
    });
  };
  const client = {
    world: {
      query: (input) => Promise.resolve(queryWorld(world, input)),
      watch() {},
    },
  };
  return {
    world,
    directory,
    define,
    put,
    update,
    reader: createTableReader(client, { namespace, tableId }),
    query: (options) =>
      queryWorld(world, tableQuery(namespace, tableId, options)),
  };
}
const row = (i) => ({
  title: 'Item ' + i,
  score: i % 100,
  status: i % 2 ? 'open' : 'closed',
  team: i % 5 === 0 ? null : 'team' + (i % 3),
  payload: { large: 'x'.repeat(100) },
});

test('dashboard pages and counts push down across thousands of rows; hot reads avoid decoding and scanning', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  for (let i = 0; i < 1200; i++)
    await f.put('row-' + String(i).padStart(4, '0'), row(i));
  const request = {
    where: { status: 'open' },
    orderBy: { field: 'score', direction: 'desc' },
    select: ['title', 'score'],
    limit: 20,
    explain: true,
  };
  const cold = f.query(request);
  assert.equal(cold.total, 600);
  assert.equal(cold.rows.length, 20);
  assert.equal(cold.plan.stats.decodedRows, 1200);
  assert.equal(cold.plan.stats.visitedRows, 21);
  assert.ok(cold.rows.every((row) => !Object.hasOwn(row, 'payload')));
  const hot = f.query(request);
  assert.deepEqual(hot.rows, cold.rows);
  assert.equal(hot.plan.stats.decodedRows, 0);
  assert.equal(hot.plan.stats.indexBuildRows, 0);
  assert.equal(hot.plan.stats.visitedRows, 21);
  assert.deepEqual(hot.plan.operators[0].index, ['status', 'score']);
  assert.equal(hot.plan.operators[0].exactCount, true);
  assert.ok(JSON.stringify(hot).length < 10000);
  const selective = f.query({
    where: { score: { gte: 99 } },
    orderBy: { field: 'title', direction: 'desc' },
    limit: 20,
    explain: true,
  });
  assert.equal(selective.total, 12);
  assert.ok(
    selective.plan.operators.some((operator) => operator.operator === 'sort'),
  );
  assert.ok(selective.plan.stats.visitedRows < 100);
  assert.deepEqual(selective.plan.operators[0].index, ['score']);
  const point = f.query({
    where: { $key: 'row-0901' },
    limit: 1,
    explain: true,
  });
  assert.equal(point.rows[0].score, 1);
  assert.equal(point.plan.operators[0].operator, 'key-lookup');
  assert.equal(point.plan.stats.visitedRows, 1);
  assert.deepEqual(point.dependencies[0].access[0].keys, ['row-0901']);
  assert.equal((await f.reader.get('row-0901')).title, 'Item 901');
  assert.equal(await f.reader.get('missing'), null);
  await f.update('row-0901', { score: 999, status: 'closed' });
  const changed = f.query(request);
  assert.equal(changed.total, 599);
  assert.equal(changed.plan.stats.indexBuildRows, 0);
  assert.equal((await f.reader.get('row-0901')).score, 999);
});

test('typed predicates, projections, nulls, ordering and ranges match the independent legacy table reader', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  for (let i = 0; i < 45; i++)
    await f.put('row-' + String(i).padStart(3, '0'), row(i));
  const legacy = decodeTable(
    queryWorld(f.world, {
      namespace,
      tag: 'ink-table:' + tableId,
      limit: 1000,
    }),
    tableId,
  );
  const cases = [
    {},
    { where: { status: 'open' } },
    {
      where: { score: { gte: 4, lt: 21 } },
      orderBy: { field: 'score', direction: 'desc' },
      limit: 4,
      offset: 3,
    },
    { where: { team: null }, orderBy: { field: 'team', direction: 'desc' } },
    { where: { title: { contains: 'EM 1' } } },
    { where: { score: { in: [1, 5, 9] } } },
    { where: { status: { ne: 'open' } } },
    { where: { payload: { eq: { large: 'x'.repeat(100) } } } },
    { where: { score: { eq: 9, gte: 4 } }, orderBy: { field: 'score' } },
    { where: { score: { eq: 9, gt: 20 } } },
    { where: { score: { gt: 30, lte: 10 } } },
    { orderBy: { field: 'title', direction: 'desc' } },
    {
      where: { team: 'team1' },
      orderBy: { field: 'score', direction: 'desc' },
    },
  ];
  for (const query of cases) {
    const expected = selectTable(legacy, query),
      actual = f.query(query);
    assert.deepEqual(actual.rows, expected.rows, JSON.stringify(query));
    assert.equal(actual.total, expected.total);
  }
  const filtered = r.filter(r.scan(namespace, tableId, 'x'), {
    op: 'or',
    args: [
      compare('eq', 'x.score', 2),
      { op: 'not', arg: compare('ne', 'x.score', 4) },
    ],
  });
  const projected = r.project(filtered, { name: 'x.title', rank: 'x.score' }),
    ordered = r.order(projected, [
      { field: 'rank', direction: 'desc' },
      { field: 'name' },
    ]);
  const result = queryWorld(f.world, r.query(ordered));
  assert.deepEqual(result.rows, [
    { name: 'Item 4', rank: 4 },
    { name: 'Item 2', rank: 2 },
  ]);
  // Stable enumeration and order ties also depend on the source identity.
  assert.deepEqual(result.dependencies[0].columns, ['$id', '$key', 'score', 'title']);
  for (const request of [
    tableQuery(namespace, tableId, { where: { unknown: 1 } }),
    tableQuery(namespace, tableId, { where: { score: 'bad' } }),
    tableQuery(namespace, tableId, { orderBy: { field: 'payload' } }),
    { ...tableQuery(namespace, tableId), limit: 501 },
    { ...tableQuery(namespace, tableId), consistency: { mode: 'eventual' } },
    r.query(
      r.join(r.scan(namespace, tableId, 'x'), r.scan(namespace, tableId, 'x'), [
        { left: 'x.score', right: 'x.score' },
      ]),
    ),
  ])
    assert.throws(
      () => queryWorld(f.world, request),
      (error) => error.status === 400,
    );
});

test('joins, grouping and general aggregates remain typed through storage', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  await f.define(otherId, [
    { key: 'team', type: 'text' },
    { key: 'label', type: 'text' },
  ]);
  await f.put('a', { ...row(1), team: 'one', score: 2 });
  await f.put('b', { ...row(2), team: 'one', score: 4 });
  await f.put('c', { ...row(3), team: null, score: 9 });
  await f.put('d', { ...row(4), team: 'absent', score: 3 });
  await f.put('one', { team: 'one', label: 'First' }, otherId);
  await f.put('two', { team: 'two', label: 'Second' }, otherId);
  const left = r.scan(namespace, tableId, 'a'),
    right = r.scan(namespace, otherId, 'b'),
    on = [{ left: 'a.team', right: 'b.team' }];
  const joined = r.join(left, right, on, 'left'),
    group = r.group(
      joined,
      { label: 'b.label' },
      {
        count: { op: 'count' },
        sum: { op: 'sum', field: 'a.score' },
        avg: { op: 'avg', field: 'a.score' },
        min: { op: 'min', field: 'a.score' },
        max: { op: 'max', field: 'a.score' },
      },
    );
  const result = queryWorld(
    f.world,
    r.query(r.order(group, [{ field: 'label' }])),
  );
  assert.deepEqual(result.rows, [
    { label: 'First', count: 2, sum: 6, avg: 3, min: 2, max: 4 },
    { label: null, count: 2, sum: 12, avg: 6, min: 3, max: 9 },
  ]);
  assert.equal(result.dependencies.length, 2);
  assert.ok(result.plan === undefined);
  const anti = queryWorld(
    f.world,
    r.query(r.project(r.join(left, right, on, 'anti'), { key: 'a.$key' })),
  );
  assert.deepEqual(anti.rows.map((row) => row.key).sort(), ['c', 'd']);
  const inner = queryWorld(
    f.world,
    r.query(
      r.project(r.join(left, right, on), { key: 'a.$key', label: 'b.label' }),
    ),
  );
  assert.equal(inner.total, 2);
  const empty = r.filter(
    r.scan(namespace, tableId, 'e'),
    compare('eq', 'e.score', 1000),
  );
  const global = r.group(
    empty,
    {},
    { count: { op: 'count' }, sum: { op: 'sum', field: 'e.score' } },
  );
  assert.deepEqual(queryWorld(f.world, r.query(global)).rows, [
    { count: 0, sum: null },
  ]);
});

test('maintained grouped counts update from committed changes, deletion, schema replacement and restart', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  for (let i = 0; i < 30; i++) await f.put('r' + i, row(i));
  const relation = r.group(
      r.filter(r.scan(namespace, tableId, 'x'), compare('gte', 'x.score', 5)),
      { status: 'x.status' },
      { count: { op: 'count' }, teams: { op: 'count', field: 'x.team' } },
    ),
    request = r.query(r.order(relation, [{ field: 'status' }]), {
      explain: true,
    });
  let result = queryWorld(f.world, request);
  assert.equal(result.plan.stats.aggregateBuildRows, 30);
  assert.ok(
    result.plan.operators.some((op) => op.operator === 'maintained-counts'),
  );
  result = queryWorld(f.world, request);
  assert.equal(result.plan.stats.aggregateBuildRows, 0);
  assert.equal(result.plan.stats.visitedRows, 2);
  await f.update('r1', { score: 99, status: 'open' });
  let expected = queryWorld(
    f.world,
    r.query(
      r.group(
        r.filter(r.scan(namespace, tableId, 'x'), compare('gte', 'x.score', 5)),
        { status: 'x.status' },
        {
          count: { op: 'count' },
          teams: { op: 'count', field: 'x.team' },
          forceScan: { op: 'min', field: 'x.score' },
        },
      ),
    ),
  ).rows;
  result = queryWorld(f.world, request);
  for (const item of result.rows) {
    const reference = expected.find((value) => value.status === item.status);
    assert.equal(item.count, reference.count);
    assert.equal(item.teams, reference.teams);
  }
  assert.equal(result.plan.stats.aggregateBuildRows, 0);
  await f.world.erase([hash(tableId + ':r1').slice(0, 32)]);
  assert.equal(
    queryWorld(f.world, request).rows.find((row) => row.status === 'open')
      .count,
    result.rows.find((row) => row.status === 'open').count - 1,
  );
  const reopened = await new World(f.directory).open();
  assert.deepEqual(
    queryWorld(reopened, request).rows,
    queryWorld(f.world, request).rows,
  );
  const definition = f.world.get(tableId),
    body = JSON.parse(definition.body);
  await f.world.update(tableId, {
    body: JSON.stringify({
      ...body,
      columns: [
        ...body.columns,
        { key: 'new', type: 'text', default: 'default' },
      ],
    }),
  });
  assert.ok(f.query({ limit: 1 }).rows[0].new === 'default');
});

test('chunked consumption binds snapshot and query; unrelated writes cannot silently mix pages', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  for (let i = 0; i < 31; i++)
    await f.put('r' + String(i).padStart(3, '0'), row(i));
  const found = [];
  for await (const item of f.reader.iterate({ limit: 7, select: ['title'] }))
    found.push(item);
  assert.equal(found.length, 31);
  assert.equal(new Set(found.map((row) => row.$key)).size, 31);
  const first = f.query({ limit: 7, count: false, explain: true });
  assert.equal(first.total, null);
  assert.equal(first.plan.stats.visitedRows, 8);
  const second = f.query({ limit: 7, count: false, cursor: first.nextCursor });
  assert.equal(second.offset, 7);
  assert.throws(
    () => f.query({ limit: 7, count: true, cursor: first.nextCursor }),
    (error) => error.status === 409,
  );
  await f.world.create({
    namespace: 'os',
    kind: 'note',
    title: 'Another transaction',
  });
  assert.throws(
    () => f.query({ limit: 7, count: false, cursor: first.nextCursor }),
    (error) => error.status === 409,
  );
  assert.throws(
    () =>
      f.query({ consistency: { mode: 'snapshot', version: first.version } }),
    (error) => error.status === 409,
  );
});

test('SDK HTTP and live-query transport carry relational requests with normal read authorization', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  await f.put('r1', row(1));
  const requests = [];
  const send = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const router = platformRouter(
    { world: f.world },
    {
      send,
      body: async (request) => {
        const parts = [];
        for await (const part of request) parts.push(part);
        const value = JSON.parse(Buffer.concat(parts).toString());
        requests.push(value);
        return value;
      },
    },
  );
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const principal = {
        owner: true,
        keyId: 'fixture',
        namespace: 'os',
        scopes:
          req.headers.authorization === 'Bearer read'
            ? ['world:read']
            : ['apps:read'],
      };
      await router(req, res, url, principal);
    } catch (error) {
      send(res, error.status || 500, { error: error.message });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port,
    client = createClient({ url, token: 'read' }),
    reader = createTableReader(client, { namespace, tableId });
  assert.equal((await reader.get('r1')).title, 'Item 1');
  assert.equal(requests[0].format, 'ink-relational-v1');
  assert.equal(requests[0].relation.input.op, 'order');
  assert.equal(requests[0].relation.input.input.op, 'filter');
  await assert.rejects(
    createClient({ url, token: 'denied' }).data.query(
      tableQuery(namespace, tableId),
    ),
    { status: 403 },
  );
  const request = tableQuery(namespace, tableId, { where: { score: 99 } }),
    filter = queryInvalidator(request);
  filter.accept(f.query({ where: { score: 99 } }));
  assert.equal(
    filter.relevant({
      type: 'object',
      object: { namespace, kind: 'note' },
      quiet: true,
    }),
    true,
  );
  assert.equal(
    filter.relevant({ type: 'object', object: { namespace: 'd'.repeat(32) } }),
    false,
  );
  assert.equal(filter.relevant({ type: 'deleted', ids: ['anything'] }), true);
});

test('invalid stored rows fail closed without breaking World commits and recover after repair', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  await f.put('good', row(1));
  f.query({});
  await f.update('good', { score: 'invalid' });
  assert.throws(
    () => f.query({ where: { $key: 'good' } }),
    (error) => error.status === 422,
  );
  assert.ok(f.world.get(hash(tableId + ':good').slice(0, 32)));
  await f.update('good', { score: 7 });
  assert.equal(f.query({}).rows[0].score, 7);
  const result = f.query({ select: ['payload'] });
  result.rows[0].payload.large = 'mutated';
  assert.equal(
    f.query({ select: ['payload'] }).rows[0].payload.large,
    'x'.repeat(100),
  );
});

test('adversarial equality/range bounds and index mutations agree with full reference evaluation', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  let seed = 0x453ab2;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let i = 0; i < 80; i++)
    await f.put('key' + String(i).padStart(3, '0'), {
      ...row(i),
      score: random(50) - 10,
      team: random(4) === 0 ? null : 'team' + random(3),
      payload: random(2) ? 1 : '1',
    });
  for (let round = 0; round < 100; round++) {
    if (round % 10 === 0)
      await f.update('key' + String(random(80)).padStart(3, '0'), {
        score: random(50) - 10,
        status: random(2) ? 'open' : 'closed',
      });
    const orderBy = {
        field: ['score', 'team', '$key'][random(3)],
        direction: random(2) ? 'asc' : 'desc',
      },
      value = random(50) - 10;
    const where = [
        { score: { gte: value, lt: value + random(12) } },
        { score: { gt: value, lte: value + random(12) } },
        { score: { eq: value, gte: value - 1 } },
        { status: 'open', score: { gt: value } },
        { team: random(2) ? null : 'team1' },
        { payload: { eq: random(2) ? 1 : '1' } },
      ][random(6)],
      query = { where, orderBy, offset: random(5), limit: 1 + random(10) };
    const reference = selectTable(
        decodeTable(
          queryWorld(f.world, {
            namespace,
            tag: 'ink-table:' + tableId,
            limit: 1000,
          }),
          tableId,
        ),
        query,
      ),
      actual = f.query(query);
    assert.deepEqual(actual.rows, reference.rows, JSON.stringify(query));
    assert.equal(actual.total, reference.total, JSON.stringify(query));
  }
});

test('read-side caches cannot decide World commits and external callers cannot mutate cached schemas or views', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  await f.put('r1', row(1));
  f.query({});
  f.world.relationalStorage.apply = () => {
    throw Error('Derived index failure');
  };
  await f.update('r1', { score: 7 });
  assert.equal(f.query({}).rows[0].score, 7);
  const result = f.query({});
  result.tables[0].columns[0].type = 'boolean';
  assert.equal(f.query({}).rows[0].title, 'Item 1');
  const values = ['open'],
    predicate = {
      op: 'in',
      left: { column: 'r.status' },
      right: { literal: values },
    },
    request = r.query(
      r.group(
        r.filter(r.scan(namespace, tableId, 'r'), predicate),
        { status: 'r.status' },
        { count: { op: 'count' } },
      ),
    );
  assert.equal(queryWorld(f.world, request).rows[0].count, 1);
  values[0] = 'closed';
  await f.put('r3', row(3));
  const original = r.query(
    r.group(
      r.filter(r.scan(namespace, tableId, 'r'), {
        op: 'in',
        left: { column: 'r.status' },
        right: { literal: ['open'] },
      }),
      { status: 'r.status' },
      { count: { op: 'count' } },
    ),
  );
  assert.equal(queryWorld(f.world, original).rows[0].count, 2);
});

test('live table watches retain typed pushdown and update when off-page rows enter or leave predicates', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  await f.put('r1', row(1));
  const { watchQuery } = await import('../sdk/src/live-query.js');
  let notify;
  const client = {
    world: {
      query: (request) => Promise.resolve(queryWorld(f.world, request)),
      watch(request, onResult, options) {
        const invalidator = queryInvalidator(request);
        return watchQuery({
          read: () => Promise.resolve(queryWorld(f.world, request)),
          subscribe: (invalidate) => f.world.subscribe(invalidate),
          relevant: invalidator.relevant,
          onResult: (result) => {
            invalidator.accept(result);
            onResult(result);
          },
          ...options,
        });
      },
    },
  };
  const reader = createTableReader(client, { namespace, tableId }),
    seen = [],
    subscription = reader.watch(
      { where: { score: 999 }, limit: 1 },
      (result) => {
        seen.push(result);
        notify?.(result);
        notify = null;
      },
    );
  t.after(() => subscription.unsubscribe());
  await subscription.ready;
  assert.equal(seen[0].total, 0);
  let next = new Promise((resolve) => (notify = resolve));
  await f.update('r1', { score: 999 });
  assert.equal((await next).total, 1);
  next = new Promise((resolve) => (notify = resolve));
  await f.update('r1', { score: 1 });
  assert.equal((await next).total, 0);
});

test('read-side row and byte budgets remain enforced as an already indexed table grows', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  await f.put('r1', row(1));
  const { TableStorage } = await import('../server/table-storage.mjs');
  f.world.relationalStorage = new TableStorage(f.world, { rows: 1 });
  assert.equal(f.query({}).total, 1);
  await f.put('r2', row(2));
  assert.throws(
    () => f.query({}),
    (error) => error.status === 413,
  );
  assert.equal(
    f.world.get(hash(tableId + ':r2').slice(0, 32)).kind,
    'ink-table-row',
  );
  f.world.relationalStorage = new TableStorage(f.world, { tableBytes: 10 });
  assert.throws(
    () => f.query({}),
    (error) => error.status === 413,
  );
});

test('typed queries never observe an ordinary write before its journal sync', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  await f.put('r1', row(1));
  assert.equal(f.query({ where: { score: 999 } }).total, 0);
  let entered, release;
  const started = new Promise((resolve) => (entered = resolve)),
    blocked = new Promise((resolve) => (release = resolve)),
    append = f.world.journal.append.bind(f.world.journal);
  f.world.journal.append = async (record) => {
    entered();
    await blocked;
    return append(record);
  };
  const changing = f.update('r1', { score: 999 });
  await started;
  assert.equal(f.query({ where: { score: 999 } }).total, 0);
  release();
  await changing;
  assert.equal(f.query({ where: { score: 999 }, explain: true }).total, 1);
});

test('empty definitions, distinct projections and unsupported requests have explicit semantics', async (t) => {
  const f = await fixture(t);
  await f.define(tableId, []);
  assert.equal(f.query({}).total, 0);
  await f.put('only', {});
  assert.equal((await f.reader.get('only')).$key, 'only');
  const result = queryWorld(
    f.world,
    r.query(
      r.distinct(r.project(r.scan(namespace, tableId, 'a'), { key: 'a.$key' })),
    ),
  );
  assert.deepEqual(result.rows, [{ key: 'only' }]);
  assert.throws(
    () =>
      queryWorld(f.world, {
        format: 'ink-relational-v2',
        relation: r.scan(namespace, tableId),
      }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => tableQuery(namespace, tableId, { orderBy: {} }),
    /Invalid table order/,
  );
  const bad = r.query(
    r.filter(r.scan(namespace, tableId), compare('eq', 'row.unknown', 1)),
  );
  assert.throws(
    () => queryWorld(f.world, bad),
    (error) => error.status === 400,
  );
});

test('numeric sums and averages are reproducible across physical orders and incremental updates', async (t) => {
  const f = await fixture(t);
  await f.define(tableId, [
    { key: 'value', type: 'number' },
    { key: 'rank', type: 'integer' },
  ]);
  await f.put('a', { value: 1e16, rank: 1 });
  await f.put('b', { value: 1, rank: 3 });
  await f.put('c', { value: -1e16, rank: 2 });
  const scan = r.scan(namespace, tableId, 'x'),
    aggregates = {
      sum: { op: 'sum', field: 'x.value' },
      avg: { op: 'avg', field: 'x.value' },
    };
  const logical = r.group(scan, {}, aggregates),
    request = r.query(logical, { explain: true }),
    first = queryWorld(f.world, request);
  assert.deepEqual(first.rows, [{ sum: 1, avg: 1 / 3 }]);
  assert.ok(
    first.plan.operators.some((op) => op.operator === 'maintained-aggregates'),
  );
  const reordered = r.group(
    r.order(scan, [{ field: 'x.rank', direction: 'desc' }]),
    {},
    { ...aggregates, max: { op: 'max', field: 'x.value' } },
  );
  assert.deepEqual(queryWorld(f.world, r.query(reordered)).rows, [
    { sum: 1, avg: 1 / 3, max: 1e16 },
  ]);
  await f.update('b', { value: 2 });
  const updated = queryWorld(f.world, request);
  assert.deepEqual(updated.rows, [{ sum: 2, avg: 2 / 3 }]);
  assert.equal(updated.plan.stats.aggregateBuildRows, 0);
});

test('stateless cursors keep enumeration stable across view eviction and host restart', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  for (let i = 0; i < 12; i++)
    await f.put('r' + String(i).padStart(2, '0'), row(i));
  await f.update('r00', { title: 'Moved in cache' });
  const input = r.project(r.scan(namespace, tableId, 'x'), { key: 'x.$key' }),
    request = r.query(input, { limit: 5, count: false }),
    first = queryWorld(f.world, request),
    reopened = await new World(f.directory).open(),
    second = queryWorld(reopened, { ...request, cursor: first.nextCursor });
  assert.deepEqual(
    [...first.rows, ...second.rows].map((row) => row.key),
    Array.from({ length: 10 }, (_, i) => 'r' + String(i).padStart(2, '0')),
  );
  const grouped = r.group(
      r.scan(namespace, tableId, 'x'),
      { status: 'x.status' },
      { count: { op: 'count' } },
    ),
    page = r.query(grouped, { limit: 1, count: false }),
    a = queryWorld(f.world, page);
  for (const field of ['title', 'score'])
    queryWorld(
      f.world,
      r.query(
        r.group(
          r.scan(namespace, tableId, 'x'),
          { value: 'x.' + field },
          { count: { op: 'count' } },
        ),
      ),
    );
  const b = queryWorld(f.world, { ...page, cursor: a.nextCursor });
  assert.deepEqual(
    [...a.rows, ...b.rows].map((row) => row.status),
    ['closed', 'open'],
  );
});

test('the complete joined source set shares one read budget', async (t) => {
  const f = await fixture(t);
  await f.define(tableId);
  await f.define(otherId);
  await f.put('one', row(1));
  await f.put('two', row(2), otherId);
  const { TableStorage } = await import('../server/table-storage.mjs');
  f.world.relationalStorage = new TableStorage(f.world, { cacheRows: 1 });
  const request = r.query(
    r.join(r.scan(namespace, tableId, 'a'), r.scan(namespace, otherId, 'b'), [
      { left: 'a.status', right: 'b.status' },
    ]),
  );
  assert.throws(
    () => queryWorld(f.world, request),
    (error) => error.status === 413,
  );
});
