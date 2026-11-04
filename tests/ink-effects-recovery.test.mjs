import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { InkEffects } from '../server/ink-effects.mjs';
import { EffectSubscriptions } from '../server/ink-effect-subscriptions.mjs';
import { effectPolicy } from '../server/ink-effects-policy.mjs';
import {
  fixture,
  install,
  owner,
  until,
  call,
  some,
  none,
} from './ink-effects-fixture.mjs';
const request = {
  method: 'POST',
  path: '/',
  body: some('change'),
  bytes: none(),
  expected: none(),
};
for (const mode of ['dispatch', 'observed'])
  test(
    'SIGKILL ' +
      mode +
      ' recovery never repeats an unreceipted write and reuses durable observations',
    async (t) => {
      let hits = 0;
      const server = createServer((req, res) => {
        hits++;
        req.resume();
        if (mode === 'observed') res.end('committed');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(
        () =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      );
      const policy = {
          version: 1,
          resources: {
            test: {
              kind: 'http',
              namespaces: ['*'],
              origin: 'http://127.0.0.1:' + server.address().port,
              pathPrefix: '/',
              methods: ['POST'],
            },
          },
        },
        f = await fixture(t, { policy, allowHttp: true, autoStart: false }),
        p = f.platform,
        { app } = await install(p, 'http', {
          effect: 'write',
          deadlineMs: 15000,
        });
      p.effects.accepting = true;
      const start = await p.effects.start(
        app.id,
        {
          entry: 'begin',
          input: JSON.stringify([request]),
          backend: 'javascript',
        },
        owner,
      );
      p.effects.queue.clear();
      p.effects.closing = true;
      await p.effects.store.tail;
      let observed = false;
      const child = fork(
        new URL('./fixtures/effects-crash.mjs', import.meta.url),
        [f.directory, JSON.stringify(policy), mode],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      let errors = '';
      child.stderr.on('data', (data) => (errors += data));
      child.on('message', (message) => {
        if (message.observed) observed = true;
      });
      t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });
      await until(() => {
        if (child.exitCode !== null) throw Error(errors);
        return mode === 'dispatch' ? hits === 1 : observed;
      }, 10000);
      child.kill('SIGKILL');
      await once(child, 'exit');
      p.effects = await new InkEffects({
        platform: p,
        policy,
        allowHttp: true,
      }).open();
      const done = await p.effects.wait(app.id, start.id, owner);
      assert.equal(done.status, 'done', JSON.stringify(done));
      assert.equal(hits, 1);
      if (mode === 'dispatch') {
        assert.equal(done.value.error.Some.code, 'Interrupted');
        assert.equal(done.value.error.Some.certainty, 'unknown');
        assert.equal(done.cancellation.mayHaveTakenEffect, true);
      } else assert.equal(done.value.http.Some.body.Some, 'committed');
    },
  );

test('recovery can observe a declared HTTP read again without changing operation sequence', async (t) => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.end('new observation');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const policy = {
      version: 1,
      resources: {
        test: {
          kind: 'http',
          namespaces: ['*'],
          origin: 'http://127.0.0.1:' + server.address().port,
          pathPrefix: '/',
          methods: ['GET'],
        },
      },
    },
    f = await fixture(t, { policy, allowHttp: true }),
    p = f.platform,
    { app } = await install(p, 'http', { retry: 'observe-again' });
  const first = await call(p, app, { ...request, method: 'GET', body: none() });
  assert.equal(first.status, 'done');
  const saved = p.effects.store.read(first.id);
  // Construct the precise durable phase that a crash can leave, retaining its checked pending request.
  const requestWire = JSON.stringify({
    Err: {
      state: null,
      request: {
        operation: 'op',
        http: some({ ...request, method: 'GET', body: none() }),
        file: none(),
        clock: none(),
        random: none(),
        process: none(),
        subscription: none(),
        app: none(),
      },
    },
  });
  await p.effects.store.update(first.id, () => ({
    ...saved,
    status: 'running',
    phase: 'dispatching',
    pendingWire: requestWire,
    valueWire: undefined,
    replyWire: null,
    attempt: 1,
    sequence: 1,
    deadlineAt: Date.now() + 5000,
  }));
  await p.effects.store.persist();
  p.effects = await new InkEffects({
    platform: p,
    policy,
    allowHttp: true,
  }).open();
  const result = await p.effects.wait(app.id, first.id, owner);
  assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(result.sequence, 1);
  assert.equal(result.lastEffect.attempt, 2);
  assert.equal(hits, 2);
});

test('file journal recovers committed changes and observations together, truncates torn tails and rejects tampering', async (t) => {
  const f = await fixture(t),
    p = f.platform,
    { app } = await install(p, 'file');
  const done = await call(p, app, {
    action: 'write',
    name: 'note',
    value: some('x'),
    bytes: none(),
    expected: some(0),
  });
  await p.effects.close();
  await appendFile(p.effects.store.journal.path, '{"torn":');
  p.effects = await new InkEffects({ platform: p }).open();
  assert.equal(p.effects.get(app.id, done.id, owner).valueWire, done.valueWire);
  assert.equal([...p.effects.store.files.values()][0].version, 1);
  await p.effects.close();
  const checkpoint = p.effects.directory + '/effects.json',
    saved = await readFile(checkpoint, 'utf8');
  await writeFile(checkpoint, saved.replace('"version":1', '"version":2'));
  await assert.rejects(new InkEffects({ platform: p }).open(), /integrity/);
  await writeFile(checkpoint, saved);
});

