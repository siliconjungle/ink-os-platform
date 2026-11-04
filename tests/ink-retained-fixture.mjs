import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { owner } from './ink-system-fixture.mjs';
export const cursor = (frame) => ({
  stream: frame.updates.stream,
  sequence: frame.updates.sequence,
  revision: frame.revision,
});
export async function until(check) {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end) throw Error('Retained query did not settle');
    await delay(2);
  }
}
export async function retainedHistory(f) {
  const views = f.p.inkViews,
    first = await views.openApp(f.deployed.apps.tables.appId, owner),
    second = await views.openApp(f.deployed.apps.dashboard.appId, owner);
  const a = views.watch(first.id, owner, cursor(first), {
      signal: AbortSignal.timeout(10000),
    }),
    b = views.watch(second.id, owner, cursor(second), {
      signal: AbortSignal.timeout(10000),
    });
  await until(() =>
    [...views.mounts.values()].every((m) => m.waiters.size === 1),
  );
  assert.equal(views.reads.retained.size, 1);
  assert.equal([...views.reads.retained.values()][0].listeners.size, 2);
  const writesBefore = views.reads.reads;
  let resultComputations = 0;
  const execute = f.p.code.execute;
  f.p.code.execute = function (input) {
    if (input.entry === 'results') resultComputations++;
    return execute.call(this, input);
  };
  const reply = await f.call(
    'put',
    [0, { id: 1, title: 'Retained', amount: 7, open: true }],
    { requestId: 'retained-write' },
  );
  const frames = await Promise.all([a, b]);
  assert.equal(views.reads.reads, writesBefore + 1);
  f.p.code.execute = execute;
  assert.equal(resultComputations, 2, 'compute each affected pane once');
  for (const value of frames) {
    assert.equal(value.updates.sequence, 1);
    assert.equal(value.snapshots[0].versionWire, '1');
    assert.ok(
      value.patch.operations.some(
        (op) =>
          op.props?.text === 'Open total: 7' ||
          op.node?.props.text === 'Open total: 7',
      ),
    );
  }
  assert.equal(frames[0].snapshots[0].id, frames[1].snapshots[0].id);
  assert.equal(
    frames[0].snapshots[0].stateRevision,
    frames[1].snapshots[0].stateRevision,
  );
  // Dropping a reply and reconnecting at the old cursor replays the same patch.
  const replay = await views.watch(first.id, owner, cursor(first));
  assert.deepEqual(replay, frames[0]);
  const duplicate = await f.call(
    'put',
    [0, { id: 1, title: 'Retained', amount: 7, open: true }],
    { requestId: 'retained-write' },
  );
  assert.equal(duplicate.valueWire, reply.valueWire);
  const authority = f.p.world.stateCommits.get(
    f.deployed.apps.tables.appId + '\0ink-app:state',
  );
  if (authority)
    f.p.world.stateCommitted(
      f.deployed.apps.tables.appId,
      'ink-app:state',
      JSON.parse(authority.body),
      authority.revision,
    );
  await delay(10);
  assert.equal(views.reads.reads, writesBefore + 1);
  const pending = views.watch(second.id, owner, cursor(frames[1]), {
    signal: AbortSignal.timeout(20),
  });
  await assert.rejects(pending, (error) => error.status === 499);
  assert.equal(views.mounts.get(second.id).waiters.size, 0);
  const count = views.reads.reads;
  await f.call('abort_edit', [
    { id: 2, title: 'Abort', amount: 99, open: true },
  ]);
  await delay(5);
  assert.equal(views.reads.reads, count);
  await views.dispose(first.id, owner);
  assert.equal(views.reads.retained.size, 1);
  await views.dispose(second.id, owner);
  assert.equal(views.reads.retained.size, 0);
  assert.equal(views.deliveryBytes, 0);
  return {
    valueWire: reply.valueWire,
    frames: frames.map((frame) => ({
      version: frame.snapshots[0].versionWire,
      operations: frame.patch.operations.length,
    })),
  };
}
