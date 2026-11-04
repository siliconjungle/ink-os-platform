import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemProfile, exclusive, jsonBytes } from '../scripts/lib/ink-system-profile.mjs';
import { systemFixture, owner } from './ink-system-fixture.mjs';

test('JSON field accounting partitions actual UTF-8 bytes including punctuation and omitted fields', () => {
  for (const value of [{ text: '🖋️ "Ink"', omitted: undefined, nested: [1, null, true] }, {}, [1, 'é']]) {
    const result = jsonBytes(value);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(value)));
    assert.equal(Object.values(result.fields).reduce((a,b) => a+b, 0), result.bytes);
  }
});

test('exclusive wall time subtracts overlapping children once and clips out-of-parent spans', () => {
  const result = exclusive([
    { id: 1, parent: null, start: 10, end: 30 },
    { id: 2, parent: 1, start: 8, end: 20 },
    { id: 3, parent: 1, start: 15, end: 25 },
    { id: 4, parent: 1, start: 28, end: 35 },
  ]);
  assert.equal(result[0].exclusive, 3);
});

test('trace contexts retain concurrent request identity and preserve rejected operations', async () => {
  const profile = new SystemProfile(), expected = Error('operation failed');
  await Promise.all(['a','b'].map(trace => profile.run(trace, 'root', {}, async () => {
    await Promise.resolve();
    assert.equal(profile.current.trace, trace);
    await assert.rejects(profile.span('failure', {}, async () => { throw expected; }), error => error === expected);
  })));
  for (const trace of ['a','b']) {
    const spans = profile.spans.filter(s => s.trace === trace), root = spans.find(s => s.name === 'root');
    assert.equal(spans.find(s => s.failed).parent, root.id);
  }
  assert.equal(profile.current, undefined);
});

test('real system tracing splits checked JS worker phases without changing replies or durable commits', async t => {
  const f = await systemFixture(t, { collaborative: true }), profile = new SystemProfile();
  t.after(() => profile.close());
  await f.call('put', [0, { id: 1, title: 'Before', amount: 1, open: true }]);
  const view = await f.p.inkViews.openApp(f.deployed.apps.dashboard.appId, owner);
  await profile.attach(f.p);
  const result = await profile.run('edit', 'request', {}, async () => {
    const result = await f.call('put', [1, { id: 1, title: 'Traced', amount: 7, open: true }]);
    await f.p.inkViews.refresh(view.id, owner, { revision: view.revision });
    return result;
  });
  assert.equal(result.valueWire, '{"Ok":2}');
  assert.ok(!JSON.stringify(result).includes('worker.compute'));
  for (const name of ['worker.prepare','worker.decode','worker.compute','worker.encode','wal.fsync','query.snapshot','view.frame'])
    assert.ok(profile.spans.some(s => s.name === name && s.trace === 'edit'), name);
  assert.ok(profile.wal.reduce((n,r) => n+r.bytes, 0) > 0);
  assert.equal((await f.call('dashboard', [0,20])).valueWire.includes('"aggregate":7'), true);
  profile.close();
  for (const session of f.p.code.residents.sessions.values()) assert.equal(session.endpoint.onDiagnostic, undefined);
  // A failing private observer is outside the application result and cannot
  // change commit/receipt semantics.
  for (const session of f.p.code.residents.sessions.values()) session.endpoint.onDiagnostic = () => { throw Error('observer'); };
  assert.equal((await f.call('dashboard', [0,20])).valueWire.includes('"aggregate":7'), true);
});
