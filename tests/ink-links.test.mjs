import test from 'node:test';
import assert from 'node:assert/strict';
import { systemFixture, owner, extendTables, planned } from './ink-system-fixture.mjs';
import { inkFootprints } from '../server/ink-footprints.mjs';

test('footprints report IR write roots and pure functions', async () => {
  const fp = await inkFootprints(`module app;
record Row {id:u64,open:Bool,}
state A:Table<u64,Row>=Table.empty(); state B:u64=0;
keep K:u64=sum(A.values().filter(fn(r)=>r.open).map(fn(r)=>1));
change w(x:u64)->Result<Unit,String> reads(K) writes(B){B=x+K;return Ok(());}
query q()->u64 reads(K){return K;}
fn open(r:Row)->Bool{return r.open;}`);
  assert.deepEqual(fp.graphs.get('w').roots, { read: ['A'], write: ['B'] });
  assert.deepEqual(fp.graphs.get('q').roots, { read: ['A'], write: [] });
  assert.equal(fp.graphs.get('open').pure, true);
  assert.equal(fp.graphs.get('w').pure, false);
});

test('cross-app reads refresh only when a commit writes a state root the exported query reads', async (t) => {
  const f = await systemFixture(t, { baseline: true, edit: extendTables }),
    { p, deployed } = f,
    events = [];
  t.after(
    p.world.subscribe((event) => {
      if (event.type === 'ink-reads') events.push(event);
    }),
  );
  const dashboard = await p.inkViews.openApp(deployed.apps.dashboard.appId, owner),
    reads = p.inkViews.reads.reads;
  const refresh = (frame) =>
    p.inkViews.refresh(frame.id, owner, { revision: frame.revision });

  // `note` reads Rows but writes only Notes: the dashboard stays current.
  assert.equal((await f.call('note', [5])).valueWire, '{"Ok":null}');
  const quiet = await refresh(dashboard);
  assert.deepEqual(quiet.computed, []);
  assert.equal(p.inkViews.reads.reads, reads);
  assert.equal(events.length, 0);

  // A write to Rows re-runs the query and tells desktops exactly who reads it.
  const row = { id: 1, title: 'First', amount: 7, open: true };
  await f.call('put', [0, row]);
  assert.deepEqual(
    events.map((e) => [e.provider, e.apps]),
    [[deployed.apps.tables.appId, [deployed.apps.dashboard.appId]]],
  );
  const changed = await refresh(quiet);
  assert.deepEqual(changed.computed, ['results']);
  assert.equal(p.inkViews.reads.reads, reads + 1);

  // Rewriting a row with the same value commits to Rows, but the query's exact
  // result is unchanged, so the consumer keeps its computed view.
  await f.call('touch', [row]);
  const same = await refresh(changed);
  assert.deepEqual(same.computed, []);
  assert.equal(p.inkViews.reads.reads, reads + 2);
  assert.equal(p.inkViews.reads.reused, 1);
});

const PLAN = { version: 1, where: 'big', limit: 1, aggregate: { op: 'sum', value: 'amount' } };

async function portRead(p, appId, name = 'results') {
  const mount = await p.inkViews.openApp(appId, owner),
    state = p.inkViews.mounts.get(mount.id),
    program = await p.inkViews.program(state, owner),
    component = program.components.get(name);
  return {
    mount,
    read: () => p.inkViews.reads.read(component.read, component.data, undefined, { appId, releaseId: state.releaseId }),
    component,
  };
}

