import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDataPaths,
  verifyDataPaths,
  DataPaths,
} from '../server/data-path-planning.mjs';
import {
  StorageFixture,
  fixtureNamespace,
  scopeStorageQuery,
  storageIdentity,
  validateStorageWorkload,
} from '../server/data-path-workload.mjs';
import {
  queryRelational,
  describeRelational,
} from '../server/relational-query.mjs';
import { tableQuery, relational as r, compare } from '../sdk/src/relations.js';
import { World } from '../server/world.mjs';
const id = 'b'.repeat(32),
  source = 'module app;fn value()->u64{return 1;}';
const columns = [
  { key: 'title', type: 'text' },
  { key: 'score', type: 'integer' },
  { key: 'status', type: 'text' },
  { key: 'team', type: 'text', nullable: true },
  { key: 'payload', type: 'json' },
];
const values = (i) => ({
  title: 'Row ' + i,
  score: i % 19,
  status: i % 2 ? 'open' : 'closed',
  team: i % 3 ? 'team' : 'other',
  payload: { a: 1, b: 2 },
});
function workload(n = 512) {
  return {
    version: 1,
    tables: [
      {
        id,
        columns,
        rows: Array.from({ length: n }, (_, i) => ({
          key: 'row-' + i,
          values: values(i),
        })),
      },
    ],
    history: [
      ...Array.from({ length: 64 }, () => ({ op: 'read', query: 'page' })),
      { op: 'put', tableId: id, key: 'row-1', values: values(2) },
      { op: 'delete', tableId: id, key: 'row-3' },
      { op: 'put', tableId: id, key: 'extra', values: values(7) },
      { op: 'evict' },
      ...Array.from({ length: 32 }, () => ({ op: 'read', query: 'page' })),
    ],
  };
}
const input = () =>
  tableQuery('self', id, {
    where: { status: { contains: 'open' } },
    orderBy: { field: 'score', direction: 'desc' },
    select: ['title', 'score'],
    limit: 20,
    explain: true,
  });
const ui = (q) => ({ components: [{ name: 'page', query: q }] });
const file = (path, value) => ({
  path,
  base64: Buffer.from(JSON.stringify(value)).toString('base64'),
});
async function build(w = workload(), q = input(), options = {}) {
  return buildDataPaths(
    source,
    ui(q),
    {
      version: 1,
      mode: 'auto',
      workload: 'workload.json',
      milliseconds: 10000,
      ...options,
    },
    [file('workload.json', w)],
  );
}
function observation(v) {
  const { plan, dependencies, tables, ...result } = v;
  return result;
}
function resign(packet) {
  for (const p of Object.values(packet.plans)) {
    delete p.identity;
    p.identity = storageIdentity(p);
  }
  delete packet.identity;
  packet.identity = storageIdentity(packet);
  return packet;
}

