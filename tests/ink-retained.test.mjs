import test from 'node:test';
import assert from 'node:assert/strict';
import { systemFixture, owner } from './ink-system-fixture.mjs';
import { retainedHistory, cursor, until } from './ink-retained-fixture.mjs';
import { queryPageDelta } from '../server/ink-ui-reads.mjs';
test('two live apps retain one checked query and replay exact ordered frames without refresh RPCs', async (t) => {
  await retainedHistory(await systemFixture(t, { collaborative: true }));
});
test('slow subscribers recover a complete snapshot after bounded history loss; pins and owners remain fenced', async (t) => {
  const f = await systemFixture(t, { collaborative: true }),
    views = f.p.inkViews;
  const frame = await views.openApp(f.deployed.apps.dashboard.appId, owner);
  const initial = views.watch(frame.id, owner, cursor(frame), {
    signal: AbortSignal.timeout(20),
  });
  await assert.rejects(initial, (error) => error.status === 499);
  for (let i = 0; i < 35; i++) {
    await f.call(
      'put',
      [i, { id: 1, title: 'Version ' + i, amount: i + 1, open: true }],
      { requestId: 'ordered-' + i },
    );
    await until(() => views.mounts.get(frame.id).deliverySequence >= i + 1);
  }
  const mount = views.mounts.get(frame.id);
  assert.ok(mount.history.length <= 32);
  assert.ok(views.deliveryBytes <= 8 * 1024 * 1024);
  const latest = await views.watch(frame.id, owner, cursor(frame));
  assert.equal(latest.updates.reset, true);
  assert.equal(latest.updates.sequence, 35);
  assert.equal(latest.snapshots[0].versionWire, '35');
  assert.ok(latest.tree.nodes.some((n) => n.props.text === 'Version 34'));
  await assert.rejects(
    views.watch(frame.id, { appId: '0'.repeat(32) }, cursor(latest)),
    { status: 403 },
  );
  const waiting = views.watch(frame.id, owner, cursor(latest), {
    signal: AbortSignal.timeout(10000),
  });
  const provider = f.p.world.get(f.deployed.apps.tables.appId),
    meta = JSON.parse(provider.body);
  await f.p.world.update(
    provider.id,
    { body: JSON.stringify({ ...meta, releaseId: 'f'.repeat(32) }) },
    { writer: 'os' },
  );
  await assert.rejects(waiting, (error) => error.status === 409);
});
test('page splices and aggregate versions preserve exact integers and never mutate prior snapshots', () => {
  const previous = {
    rows: [
      { id: 1n, n: 9007199254740993n },
      { id: 2n, n: 7n },
      { id: 3n, n: 8n },
    ],
    total: { Some: 3n },
    version: 9007199254740993n,
  };
  const value = {
    rows: [previous.rows[0], { id: 4n, n: 9n }, previous.rows[2]],
    total: { Some: 3n },
    version: 9007199254740994n,
  };
  const delta = queryPageDelta(previous, value),
    rows = previous.rows.slice();
  rows.splice(delta.start, delta.deleteCount, ...delta.rows);
  assert.deepEqual(rows, value.rows);
  assert.equal(delta.versionWire, '9007199254740994');
  assert.equal(delta.start, 1);
  assert.equal(delta.deleteCount, 1);
  assert.equal(previous.rows[1].id, 2n);
  assert.ok(Object.isFrozen(delta.rows));
});
test('retained pages move at filter boundaries with the aggregate and exact source version', async (t) => {
  const f = await systemFixture(t, { collaborative: true }),
    views = f.p.inkViews;
  for (let i = 0; i < 3; i++)
    await f.call('put', [
      i,
      { id: i + 1, title: 'Row ' + (i + 1), amount: i + 1, open: true },
    ]);
  const frame = await views.openApp(f.deployed.apps.dashboard.appId, owner),
    mount = views.mounts.get(frame.id),
    program = await views.program(mount, owner),
    component = program.components.get('results'),
    binding = component.read,
    values = [[], []];
  const releases = [0, 1].map((index) =>
    views.reads.retain(
      { ...binding, input: JSON.stringify([index, 1]) },
      component.data,
      (update) => {
        if (update.error) throw update.error;
        values[index].push(update.snapshot);
      },
    ),
  );
  t.after(() => releases.forEach((release) => release()));
  await until(() => values.every((list) => list.length));
  await f.call('remove', [3, 1]);
  await until(() => values.every((list) => list.at(-1).versionWire === '4'));
  for (let index = 0; index < 2; index++) {
    const snapshot = values[index].at(-1);
    assert.equal(snapshot.value.rows[0].id, BigInt(index + 2));
    assert.equal(snapshot.value.rows[0].aggregate, 5n);
    assert.equal(snapshot.value.total.Some, 2n);
    assert.equal(snapshot.delta.start, 0);
    assert.equal(snapshot.delta.deleteCount, 1);
  }
});
test('commit bursts may coalesce while delivered source versions stay ordered and page/aggregate stay atomic', async (t) => {
  const f = await systemFixture(t, { collaborative: true }),
    views = f.p.inkViews;
  let frame = await views.openApp(f.deployed.apps.dashboard.appId, owner);
  const first = views.watch(frame.id, owner, cursor(frame), {
    signal: AbortSignal.timeout(10000),
  });
  await until(() => views.mounts.get(frame.id).waiters.size === 1);
  const writes = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      f.call(
        'put',
        [i, { id: 1, title: 'Burst ' + (i + 1), amount: i + 1, open: true }],
        { requestId: 'burst-' + i },
      ),
    ),
  );
  assert.equal(
    writes.filter((r) => JSON.parse(r.valueWire).Ok !== undefined).length,
    12,
  );
  let previous = 0n;
  frame = await first;
  for (let attempts = 0; attempts < 12; attempts++) {
    const version = BigInt(frame.snapshots[0].versionWire);
    assert.ok(version > previous);
    previous = version;
    assert.ok(
      frame.patch.operations.some(
        (op) =>
          op.props?.text === 'Open total: ' + version ||
          op.node?.props.text === 'Open total: ' + version,
      ),
    );
    if (version === 12n) break;
    frame = await views.watch(frame.id, owner, cursor(frame), {
      signal: AbortSignal.timeout(10000),
    });
  }
  assert.equal(previous, 12n);
});
