import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildInkApp, runInstalledInk } from '../server/ink-apps.mjs';
import { InkPreviews } from '../server/ink-previews.mjs';
import { parseExactJSON } from '../shared/exact-json.mjs';
import { effectTypeEqual, inkEffects } from '../shared/ink-effects.mjs';
import {
  fixture,
  install,
  protocol,
  owner,
  call,
  none,
  some,
  until,
} from './ink-effects-fixture.mjs';
const reply = (run) => {
  assert.equal(run.status, 'done', JSON.stringify(run));
  return parseExactJSON(run.valueWire);
};
const requestId = () => Date.now() + ':' + crypto.randomUUID();
const fileRequest = (
  action = 'write',
  value = 'hello',
  expected = 0,
  name = 'notes/a',
) => ({
  action,
  name,
  value: action === 'write' ? some(value) : none(),
  bytes: none(),
  expected: expected === null ? none() : some(expected),
});
const httpRequest = (
  path = '/',
  method = 'GET',
  body = none(),
  expected = none(),
) => ({ method, path, body, bytes: none(), expected });
async function server(t, listener) {
  const s = createServer(listener);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        s.closeAllConnections();
        s.close(resolve);
      }),
  );
  return 'http://127.0.0.1:' + s.address().port;
}

test('checked protocols bind finite request/reply types, capabilities and private continuations to release plans', async () => {
  const p = protocol('file'),
    bundle = await buildInkApp(p.manifest, p.files),
    meta = JSON.parse(
      Buffer.from(
        bundle.files.find((f) => f.path === 'app.json').base64,
        'base64',
      ),
    );
  assert.equal(bundle.ink.version, 3);
  assert.ok(bundle.ink.implementation);
  assert.equal(meta.entries.length, 1);
  assert.equal(meta.entries[0].result.kind, 'record');
  assert.equal(bundle.commands[0].effect, 'write');
  assert.equal(bundle.commands[0].idempotent, false);
  await assert.rejects(
    buildInkApp({ ...p.manifest, capabilities: [] }, p.files),
    /effects.files/,
  );
  await assert.rejects(
    buildInkApp({ ...p.manifest, exports: ['begin', 'resume'] }, p.files),
    /private pure/,
  );
  const bad = structuredClone(p.manifest);
  bad.effects.protocols[0].operations[0].retry = 'observe-again';
  assert.throws(() => inkEffects(bad.effects), /classification/);
  assert.equal(
    effectTypeEqual(
      { kind: 'vector', length: 2, element: { kind: 'u32' } },
      { element: { kind: 'u32' }, length: 3, kind: 'vector' },
    ),
    false,
  );
  assert.equal(
    effectTypeEqual(
      { element: { kind: 'u32' }, kind: 'option' },
      { kind: 'option', element: { kind: 'u32' } },
    ),
    true,
  );
  const changed = p.files.map((f) =>
    f.path === 'effects.ink'
      ? {
          ...f,
          base64: Buffer.from(
            Buffer.from(f.base64, 'base64')
              .toString()
              .replace('sequence:u32', 'sequence:String'),
          ).toString('base64'),
        }
      : f,
  );
  await assert.rejects(
    buildInkApp(p.manifest, changed),
    /typed effect boundary/,
  );
});

test('virtual file CAS and reply commit atomically, receipts deduplicate across restart, and small edits append bounded work', async (t) => {
  const f = await fixture(t),
    p = f.platform,
    { app } = await install(p, 'file'),
    id = requestId();
  const before = p.world.version;
  const first = await call(p, app, fileRequest(), { requestId: id });
  assert.equal(reply(first).file.Some.value.Some, 'hello');
  assert.equal(reply(first).file.Some.version, 1n);
  assert.equal(p.world.version, before);
  assert.equal(
    (await call(p, app, fileRequest(), { requestId: id })).valueWire,
    first.valueWire,
  );
  await assert.rejects(
    call(p, app, fileRequest('write', 'different'), { requestId: id }),
    { status: 409 },
  );
  const conflict = reply(await call(p, app, fileRequest('write', 'wrong', 0)));
  assert.equal(conflict.error.Some.code, 'Conflict');
  assert.equal(conflict.error.Some.certainty, 'not-applied');
  const stored = reply(await call(p, app, fileRequest('read', null, null)));
  assert.equal(stored.file.Some.value.Some, 'hello');
  const bad = reply(
    await call(p, app, fileRequest('write', 'evil', 0, '../outside')),
  );
  assert.equal(bad.error.Some.code, 'Denied');
  const journal = await readFile(p.effects.store.journal.path, 'utf8');
  assert.ok(journal.length < 80000);
  assert.ok(p.effects.store.files.size === 1);
  await p.effects.close();
  await p.code.close();
  const restarted = await f.open();
  assert.equal(
    (await call(restarted, app, fileRequest(), { requestId: id })).valueWire,
    first.valueWire,
  );
  assert.equal(
    reply(await call(restarted, app, fileRequest('write', 'new', 1))).file.Some
      .version,
    2n,
  );
  const other = await install(restarted, 'file');
  assert.equal(
    reply(await call(restarted, other.app, fileRequest('read', null, null)))
      .file.Some.exists,
    false,
  );
});