test('all fixed access recipes preserve complete queries and cursor histories through mutations and eviction', () => {
  const w = workload(90),
    scan = r.scan(fixtureNamespace, id),
    filters = [
      {
        op: 'and',
        args: [compare('gte', 'row.score', 4), compare('lt', 'row.score', 17)],
      },
      compare('contains', 'row.status', 'open'),
      {
        op: 'or',
        args: [
          compare('eq', 'row.team', 'team'),
          compare('eq', 'row.score', 0),
        ],
      },
    ];
  const queries = [
    tableQuery(fixtureNamespace, id, {
      where: { status: 'open', score: { gte: 4, lte: 14 } },
      orderBy: { field: 'score', direction: 'desc' },
      select: ['title', 'score'],
      limit: 7,
    }),
    ...filters.flatMap((predicate) => [
      r.query(r.filter(scan, predicate), { limit: 7 }),
      r.query(
        r.project(
          r.order(r.filter(scan, predicate), [
            { field: 'row.score', direction: 'desc', collation: 'binary' },
            { field: 'row.title', direction: 'asc', collation: 'natural' },
          ]),
          { title: 'row.title', score: 'row.score' },
        ),
        { limit: 7 },
      ),
    ]),
    r.query(
      r.group(
        scan,
        { team: 'row.team' },
        {
          count: { op: 'count' },
          sum: { op: 'sum', field: 'row.score' },
          avg: { op: 'avg', field: 'row.score' },
        },
      ),
      { limit: 7 },
    ),
    r.query(r.distinct(r.project(scan, { status: 'row.status' })), {
      limit: 7,
    }),
    r.query(
      r.project(
        r.join(scan, r.scan(fixtureNamespace, id, 'other'), [
          { left: 'row.$key', right: 'other.$key' },
        ]),
        { title: 'row.title', score: 'other.score' },
      ),
      { limit: 7 },
    ),
  ];
  for (const q of queries) {
    const candidates = describeRelational(new StorageFixture(w), q).candidates;
    const worlds = candidates.map(() => new StorageFixture(w));
    for (const op of [{ op: 'read' }, ...w.history]) {
      if (op.op !== 'read') {
        worlds.forEach((world) => world.apply(op));
        continue;
      }
      const results = worlds.map((world, i) =>
        queryRelational(world, q, { candidate: candidates[i] }),
      );
      for (const result of results)
        assert.deepEqual(
          observation(result),
          observation(results[0]),
          JSON.stringify(q),
        );
      if (results[0].nextCursor) {
        const page = { ...q, cursor: results[0].nextCursor };
        for (let i = 0; i < worlds.length; i++)
          assert.deepEqual(
            observation(
              queryRelational(worlds[i], page, { candidate: candidates[i] }),
            ),
            observation(
              queryRelational(worlds[0], page, { candidate: candidates[0] }),
            ),
          );
      }
    }
  }
});

test('bounded build receipts bind source, complete operators, sample history, selection arithmetic and fallback', async () => {
  const packet = await build(),
    p = packet.plans.page;
  assert.ok(p.selection.receipts.length >= 3);
  assert.ok(
    p.selection.receipts.every((r) => r.valid && r.trials.length === 3),
  );
  assert.deepEqual(verifyDataPaths(source, ui(input()), packet), packet);
  assert.deepEqual(
    await buildDataPaths(
      source,
      ui(input()),
      { version: 1, mode: 'replay', plan: 'saved.json' },
      [file('saved.json', packet)],
    ),
    packet,
  );
  for (const alter of [
    (v) => (v.source = '0'.repeat(64)),
    (v) => (v.plans.page.contract.logical.limit = 1),
    (v) =>
      (v.plans.page.contract.logical.relation.input.by[0].direction = 'asc'),
    (v) =>
      (v.plans.page.recipe = {
        family: 'index',
        indexes: { row: { fields: ['status'] } },
      }),
    (v) => (v.plans.page.rows.row.max += 100),
    (v) => v.plans.page.selection.receipts[0].trials[0].totalNS++,
    (v) => v.plans.page.selection.receipts.pop(),
    (v) => (v.effort.trials = 0),
    (v) => (v.plans.page.selection.mode = 'anything'),
    (v) => (v.plans.page.fallback.family = 'index'),
  ]) {
    const forged = structuredClone(packet);
    alter(forged);
    resign(forged);
    assert.throws(() => verifyDataPaths(source, ui(input()), forged), {
      status: 400,
    });
  }
  const timeout = await build(workload(), input(), { milliseconds: 1 });
  assert.equal(timeout.plans.page.recipe.family, 'scan');
  assert.equal(timeout.plans.page.selection.receipts.length, 0);
  const baseline = await build(workload(), input(), { mode: 'baseline' });
  assert.equal(baseline.plans.page.recipe.family, 'scan');
  assert.equal(baseline.plans.page.rows.row.min, 511);
});