test('World subscriptions share one listener, isolate namespaces and handles, and signal restart or overflow gaps', async (t) => {
  const { platform: p } = await fixture(t),
    subs = new EffectSubscriptions(p.world),
    a = {
      id: 'one',
      appId: 'a'.repeat(32),
      releaseId: 'r',
      deadlineAt: Date.now() + 10000,
    },
    b = { ...a, id: 'two' },
    before = p.world.listeners.size,
    x = subs.open(a),
    y = subs.open(b);
  assert.equal(p.world.listeners.size, before + 1);
  assert.throws(() => subs.close(b, x.handle), { effectCode: 'Gap' });
  await p.world.create({ namespace: 'other', kind: 'note', body: 'hidden' });
  assert.equal(subs.handles.get(x.handle).queue.length, 0);
  const note = await p.world.create({
    namespace: a.appId,
    kind: 'note',
    body: 'visible',
  });
  const event = await subs.next(a, x.handle, new AbortController().signal);
  assert.equal(event.event.Some.id, note.id);
  const waiting = subs.next(b, y.handle, new AbortController().signal);
  assert.equal((await waiting).event.Some.id, note.id);
  subs.release(a.id);
  assert.throws(() => subs.owned(a, x.handle), { effectCode: 'Gap' });
  assert.equal(p.world.listeners.size, before + 1);
  for (let i = 0; i < 130; i++)
    for (const fn of p.world.listeners)
      fn({
        type: 'object',
        version: i,
        object: { id: String(i), namespace: a.appId },
      });
  await assert.rejects(subs.next(b, y.handle, new AbortController().signal), {
    effectCode: 'Gap',
  });
  subs.shutdown();
  assert.equal(p.world.listeners.size, before);
});

test('resource policy denies insecure origins and mutable process identities, and crash recovery fences policy changes', async (t) => {
  await assert.rejects(
    effectPolicy({
      version: 1,
      resources: {
        test: {
          kind: 'http',
          origin: 'http://remote.invalid',
          namespaces: ['*'],
          methods: ['GET'],
          pathPrefix: '/',
        },
      },
    }),
    /secure origin/,
  );
  const f = await fixture(t, { autoStart: false }),
    p = f.platform,
    { app } = await install(p, 'clock', {
      requestType: 'u32',
      requestExpression: 'effect_clock<Unit>("op",request)',
    });
  p.effects.accepting = true;
  const run = await p.effects.start(
    app.id,
    { entry: 'begin', input: '[0]' },
    owner,
  );
  p.effects.queue.clear();
  p.effects.closing = true;
  p.effects = await new InkEffects({
    platform: p,
    policy: {
      version: 1,
      resources: {
        changed: {
          kind: 'process',
          namespaces: ['*'],
          executable: process.execPath,
          args: [],
        },
      },
    },
  }).open();
  const result = await p.effects.wait(app.id, run.id, owner);
  assert.equal(result.status, 'fenced');
  assert.equal(result.error.code, 'Fenced');
});

test('a process supervisor kills its ordinary child group when the broker is SIGKILLed', async (t) => {
  const f = await fixture(t, { autoStart: false }),
    p = f.platform,
    marker = f.directory + '/process-pid',
    policy = {
      version: 1,
      resources: {
        test: {
          kind: 'process',
          namespaces: ['*'],
          executable: process.execPath,
          args: [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',
            marker,
          ],
        },
      },
    };
  // Reload the policy before admission; process profiles are private host grants.
  p.effects = await new InkEffects({
    platform: p,
    policy,
    autoStart: false,
  }).open();
  const { app } = await install(p, 'process', { deadlineMs: 15000 });
  p.effects.accepting = true;
  const start = await p.effects.start(
    app.id,
    {
      entry: 'begin',
      input: JSON.stringify([{ input: some(''), bytes: none() }]),
      backend: 'javascript',
    },
    owner,
  );
  p.effects.queue.clear();
  p.effects.closing = true;
  const child = fork(
    new URL('./fixtures/effects-crash.mjs', import.meta.url),
    [f.directory, JSON.stringify(policy), 'dispatch'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let errors = '';
  child.stderr.on('data', (data) => (errors += data));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const pid = await until(async () => {
    if (child.exitCode !== null) throw Error(errors);
    try {
      return Number(await readFile(marker, 'utf8'));
    } catch {
      return false;
    }
  }, 10000);
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  });
  child.kill('SIGKILL');
  await once(child, 'exit');
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000);
  p.effects = await new InkEffects({ platform: p, policy }).open();
  const done = await p.effects.wait(app.id, start.id, owner);
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(done.value.error.Some.code, 'Interrupted');
  assert.equal(done.value.error.Some.certainty, 'unknown');
});
