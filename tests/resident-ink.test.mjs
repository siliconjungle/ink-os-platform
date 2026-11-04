import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  readFile,
  appendFile,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Code } from '../server/code.mjs';
import { World, hash } from '../server/world.mjs';
import { InkResidents } from '../server/ink-residents.mjs';
import { RuntimeCredentials } from '../server/runtime-credentials.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { forkData, appDataSnapshot } from '../server/app-data.mjs';

const source =
  'module count; state Total:u32=0; change add(n:u32)->u32 reads(Total) writes(Total){Total=Total+n;return Total;} query total()->u32 reads(Total){return Total;}';
const app = 'a'.repeat(32),
  copy = 'b'.repeat(32),
  key = 'ink-app:state';
async function fixture(t, { collaboration = false, options = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-resident-'));
  const world = await new World(directory).open();
  if (collaboration) {
    await world.create({ id: app, namespace: 'os', kind: 'app', body: '{}' });
    await world.create({ id: copy, namespace: 'os', kind: 'app', body: '{}' });
  }
  const collab = collaboration ? new Collaboration({ directory, world }) : null;
  const code = new Code('.', join(directory, 'code'), world, options);
  t.after(async () => {
    await code.close();
    await collab?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const run = (entry = 'add', args = [1], extra = {}) =>
    code.run({ source, entry, args, namespace: app, stateKey: key, ...extra });
  return { directory, world, code, collab, run };
}

test('resident bindings retain state, bound journals, and materialize portable checkpoints', async (t) => {
  const f = await fixture(t);
  let snapshots = 0;
  const persist = f.world.persist.bind(f.world);
  f.world.persist = async () => {
    snapshots++;
    return persist();
  };
  for (let index = 1; index <= 36; index++)
    assert.equal(
      (await f.run('add', [1], { requestId: 'r' + index })).output.result,
      index,
    );
  assert.equal(f.code.residents.starts, 1);
  assert.equal(
    (await f.run('add', [1], { requestId: 'r30' })).output.result,
    30,
    'checkpoint retains earlier committed receipts',
  );
  assert.equal(
    snapshots,
    0,
    'small World writes must not checkpoint the whole store',
  );
  const saved = await f.code.readState(app, key);
  assert.equal(saved.value.records.length, 4);
  const keep = [saved.value.base, ...saved.value.records].reduce(
    (count, item) => count + item.parts,
    0,
  );
  assert.equal(
    (await f.code.stateKeys(app, '@ink:')).length,
    keep,
    'compaction removes unreachable payloads',
  );
  const portable = await f.code.loadCheckpoint(app, key);
  assert.equal(typeof portable.value.snapshot, 'string');
  await f.code.saveCheckpoint(app, key, portable.value, portable.revision);
  assert.equal(
    (await f.run('total', [])).output.result,
    36,
    'external checkpoint replacement invalidates resident state',
  );
});

test('a lost acknowledgement recovers its exact committed reply and rejects conflicting reuse', async (t) => {
  const f = await fixture(t);
  const batch = f.code.storage.batch;
  let lost = true;
  f.code.storage.batch = async (...args) => {
    const result = await batch(...args);
    if (lost && args[3].some((item) => item.key === key)) {
      lost = false;
      throw Error('Lost acknowledgement');
    }
    return result;
  };
  await assert.rejects(
    f.run('add', [7], { requestId: 'retry' }),
    /Lost acknowledgement/,
  );
  const retry = await f.run('add', [7], { requestId: 'retry' });
  assert.equal(retry.output.result, 7);
  assert.equal((await f.run('total', [])).output.result, 7);
  await assert.rejects(f.run('add', [8], { requestId: 'retry' }), {
    status: 409,
  });
  assert.equal((await f.run('total', [])).output.result, 7);
});

test('staged payloads are not committed state; a failed publication reloads the authoritative root', async (t) => {
  const f = await fixture(t);
  await f.run('add', [3]);
  const before = await f.code.readState(app, key),
    batch = f.code.storage.batch;
  let fail = true;
  f.code.storage.batch = async (...args) => {
    if (fail && args[3].some((item) => item.key === key)) {
      fail = false;
      throw Error('Publication failed');
    }
    return batch(...args);
  };
  await assert.rejects(f.run('add', [8]), /Publication failed/);
  assert.equal((await f.code.readState(app, key)).revision, before.revision);
  assert.equal((await f.run('total', [])).output.result, 3);
  assert.equal((await f.run('add', [8])).output.result, 11);
});

test('LRU eviction and restart replay committed actions without reconstructing on hot calls', async (t) => {
  const f = await fixture(t, { options: { limit: 1 } });
  await f.run('add', [4]);
  await f.code.run({
    source,
    entry: 'add',
    args: [9],
    namespace: copy,
    stateKey: key,
  });
  assert.equal(f.code.residents.sessions.size, 1);
  assert.equal((await f.run('total', [])).output.result, 4);
  assert.equal(f.code.residents.starts, 3);
  await f.code.close();
  const reopened = await new World(f.directory).open(),
    code = new Code('.', join(f.directory, 'code'), reopened);
  t.after(() => code.close());
  assert.equal(
    (
      await code.run({
        source,
        entry: 'total',
        args: [],
        namespace: app,
        stateKey: key,
      })
    ).output.result,
    4,
  );
});

test('corrupt payloads and deterministic replay mismatches fail closed', async (t) => {
  const f = await fixture(t);
  await f.run('add', [3]);
  const saved = await f.code.readState(app, key),
    descriptor = saved.value.records[0];
  const part = await f.code.readState(app, descriptor.id + ':0');
  await f.world.stateBatch(app, key, saved.revision, [
    {
      key: descriptor.id + ':0',
      value: part.value.replace('"input":"[3]"', '"input":"[4]"'),
    },
  ]);
  await f.code.residents.close();
  f.code.residents = new InkResidents();
  await assert.rejects(f.run('total', []), /integrity check/);
  const changed = part.value.replace('"input":"[3]"', '"input":"[4]"');
  saved.value.records[0].hash = hash(changed);
  saved.value.head = hash(changed);
  await f.world.stateBatch(app, key, saved.revision, [
    { key, value: saved.value },
  ]);
  await assert.rejects(f.run('total', []), /replay mismatch/);
});

test('collaborative namespace copies preserve opaque journal bytes and recover independently', async (t) => {
  const f = await fixture(t, { collaboration: true });
  await f.run('add', [6], { requestId: app });
  const doc = await f.collab.document(app, 'state', 'state');
  await f.collab.projectCommitted(doc);
  const prepared = forkData(appDataSnapshot(f.world, app), app, copy);
  for (const object of prepared.objects)
    await f.world.put(object, { writer: copy });
  await f.collab.copyNamespace(app, copy, prepared);
  const result = await f.code.run({
    source,
    entry: 'total',
    args: [],
    namespace: copy,
    stateKey: key,
  });
  assert.equal(result.output.result, 6);
  assert.equal((await f.run('add', [1])).output.result, 7);
  assert.equal(
    (
      await f.code.run({
        source,
        entry: 'total',
        args: [],
        namespace: copy,
        stateKey: key,
      })
    ).output.result,
    6,
  );
});

test('resident capacity remains bounded during simultaneous eviction and creation', async () => {
  const pool = new InkResidents({ limit: 1 });
  let release;
  const first = await pool.acquire('a', async () => ({
    close: () => new Promise((resolve) => (release = resolve)),
  }));
  pool.release(first);
  const creating = pool.acquire('b', async () => ({ close() {} }));
  await assert.rejects(
    pool.acquire('c', async () => ({ close() {} })),
    { status: 429 },
  );
  release();
  await creating;
  assert.equal(pool.sessions.size, 1);
  await pool.close();
});

test('World recovery validates chains, discards only a torn tail, and avoids full-store publication', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-world-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const world = await new World(directory).open();
  const object = await world.create({
    namespace: 'os',
    kind: 'note',
    title: 'first',
  });
  await world.persist();
  const checkpoint = await readFile(join(directory, 'world.json'));
  await world.update(object.id, { title: 'second' });
  assert.deepEqual(await readFile(join(directory, 'world.json')), checkpoint);
  await appendFile(join(directory, 'world.journal'), '{"sequence":');
  const reopened = await new World(directory).open();
  assert.equal(reopened.get(object.id).title, 'second');
  const bytes = await readFile(join(directory, 'world.journal'), 'utf8');
  assert.ok(bytes.endsWith('\n'));
  await writeFile(
    join(directory, 'world.journal'),
    bytes.replace('second', 'broken'),
  );
  await assert.rejects(new World(directory).open(), /integrity check/);
});

test('World exposes no tentative rows during fsync and rejects work after uncertain append failure', async (t) => {
  const f = await fixture(t);
  let release, entered;
  const blocked = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve)),
    append = f.world.journal.append.bind(f.world.journal);
  f.world.journal.append = async (record) => {
    entered();
    await blocked;
    return append(record);
  };
  const putting = f.world.create({
    id: copy,
    namespace: 'os',
    kind: 'note',
    title: 'durable',
  });
  await started;
  assert.equal(f.world.get(copy), null);
  release();
  await putting;
  assert.equal(f.world.get(copy).title, 'durable');
  f.world.journal.append = async () => {
    const error = Error('Uncertain sync');
    f.world.journal.error = error;
    throw error;
  };
  await assert.rejects(
    f.world.update(copy, { title: 'not published' }),
    /Uncertain sync/,
  );
  await assert.rejects(f.world.update(copy, { title: 'again' }), /unavailable/);
  const restored = await new World(f.directory).open();
  assert.equal(restored.get(copy).title, 'durable');
});

