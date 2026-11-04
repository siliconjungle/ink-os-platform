import test from 'node:test';
import assert from 'node:assert/strict';
import { systemFixture, owner } from './ink-system-fixture.mjs';
import { inkFootprints } from '../server/ink-footprints.mjs';

// Tables gains a root its exported dashboard query never reads, a change that
// reads Rows but writes only that root, and a change that rewrites a row.
const EXTRA = `
state Notes:u64=0;
change note(x:u64)->Result<Unit,String> reads(Rows,Notes) writes(Notes){Notes=x+sum(Rows.values().map(fn(row)=>row.amount));return Ok(());}
change touch(row:Row)->Result<Unit,String> reads(Rows) writes(Rows){Rows.put(row.id,row);return Ok(());}
`;
export function extendTables(input, source = EXTRA, exports = ['note', 'touch']) {
  const app = input.apps.find((a) => a.name === 'tables'),
    main = app.files.find((f) => f.path === 'main.ink');
  main.base64 = Buffer.from(
    Buffer.from(main.base64, 'base64').toString() + source,
  ).toString('base64');
  app.manifest.exports.push(...exports);
  app.manifest.modules.modules
    .find((m) => m.path === 'main.ink')
    .exports.push(...exports);
  app.files.find((f) => f.path === 'ink-app.json').base64 = Buffer.from(
    JSON.stringify(app.manifest),
  ).toString('base64');
}

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
