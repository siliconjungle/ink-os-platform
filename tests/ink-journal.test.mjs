import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Code } from '../server/code.mjs';
import { InkResidents } from '../server/ink-residents.mjs';
import { hash } from '../server/world.mjs';
import { contentChunks, InkAppJournal } from '../server/ink-app-journal.mjs';

const source = `module rows;
record Row {id:u64,title:String,amount:u64,}
state Rows:Table<u64,Row>=Table.empty();
change seed(keys:List<u64>,rows:List<Row>)->Result<Unit,String> reads(Rows) writes(Rows){return Rows.put_many(keys,rows);}
change edit(id:u64,amount:u64)->Result<Unit,String> reads(Rows) writes(Rows){Rows.put(id,Row{id:id,title:"edited",amount:amount});return Ok(());}
query total()->u64 reads(Rows){return Rows.sum_by(fn(row)=>row.amount);}`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-journal-')),
    code = new Code('.', directory);
  t.after(async () => {
    await code.close();
    await rm(directory, { recursive: true, force: true });
  });
  const writes = [];
  const batch = code.storage.batch;
  code.storage.batch = async (...args) => {
    writes.push(...args[3].filter((change) => !change.delete).map((change) => change.key));
    return batch(...args);
  };
  const run = (entry, args) => code.run({ source, entry, args, instance: 'one' });
  const compiled = await code.compile(source),
    namespace = hash('one').slice(0, 32),
    key = 'ink-program:' + compiled.digest;
  const restart = async () => {
    await code.residents.close();
    code.residents = new InkResidents();
  };
  return { code, run, writes, namespace, key, restart, prefix: '@ink:' + hash(key) + ':' };
}

test('content chunks are local: an edit changes only the chunks around it', () => {
  const bytes = Buffer.alloc(200000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24;
  const edited = Buffer.concat([bytes.subarray(0, 100000), Buffer.from('a longer edit'), bytes.subarray(100004)]);
  const ids = (b) => contentChunks(b).map(([s, e]) => hash(b.subarray(s, e)));
  const before = new Set(ids(bytes)),
    after = ids(edited);
  assert.ok(contentChunks(bytes).every(([s, e]) => e - s <= 24576));
  assert.ok(after.filter((id) => !before.has(id)).length <= 2);
});

test('journal v2 headers stay constant and a compaction after a one-row edit rewrites only changed chunks', async (t) => {
  const f = await fixture(t),
    keys = [],
    rows = [];
  for (let id = 1; id <= 4000; id++) {
    keys.push(id);
    rows.push({ id, title: 'Row ' + id, amount: id % 9 });
  }
  assert.match((await f.run('seed', [keys, rows])).wire, /"Ok"/);
  const sizes = [];
  for (let i = 0; i < 30; i++) {
    await f.run('edit', [10 + i, 1]);
    sizes.push(JSON.stringify((await f.code.readState(f.namespace, f.key)).value).length);
  }
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 64, 'header size does not grow with the tail');
  // The 32nd commit compacts onto the first full snapshot.
  await f.run('edit', [3000, 7]);
  const first = (await f.code.readState(f.namespace, f.key)).value;
  assert.equal(first.count, 0);
  assert.ok(first.base.snapshot.chunks.length >= 8, 'the snapshot spans many chunks');
  // The next compaction differs by one row: only nearby chunks are new.
  for (let i = 0; i < 31; i++) await f.run('edit', [2000, i]);
  f.writes.length = 0;
  await f.run('edit', [2000, 5]);
  // Count snapshot chunks only: metadata chunks hold receipts with random
  // request identities, so how many of those change varies from run to run.
  const after = (await f.code.readState(f.namespace, f.key)).value,
    snapshotKeys = new Set(after.base.snapshot.chunks.map((id) => f.prefix + 'c:' + id)),
    written = f.writes.filter((k) => snapshotKeys.has(k));
  assert.equal(after.count, 0);
  assert.notEqual(after.base.hash, first.base.hash);
  assert.ok(written.length <= 5, `compaction wrote ${written.length} of ${after.base.snapshot.chunks.length} snapshot chunks`);
  const total = rows.reduce((n, r) => n + r.amount, 0) - [...Array(30)].reduce((n, _, i) => n + ((10 + i) % 9) - 1, 0) - (3000 % 9) + 7 - (2000 % 9) + 5;
  // The state recovers exactly from the new base.
  await f.restart();
  assert.equal((await f.run('total', [])).output.result, total);
});

test('version 1 journals recover and become version 2 on their next commit', async (t) => {
  const f = await fixture(t);
  await f.run('seed', [[1, 2], [{ id: 1, title: 'a', amount: 2 }, { id: 2, title: 'b', amount: 3 }]]);
  const current = await f.code.readState(f.namespace, f.key),
    journal = new InkAppJournal(f.code.storage, f.namespace, f.key),
    recovery = await journal.recover(current),
    record = recovery.records[0];
  // Rewrite the state as the version 1 layout: random-id parts and a record list.
  const legacy = (value, id) => {
    const text = JSON.stringify(value);
    return { change: { key: f.prefix + id + ':0', value: text }, descriptor: { id: f.prefix + id, parts: 1, hash: hash(text) } };
  };
  const base = legacy({ source: recovery.source, digest: current.value.digest, snapshot: recovery.snapshot, receipts: [] }, 'legacybase'),
    one = legacy(record, 'legacyone');
  await f.code.storage.batch(f.namespace, f.key, current.revision, [base.change, one.change]);
  const header = {
    format: 'ink-os-app-journal-v1',
    digest: current.value.digest,
    base: base.descriptor,
    records: [{ ...one.descriptor, previous: base.descriptor.hash }],
    head: one.descriptor.hash,
    bytes: 0,
  };
  await f.code.storage.batch(f.namespace, f.key, current.revision, [{ key: f.key, value: header }]);
  await f.restart();
  assert.equal((await f.run('total', [])).output.result, 5);
  await f.run('edit', [2, 10]);
  const upgraded = (await f.code.readState(f.namespace, f.key)).value;
  assert.equal(upgraded.format, 'ink-os-app-journal-v2');
  const stored = await f.code.stateKeys(f.namespace, '@ink:');
  assert.ok(!stored.some((k) => k.includes('legacy')), 'version 1 payloads are collected');
  await f.restart();
  assert.equal((await f.run('total', [])).output.result, 12);
});
