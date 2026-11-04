import test from 'node:test';
import assert from 'node:assert/strict';
import { systemFixture, owner } from './ink-system-fixture.mjs';
import { until } from './ink-retained-fixture.mjs';
test('adopting an already in-flight read establishes one increasing retained query clock', async (t) => {
  const f = await systemFixture(t, { collaborative: true }),
    views = f.p.inkViews;
  const frame = await views.openApp(f.deployed.apps.dashboard.appId, owner),
    program = await views.program(views.mounts.get(frame.id), owner),
    component = program.components.get('results');
  await f.call('put', [0, { id: 1, title: 'First', amount: 1, open: true }]);
  let release,
    blocked = false;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    original = f.p.code.execute;
  f.p.code.execute = async function (input) {
    if (input.entry === 'dashboard') {
      blocked = true;
      await gate;
    }
    return original.call(this, input);
  };
  const pending = views.reads.read(
    component.read,
    component.data,
    AbortSignal.timeout(10000),
  );
  await until(() => blocked);
  const snapshots = [],
    stop = views.reads.retain(component.read, component.data, (update) => {
      if (update.snapshot) snapshots.push(update.snapshot);
    });
  t.after(stop);
  release();
  await pending;
  await until(() => snapshots.length === 1);
  f.p.code.execute = original;
  await f.call('put', [1, { id: 1, title: 'Second', amount: 2, open: true }]);
  await until(() => snapshots.length === 2);
  assert.equal(snapshots[0].id, snapshots[1].id);
  assert.equal(snapshots[0].sequence, 1);
  assert.equal(snapshots[1].sequence, 2);
  assert.deepEqual(
    snapshots.map((s) => s.versionWire),
    ['1', '2'],
  );
});
test('a failed retained read reports its error and recovers without requiring a new commit', async (t) => {
  const f = await systemFixture(t, { collaborative: true }),
    views = f.p.inkViews;
  const frame = await views.openApp(f.deployed.apps.dashboard.appId, owner);
  const pending = views.watch(
    frame.id,
    owner,
    { ...frame.updates, revision: frame.revision },
    { signal: AbortSignal.timeout(10000) },
  );
  const rejected = assert.rejects(pending, /worker unavailable/);
  await until(() => views.mounts.get(frame.id).waiters.size === 1);
  const original = f.p.code.execute;
  let fail = true;
  f.p.code.execute = function (input) {
    if (input.entry === 'dashboard' && fail) {
      fail = false;
      throw Error('worker unavailable');
    }
    return original.call(this, input);
  };
  t.after(() => {
    f.p.code.execute = original;
  });
  await f.call('put', [
    0,
    { id: 1, title: 'Recovered', amount: 7, open: true },
  ]);
  await rejected;
  await until(() => views.mounts.get(frame.id).deliverySequence === 1);
  const recovered = await views.watch(frame.id, owner, {
    ...frame.updates,
    revision: frame.revision,
  });
  assert.equal(recovered.snapshots[0].versionWire, '1');
  assert.ok(
    recovered.patch.operations.some(
      (op) =>
        op.node?.props.text === 'Recovered' || op.props?.text === 'Recovered',
    ),
  );
  assert.equal([...views.reads.retained.values()][0].error, null);
});