test('clock and random samples are recorded once, request IDs are finite-lived and caller identity is enforced', async (t) => {
  const { platform: p } = await fixture(t),
    clock = await install(p, 'clock', {
      requestType: 'u32',
      requestExpression: 'effect_clock<Unit>("op",request)',
    }),
    random = await install(p, 'random', {
      requestType: 'u32',
      requestExpression: 'effect_random<Unit>("op",request)',
    }),
    id = requestId();
  const a = await call(p, random.app, 32, { requestId: id }),
    bytes = reply(a).random.Some.bytes;
  assert.equal(bytes.length, 32);
  assert.ok(bytes.every((x) => x >= 0n && x <= 255n));
  assert.equal(
    (await call(p, random.app, 32, { requestId: id })).valueWire,
    a.valueWire,
  );
  assert.equal(
    reply(await call(p, random.app, 1025)).error.Some.code,
    'Denied',
  );
  assert.ok(reply(await call(p, clock.app, 0)).clock.Some.unixMs > 0n);
  await assert.rejects(
    p.effects.start(
      clock.app.id,
      {
        entry: 'begin',
        input: '[0]',
        requestId: Date.now() - 86400001 + ':' + crypto.randomUUID(),
      },
      owner,
    ),
    { status: 410 },
  );
  assert.throws(
    () => p.effects.get(random.app.id, a.id, { appId: clock.app.id }),
    { status: 403 },
  );
  assert.throws(
    () =>
      p.effects.get(random.app.id, a.id, { owner: true, accountId: 'other' }),
    { status: 403 },
  );
  p.effects.closeAdmission();
  await assert.rejects(call(p, clock.app, 0), { status: 503 });
  p.effects.resumeAdmission();
});

test('HTTP profiles retain methods, ETags and binary values, reject path escapes, and never follow redirects', async (t) => {
  let hits = 0,
    headers;
  const origin = await server(t, (req, res) => {
    hits++;
    headers = req.headers;
    if (req.url === '/api/redirect') {
      res.writeHead(302, { location: '/secret' });
      return res.end();
    }
    res.setHeader('etag', '"v1"');
    res.end(Buffer.from([0, 255, 3]));
  });
  const { platform: p } = await fixture(t, {
      allowHttp: true,
      policy: {
        version: 1,
        resources: {
          test: {
            kind: 'http',
            namespaces: ['*'],
            origin,
            pathPrefix: '/api',
            methods: ['GET', 'PUT'],
            requireVersion: true,
          },
        },
      },
    }),
    { app } = await install(p, 'http', { effect: 'write' });
  const first = reply(await call(p, app, httpRequest('/api/item')));
  assert.equal(first.http.Some.status, 200n);
  assert.deepEqual(first.http.Some.bytes, [0n, 255n, 3n]);
  assert.deepEqual(first.http.Some.body, none());
  assert.equal(first.version.Some, '"v1"');
  const noVersion = reply(
    await call(p, app, httpRequest('/api/item', 'PUT', some('write'))),
  );
  assert.equal(noVersion.error.Some.code, 'Conflict');
  assert.equal(hits, 1);
  reply(
    await call(
      p,
      app,
      httpRequest('/api/item', 'PUT', some('write'), some('"v1"')),
    ),
  );
  assert.equal(headers['if-match'], '"v1"');
  // Writes carry an idempotency key fixed by the run and step; reads do not.
  assert.match(headers['idempotency-key'], /^[a-f0-9]{32}$/);
  const firstKey = headers['idempotency-key'];
  reply(await call(p, app, httpRequest('/api/item', 'PUT', some('write'), some('"v1"'))));
  assert.notEqual(headers['idempotency-key'], firstKey, 'another run has another key');
  reply(await call(p, app, httpRequest('/api/item')));
  assert.equal(headers['idempotency-key'], undefined);
  for (const path of [
    '//evil.invalid/api',
    '/api/../secret',
    '/api/%2f..%2fsecret',
    '/api/%252e%252e/secret',
    '/api2/item',
  ])
    assert.equal(
      reply(await call(p, app, httpRequest(path))).error.Some.code,
      'Denied',
    );
  const before = hits;
  assert.equal(
    reply(await call(p, app, httpRequest('/api/redirect'))).http.Some.status,
    302n,
  );
  assert.equal(hits, before + 1);
  const read = await install(p, 'http', { effect: 'read' });
  assert.equal(
    reply(
      await call(
        p,
        read.app,
        httpRequest('/api/item', 'PUT', some('write'), some('"v1"')),
      ),
    ).error.Some.code,
    'Denied',
  );
});