test('link plans filter, page and aggregate next to a read-only provider copy, shared by identical consumers', async (t) => {
  const f = await systemFixture(t, { baseline: true, edit: planned(PLAN) }),
    { p, deployed, packet } = f,
    links = p.inkViews.reads.links;
  const edge = packet.graph.links.find((l) => l.consumer === 'dashboard');
  assert.deepEqual(edge.footprint.writes, []);
  assert.deepEqual(edge.footprint.capabilities.consumer, ['apps.invoke', 'code.execute']);
  assert.deepEqual(edge.code.map((c) => [c.role, c.function, c.pure]), [['where', 'big', true], ['value', 'amount', true]]);

  let version = 0;
  const put = async (id, amount, open = true) => {
    await f.call('put', [version, { id, title: 'Item ' + id, amount, open }]);
    version++;
  };
  for (let id = 1; id <= 6; id++) await put(id, id);
  await put(7, 9, false);

  // The definition, evaluated on the provider's own exported query.
  const reference = async () => {
    const data = JSON.parse((await f.call('dashboard', [0, 1000])).valueWire),
      kept = data.rows.filter((row) => row.amount >= 5);
    return { rows: kept.slice(0, 1).map((r) => r.id), total: kept.reduce((n, r) => n + r.amount, 0), version: data.version };
  };
  const view = (snapshot) => ({
    rows: snapshot.value.rows.map((r) => Number(r.id)),
    total: Number(snapshot.value.total.Some),
    version: Number(snapshot.value.version),
  });

  const one = await portRead(p, deployed.apps.dashboard.appId),
    two = await portRead(p, deployed.apps.dashboard2.appId);
  const a = await one.read(),
    b = await two.read();
  assert.deepEqual(view(a), await reference());
  assert.deepEqual(view(a), { rows: [5], total: 11, version: 7 });
  assert.equal(a, b, 'identical consumer code shares one result');
  assert.equal(a.scanned, 6);
  assert.equal(links.stats().evaluations, 1);
  assert.equal(links.stats().loads, 1);

  // After a provider commit both consumers see the same current result.
  await put(8, 20);
  const c = await one.read();
  assert.deepEqual(view(c), await reference());
  assert.deepEqual(view(c), { rows: [5], total: 31, version: 8 });
  assert.equal(await two.read(), c);

  // A plan the consumer release does not declare is refused.
  await assert.rejects(
    p.inkViews.reads.read(
      { ...one.component.read, plan: { version: 1, where: 'wrong' } },
      one.component.data,
      undefined,
      { appId: deployed.apps.dashboard.appId, releaseId: p.inkViews.mounts.get(one.mount.id).releaseId },
    ),
    { status: 403 },
  );
});

test('system builds reject plans whose code is not pure consumer code over the row type', async (t) => {
  await assert.rejects(
    systemFixture(t, { baseline: true, edit: planned({ version: 1, where: 'wrong' }, { twin: false }) }),
    /exact row type/,
  );
  await assert.rejects(
    systemFixture(t, { baseline: true, edit: planned({ version: 1, where: 'view' }, { twin: false }) }),
    /not a consumer function/,
  );
  await assert.rejects(
    systemFixture(t, { baseline: true, edit: planned({ version: 1, limit: 0 }, { twin: false }) }),
    /limit/,
  );
});

test('the provider copy follows commits by replay and keeps used results current', async (t) => {
  const f = await systemFixture(t, { baseline: true, edit: planned(PLAN, { twin: false }) }),
    { p, deployed } = f,
    links = p.inkViews.reads.links,
    port = await portRead(p, deployed.apps.dashboard.appId);
  let version = 0;
  for (let id = 1; id <= 4; id++) {
    await f.call('put', [version, { id, title: 'Item ' + id, amount: id * 3, open: true }]);
    version++;
  }
  const first = await port.read();
  assert.deepEqual(first.value.rows.map((r) => Number(r.id)), [2]);
  assert.equal(first.value.total.Some, 6n + 9n + 12n);
  const before = links.stats();
  await f.call('put', [version, { id: 9, title: 'Item 9', amount: 100, open: true }]);
  // The commit is replayed on the copy and the result refreshed before the next read.
  const next = await port.read();
  assert.equal(next.value.total.Some, 127n);
  const after = links.stats();
  assert.equal(after.loads, before.loads);
  assert.equal(after.applies, before.applies + 1);
  assert.equal(after.refreshed, before.refreshed + 1);
  assert.equal(after.evaluations, before.evaluations + 1);
  assert.equal(before.loads, 1, 'the copy loaded once and followed every seed commit');
  // A commit that writes no root the query reads leaves the result as it is.
  await f.call('abort_edit', [{ id: 10, title: 'x', amount: 1, open: true }]);
  assert.equal(await port.read(), next);
});