test('admitted execution preserves replies while guards explicitly select scan, without rebuilding workload samples', async () => {
  const w = workload(),
    packet = await build(w),
    world = new StorageFixture(w),
    q = scopeStorageQuery(input(), fixtureNamespace),
    runtime = new DataPaths(world, packet, fixtureNamespace);
  const initial = runtime.query('page', q),
    hot = runtime.query('page', q);
  assert.equal(hot.plan.admission.fallback, null);
  assert.equal(runtime.packet.workload.tables[0].rows.length, 0);
  assert.deepEqual(
    observation(initial),
    observation(
      queryRelational(world, q, {
        candidate: describeRelational(world, q).candidates[0],
      }),
    ),
  );
  if (hot.plan.admission.selected === 'maintained') {
    assert.equal(hot.plan.stats.resultBuildRows, 0);
    assert.equal(hot.plan.stats.visitedRows, 21);
  }
  const table = [...world.relationalStorage.loaded.values()][0];
  const selected = hot.plan.admission.selected;
  if (selected === 'maintained' || selected === 'index') {
    table[selected === 'maintained' ? 'resultView' : 'index'] = () => {
      throw Error('Injected derived-cache allocation failure');
    };
    const fallback = runtime.query('page', q);
    assert.equal(fallback.plan.admission.fallback, 'derived-cache-failed');
    assert.deepEqual(observation(fallback), observation(hot));
  }
  const changed = runtime.query('page', { ...q, limit: 8 });
  assert.equal(changed.plan.admission.fallback, 'query-not-covered');
  assert.equal(changed.rows.length, 8);
  world.apply({ op: 'put', tableId: id, key: 'new', values: values(99) });
  assert.equal(
    runtime.query('page', q).plan.admission.fallback,
    'workload-row-bound-changed',
  );
  const old = structuredClone(packet);
  old.plans.page.target = '0'.repeat(64);
  resign(old);
  verifyDataPaths(source, ui(input()), old);
  assert.equal(
    new DataPaths(world, old, fixtureNamespace).query('page', q).plan.admission
      .fallback,
    'target-or-backend-changed',
  );
  const schema = world.records.get(id);
  world.records.set(id, {
    ...schema,
    revision: 2,
    body: JSON.stringify({
      format: 'ink-table',
      version: 1,
      columns: [...columns, { key: 'extra', type: 'text', default: '' }],
    }),
  });
  world.version++;
  world.relationalStorage.reset();
  assert.equal(
    runtime.query('page', q).plan.admission.fallback,
    'schema-changed',
  );
  assert.throws(
    () => runtime.query('page', { ...q, cursor: initial.nextCursor }),
    { status: 409 },
  );
});

test('planned maintained results see only durable World writes, survive restart, and fail closed on malformed rows', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-data-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const w = workload(64),
    packet = await build(w),
    world = await new World(directory).open();
  const records = new StorageFixture(w).all();
  for (const record of records) await world.create(record);
  const q = scopeStorageQuery(input(), fixtureNamespace),
    runtime = new DataPaths(world, packet, fixtureNamespace),
    before = runtime.query('page', q);
  const record = records.find(
      (r) => r.kind === 'ink-table-row' && JSON.parse(r.body).key === 'row-1',
    ),
    body = JSON.parse(record.body);
  let entered, release;
  const started = new Promise((resolve) => (entered = resolve)),
    blocked = new Promise((resolve) => (release = resolve)),
    append = world.journal.append.bind(world.journal);
  world.journal.append = async (record) => {
    entered();
    await blocked;
    return append(record);
  };
  const updating = world.update(record.id, {
    body: JSON.stringify({
      ...body,
      values: { ...body.values, status: 'closed' },
    }),
  });
  await started;
  assert.equal(runtime.query('page', q).total, before.total);
  release();
  await updating;
  world.journal.append = append;
  const after = runtime.query('page', q);
  assert.equal(after.total, before.total - 1);
  assert.deepEqual(
    observation(after),
    observation(
      queryRelational(world, q, {
        candidate: describeRelational(world, q).candidates[0],
      }),
    ),
  );
  const restarted = await new World(directory).open();
  assert.deepEqual(
    observation(
      new DataPaths(restarted, packet, fixtureNamespace).query('page', q),
    ),
    observation(after),
  );
  await world.update(record.id, { body: 'invalid' });
  assert.throws(() => runtime.query('page', q), { status: 422 });
  await world.update(record.id, { body: JSON.stringify(body) });
  assert.equal(runtime.query('page', q).total, before.total);
});