test('HTTP cancellation preserves unknown write outcome, closes transport and reuses the recorded receipt', async (t) => {
  let hits = 0;
  const origin = await server(t, (req, res) => {
    hits++;
    req.resume();
  });
  const { platform: p } = await fixture(t, {
      allowHttp: true,
      policy: {
        version: 1,
        resources: {
          test: {
            kind: 'http',
            namespaces: ['*'],
            origin,
            pathPrefix: '/',
            methods: ['POST'],
          },
        },
      },
    }),
    { app } = await install(p, 'http', { effect: 'write' }),
    id = requestId(),
    start = await p.effects.start(
      app.id,
      {
        entry: 'begin',
        input: JSON.stringify([httpRequest('/', 'POST', some('change'))]),
        requestId: id,
        backend: 'javascript',
      },
      owner,
    );
  await until(() => hits === 1);
  await p.effects.cancel(app.id, start.id, owner);
  const done = await p.effects.wait(app.id, start.id, owner);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.cancellation.mayHaveTakenEffect, true);
  assert.equal(done.lastEffect.error.certainty, 'unknown');
  assert.equal(done.observation.error.Some.certainty, 'unknown');
  assert.equal(
    (
      await p.effects.start(
        app.id,
        {
          entry: 'begin',
          input: JSON.stringify([httpRequest('/', 'POST', some('change'))]),
          requestId: id,
        },
        owner,
      )
    ).status,
    'cancelled',
  );
  assert.equal(hits, 1);
});

test('fixed process profiles stream bounded typed input/output and do not inherit host environment', async (t) => {
  process.env.INK_EFFECT_TEST_SECRET = 'fixture-only';
  t.after(() => delete process.env.INK_EFFECT_TEST_SECRET);
  const { platform: p } = await fixture(t, {
      policy: {
        version: 1,
        resources: {
          test: {
            kind: 'process',
            namespaces: ['*'],
            executable: process.execPath,
            args: [
              '-e',
              "process.stdin.on('data',d=>process.stdout.write(d));process.stdin.on('end',()=>process.stderr.write(String(process.env.INK_EFFECT_TEST_SECRET||'absent')))",
            ],
          },
        },
      },
    }),
    { app } = await install(p, 'process');
  const result = reply(
    await call(p, app, { input: some('hello'), bytes: none() }),
  );
  assert.equal(result.process.Some.stdout.Some, 'hello');
  assert.equal(result.process.Some.stderr.Some, 'absent');
  assert.equal(result.process.Some.exitCode, 0n);
  const denied = await fixture(t);
  const target = await install(denied.platform, 'process');
  assert.equal(
    reply(
      await call(denied.platform, target.app, {
        input: some('x'),
        bytes: none(),
      }),
    ).error.Some.code,
    'Denied',
  );
});