test('a process killed after durable publication recovers the receipt before re-executing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = fork(
    new URL('./fixtures/resident-crash.mjs', import.meta.url),
    [directory],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (bytes) => (stderr += bytes));
  const message = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw Error(stderr || 'Child exited before commit');
    }),
  ]);
  assert.equal(message[0], 'durable');
  child.kill('SIGKILL');
  await once(child, 'exit');
  const code = new Code('.', directory);
  t.after(() => code.close());
  const reply = await code.run({
    source,
    entry: 'add',
    args: [7],
    instance: 'one',
    requestId: 'crash',
  });
  assert.equal(reply.output.result, 7);
  assert.equal(
    (await code.run({ source, entry: 'total', args: [], instance: 'one' }))
      .output.result,
    7,
  );
});

test('activation waits for resident execution and fences its pending publication', async (t) => {
  const f = await fixture(t),
    old = 'c'.repeat(32),
    next = 'd'.repeat(32);
  await f.world.create({
    id: app,
    namespace: 'os',
    kind: 'app',
    body: JSON.stringify({ releaseId: old }),
  });
  for (const id of [old, next])
    await f.world.create({
      id,
      namespace: 'os',
      kind: 'release',
      body: JSON.stringify({ appId: app, runtimeAuth: 2 }),
    });
  const runtime = new RuntimeCredentials(f.directory, f.world),
    principal = runtime.bind({ appId: app, namespace: app, releaseId: old });
  let entered, release;
  const starting = new Promise((resolve) => (entered = resolve)),
    held = new Promise((resolve) => (release = resolve)),
    batch = f.code.storage.batch;
  f.code.storage.batch = async (...args) => {
    if (args[3].some((change) => change.key === key)) {
      entered();
      await held;
    }
    return batch(...args);
  };
  const change = f.run('add', [7], { principal });
  change.catch(() => {});
  await starting;
  let activated = false;
  const activation = runtime.activate(app, {}, async () => {
    await f.world.update(
      app,
      { body: JSON.stringify({ releaseId: next }) },
      { writer: 'os' },
    );
    activated = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(activated, false);
  release();
  await assert.rejects(change, { status: 409 });
  await activation;
  assert.equal((await f.code.readState(app, key)).value, null);
  await assert.rejects(f.run('total', [], { principal }), { status: 409 });
  const current = runtime.bind({ appId: app, namespace: app, releaseId: next });
  assert.equal(
    (await f.run('total', [], { principal: current })).output.result,
    0,
  );
});

test('checkpoint rotation recovers the pre-rotation prefix and refuses a missing required log', async (t) => {
  const f = await fixture(t);
  const item = await f.world.create({
    namespace: 'os',
    kind: 'note',
    title: 'before',
  });
  await f.world.update(item.id, { title: 'after' });
  const path = join(f.directory, 'world.journal'),
    prefix = await readFile(path);
  await f.world.persist();
  await writeFile(path, prefix);
  const recovered = await new World(f.directory).open();
  assert.equal(recovered.get(item.id).title, 'after');
  await recovered.update(item.id, { title: 'next' });
  const reopened = await new World(f.directory).open();
  assert.equal(reopened.get(item.id).title, 'next');
  await unlink(path);
  await assert.rejects(new World(f.directory).open(), /journal is missing/);
});

test('an uncertain append that reached disk recovers its mutation receipt without acknowledging tentative state', async (t) => {
  const f = await fixture(t),
    append = f.world.journal.append.bind(f.world.journal),
    mutationId = '00000000-0000-4000-8000-000000000000:1';
  f.world.journal.append = async (record) => {
    await append(record);
    const error = Error('Acknowledgement lost after sync');
    f.world.journal.error = error;
    throw error;
  };
  await assert.rejects(
    f.world.create(
      { id: copy, namespace: 'os', kind: 'note', title: 'once' },
      { mutationId },
    ),
    /Acknowledgement lost/,
  );
  const recovered = await new World(f.directory).open();
  assert.equal(recovered.get(copy).revision, 1);
  await recovered.put(
    { ...recovered.get(copy), title: 'duplicate' },
    { expected: 0, mutationId },
  );
  assert.equal(recovered.get(copy).title, 'once');
});

test('internal cancellation rejects before dispatch and releases the resident for subsequent calls', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  controller.abort(Error('fixture cancellation'));
  await assert.rejects(
    f.run('add', [99], { signal: controller.signal }),
    /fixture cancellation/,
  );
  assert.equal((await f.run('total', [])).output.result, 0);
  await assert.rejects(f.run('total', [], { signal: {} }), { status: 400 });
  assert.equal((await f.run('add', [1])).output.result, 1);
});