test('query namespace scoping and admission identities preserve JSON literal order and payloads', async () => {
  const payload = { op: 'scan', namespace: 'literal', a: 1, b: 2 },
    w = workload(1);
  w.tables[0].rows[0].values.payload = payload;
  w.history = [];
  const q = r.query(
    r.filter(r.scan('self', id), compare('eq', 'row.payload', payload)),
    { limit: 5 },
  );
  const scoped = scopeStorageQuery(q, fixtureNamespace);
  assert.deepEqual(scoped.relation.predicate.right.literal, payload);
  const packet = await build(w, q, { mode: 'baseline' }),
    world = new StorageFixture(w),
    runtime = new DataPaths(world, packet, fixtureNamespace);
  assert.equal(runtime.query('page', scoped).total, 1);
  const different = structuredClone(scoped);
  different.relation.predicate.right.literal = {
    b: 2,
    a: 1,
    namespace: 'literal',
    op: 'scan',
  };
  const result = runtime.query('page', different);
  assert.equal(result.total, 0); // explain not requested, exact predicate still executes
  assert.throws(() =>
    validateStorageWorkload({
      ...w,
      history: [
        { op: 'put', tableId: id, key: 'x', values: {}, unknown: true },
      ],
    }),
  );
  assert.throws(() =>
    validateStorageWorkload({
      ...w,
      tables: [
        { ...w.tables[0], rows: [w.tables[0].rows[0], w.tables[0].rows[0]] },
      ],
    }),
  );
});

test('an installed Ink UI release replays its private data plan and shares retained planned snapshots across mounts', async (t) => {
  const { uiFixture, owner } = await import('./ink-ui-fixture.mjs'),
    { buildInkApp, validateInkBundle, installedInk } = await import(
      '../server/ink-apps.mjs'
    );
  const { p } = await uiFixture(t),
    root = new URL('../examples/planned-storage/', import.meta.url),
    manifest = JSON.parse(
      await readFile(new URL('ink-app.json', root), 'utf8'),
    );
  const files = await Promise.all(
    ['main.ink', 'ui.ink', 'storage-workload.json'].map(async (path) => ({
      path,
      base64: (await readFile(new URL(path, root))).toString('base64'),
    })),
  );
  const bundle = await buildInkApp(manifest, files);
  assert.equal(bundle.ink.dataPaths.path, 'server/data-paths.json');
  bundle.commands = (
    await import('../shared/app-commands.mjs')
  ).validateCommands(bundle.commands);
  await validateInkBundle(bundle);
  const app = await p.createApp({
      slug: 'planned-storage',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  const w = JSON.parse(Buffer.from(files[2].base64, 'base64'));
  for (const record of new StorageFixture(w, { namespace: app.id }).all())
    await p.world.create(record);
  const installed = await installedInk(p, app.id);
  assert.equal(installed.dataPaths.workload.tables[0].rows.length, 0);
  const a = await p.inkViews.openApp(app.id, owner),
    b = await p.inkViews.openApp(app.id, owner);
  assert.ok(a.tree.nodes.some((n) => n.kind === 'Item'));
  assert.deepEqual(a.tree, b.tree);
  assert.ok(p.inkViews.queries.hits > 0);
  const manager = [...p.inkViews.queries.plans.values()][0],
    q = scopeStorageQuery(manifest.ui.components[0].query, app.id);
  assert.equal(
    manager.query('page', { ...q, explain: true }).plan.admission.fallback,
    null,
  );
  const row = p.world
      .all()
      .find(
        (o) =>
          o.kind === 'ink-table-row' &&
          o.namespace === app.id &&
          JSON.parse(o.body).key === '1',
      ),
    body = JSON.parse(row.body);
  await p.world.update(row.id, {
    body: JSON.stringify({
      ...body,
      values: { ...body.values, title: 'Updated from durable World' },
    }),
  });
  const changed = await p.inkViews.refresh(a.id, owner, {
    revision: a.revision,
  });
  assert.deepEqual(changed.computed, ['page']);
  await p.inkViews.refresh(b.id, owner, { revision: b.revision });
  const forged = structuredClone(bundle),
    index = forged.files.findIndex((f) => f.path === 'server/data-paths.json'),
    packet = JSON.parse(Buffer.from(forged.files[index].base64, 'base64'));
  packet.plans.page.contract.logical.limit = 1;
  resign(packet);
  forged.files[index] = file('server/data-paths.json', packet);
  await assert.rejects(validateInkBundle(forged), { status: 400 });
});