test('direct app effects check the pinned ABI before dispatch and pass caller identity through typed input', async (t) => {
  const { platform: p } = await fixture(t),
    targetSource =
      'module target;record Actor{appId:String,releaseId:String,}fn echo(actor:Actor,value:String)->String{return actor.appId;}',
    bundle = await buildInkApp(
      { slug: 'target', language: 'ink', exports: ['echo'] },
      [
        {
          path: 'main.ink',
          base64: Buffer.from(targetSource).toString('base64'),
        },
      ],
    ),
    target = await p.createApp({
      slug: 'target',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(target.id, bundle);
  await p.publish(target.id, release.id);
  const { app } = await install(p, 'app', {
    appInput: 'String',
    appOutput: 'String',
    resource: { appId: target.id, releaseId: release.id, entry: 'echo' },
  });
  assert.equal(reply(await call(p, app, 'hi')).app.Some, app.id);
  const wrong = await install(p, 'app', {
    appInput: 'String',
    appOutput: 'u32',
    resource: { appId: target.id, releaseId: release.id, entry: 'echo' },
  });
  assert.equal(
    reply(await call(p, wrong.app, 'hi')).error.Some.code,
    'TypeMismatch',
  );
  const next = await p.createRelease(target.id, {
    ...bundle,
    files: bundle.files.map((f) =>
      f.path === 'index.html'
        ? {
            ...f,
            base64: Buffer.from(
              Buffer.from(f.base64, 'base64').toString() + ' ',
            ).toString('base64'),
          }
        : f,
    ),
  });
  await p.publish(target.id, next.id);
  assert.equal(
    reply(await call(p, app, 'hi')).error.Some.certainty,
    'not-applied',
  );
});

test('effect protocols cannot execute through unpublished disposable previews', async (t) => {
  const { platform: p } = await fixture(t),
    source = protocol('random', {
      requestType: 'u32',
      requestExpression: 'effect_random<Unit>("op",request)',
    }),
    preview = new InkPreviews({ platform: p }),
    draft = await preview.create(owner, {
      files: [
        ...source.files,
        {
          path: 'ink-app.json',
          base64: Buffer.from(JSON.stringify(source.manifest)).toString(
            'base64',
          ),
        },
      ],
    });
  await assert.rejects(
    preview.run(draft.id, owner, { entry: 'begin', input: '[2]' }),
    { status: 403 },
  );
  assert.equal(p.effects.store.runs.size, 0);
});

test('the shipped all-Ink example sequences a recorded sample and versioned file write', async (t) => {
  const { platform: p } = await fixture(t),
    root = new URL('../examples/typed-effects/', import.meta.url),
    manifest = JSON.parse(await readFile(new URL('ink-app.json', root))),
    files = await Promise.all(
      ['main.ink', 'effects.ink'].map(async (path) => ({
        path,
        base64: (await readFile(new URL(path, root))).toString('base64'),
      })),
    ),
    bundle = await buildInkApp(manifest, files),
    app = await p.createApp({
      slug: manifest.slug,
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  const result = await runInstalledInk(
    p,
    app.id,
    {
      entry: 'save_nonce',
      input: '["nonce",0]',
      backend: 'javascript',
      requestId: requestId(),
    },
    owner,
  );
  assert.equal(result.effectRun.sequence, 2);
  assert.equal(result.value.file.Some.bytes.length, 16);
  assert.equal(result.value.file.Some.version, 1);
  assert.equal(p.effects.subscriptions.handles.size, 0);
  assert.equal(
    await readFile(new URL('../sdk/ink/effects.ink', import.meta.url), 'utf8'),
    await readFile(new URL('effects.ink', root), 'utf8'),
  );
});

test('a per-operation deadline is a typed timeout while cancelling a completed run preserves its result', async (t) => {
  const f = await fixture(t),
    p = f.platform,
    source = protocol('clock', {
      requestType: 'u32',
      requestExpression: 'effect_clock<Unit>("op",request)',
    });
  source.manifest.effects.protocols[0].operations[0].deadlineMs = 10;
  const bundle = await buildInkApp(source.manifest, source.files),
    app = await p.createApp({
      slug: 'timeout',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  const timed = await call(p, app, 100);
  assert.equal(reply(timed).error.Some.code, 'Timeout');
  const after = await p.effects.cancel(app.id, timed.id, owner);
  assert.equal(after.status, 'done');
  assert.equal(after.valueWire, timed.valueWire);
  assert.equal(after.cancellation.requested, false);
});

test('real Ink protocols share World transport, resume with typed events and release subscription lifetimes', async (t) => {
  const f = await fixture(t),
    p = f.platform,
    source =
      'module app;fn begin(request:Unit)->Result<EffectReply<Unit>,EffectPending<String,Unit>>{return Err(EffectPending<String,Unit>{state:"",request:effect_subscription<Unit>("op","open",None)});}fn resume(state:String,reply:EffectReply<Unit>)->Result<EffectReply<Unit>,EffectPending<String,Unit>>{if(state==""){return reply.subscription.fold(fn(value)=>Err(EffectPending<String,Unit>{state:value.handle,request:effect_subscription<Unit>("op","next",Some(value.handle))}),fn(none)=>Ok(reply));}return Ok(reply);}',
    { app } = await install(p, 'subscription', { source }),
    before = p.world.listeners.size;
  const starts = await Promise.all(
    [1, 2].map(() =>
      p.effects.start(
        app.id,
        { entry: 'begin', input: '[null]', backend: 'javascript' },
        owner,
      ),
    ),
  );
  await until(
    () =>
      p.effects.subscriptions.handles.size === 2 &&
      [...p.effects.subscriptions.handles.values()].every((h) => h.wake),
  );
  assert.equal(p.world.listeners.size, before + 1);
  const note = await p.world.create({
    namespace: app.id,
    kind: 'note',
    body: 'event',
  });
  for (const start of starts) {
    const done = await p.effects.wait(app.id, start.id, owner);
    assert.equal(reply(done).subscription.Some.event.Some.id, note.id);
    assert.equal(done.sequence, 2);
  }
  await until(() => p.effects.subscriptions.handles.size === 0);
  assert.equal(p.world.listeners.size, before);
});
