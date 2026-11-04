import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Collaboration } from '../server/collaboration.mjs';
import { createMaintenanceHostAdapter } from '../server/maintenance-host.mjs';
import { platformRouter } from '../server/platform-router.mjs';
import { authorizeRoute } from '../server/api-keys.mjs';
import { requestJSON } from '../server/request-body.mjs';
import { createClient } from '../sdk/src/server.js';
import { createEffects, effectRequestId } from '../sdk/src/effects.js';
import { fixture, install, owner, until } from './ink-effects-fixture.mjs';

test('maintenance closes effect admission, tracks queued and active protocols, drains and checkpoints observations', async (t) => {
  const { platform: p, directory } = await fixture(t),
    { app } = await install(p, 'clock', {
      requestType: 'u32',
      requestExpression: 'effect_clock<Unit>("op",request)',
    });
  p.collaboration = new Collaboration({ directory, world: p.world });
  await p.collaboration.recover();
  t.after(() => p.collaboration.close());
  let closed = false;
  const adapter = createMaintenanceHostAdapter({
    platform: p,
    requests: new Set(),
    responses: new Set(),
    externalClosed: () => closed,
  });
  const run = await p.effects.start(
    app.id,
    { entry: 'begin', input: '[150]', backend: 'javascript' },
    owner,
  );
  closed = true;
  adapter.closeAdmission();
  await assert.rejects(
    p.effects.start(app.id, { entry: 'begin', input: '[0]' }, owner),
    { status: 503 },
  );
  assert.ok((await adapter.activity()).codeTasks > 0);
  assert.equal((await p.effects.wait(app.id, run.id, owner)).status, 'done');
  await until(async () =>
    Object.values(await adapter.activity()).every((n) => n === 0),
  );
  await adapter.flush();
  const saved = JSON.parse(
    await readFile(p.effects.directory + '/effects.json', 'utf8'),
  );
  assert.equal(saved.runs[0][1].status, 'done');
  closed = false;
  adapter.resumeAdmission();
  assert.equal(p.effects.accepting, true);
  p.effects.store.journal.error = Error('fixture');
  await assert.rejects(adapter.activity(), {
    code: 'MAINTENANCE_EFFECTS_UNREADY',
  });
  p.effects.store.journal.error = null;
});

test('effect SDK keeps caller-provided retry identity and route scopes require app invocation', async () => {
  const calls = [],
    client = createEffects(async (action, input) => {
      calls.push({ action, input });
      return { id: 'r' };
    }),
    id = effectRequestId();
  await client.start('begin', '[]', { requestId: id });
  await client.start('begin', '[]', { requestId: id });
  await client.get('r');
  await client.cancel('r');
  assert.equal(calls[0].input.requestId, calls[1].input.requestId);
  assert.match(id, /^\d+:.*-/);
  const principal = { owner: true, keyId: 'fixture', scopes: ['apps:read'] };
  assert.throws(
    () =>
      authorizeRoute(
        principal,
        '/apps/' + 'a'.repeat(32) + '/ink/effects',
        'POST',
      ),
    { status: 403 },
  );
  principal.scopes = ['apps:invoke'];
  assert.doesNotThrow(() =>
    authorizeRoute(
      principal,
      '/apps/' + 'a'.repeat(32) + '/ink/effects/' + 'b'.repeat(32),
      'GET',
    ),
  );
});

test('server SDK can start, inspect, cancel and run installed typed protocols through authenticated routes', async (t) => {
  const { platform: p } = await fixture(t),
    { app } = await install(p, 'clock', {
      requestType: 'u32',
      requestExpression: 'effect_clock<Unit>("op",request)',
    });
  const s = createServer(async (req, res) => {
    try {
      const send = (res, status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      await platformRouter(p, { send, body: requestJSON })(
        req,
        res,
        new URL(req.url, 'http://localhost'),
        owner,
      );
    } catch (error) {
      res.writeHead(error.status || 500, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => s.close(resolve)));
  const client = createClient({
      url: 'http://127.0.0.1:' + s.address().port,
      token: 'fixture',
    }),
    effects = client.apps.ink.effects(app.id),
    start = await effects.start('begin', '[1000]', { backend: 'javascript' });
  assert.ok(start.id);
  const status = await effects.get(start.id);
  assert.equal(status.appId, app.id);
  await effects.cancel(start.id);
  assert.equal(
    (await p.effects.wait(app.id, start.id, owner)).status,
    'cancelled',
  );
  const value = await client.apps.ink.run(app.id, 'begin', '[0]', {
    backend: 'javascript',
  });
  assert.equal(value.effectRun.status, 'done');
  assert.ok(value.value.clock.Some.unixMs > 0);
});

test('generated commands execute typed protocols and retain a supplied retry identity', async (t) => {
  const { runCommand } = await import('../server/app-commands.mjs');
  const { platform: p } = await fixture(t),
    { app } = await install(p, 'clock', {
      requestType: 'u32',
      requestExpression: 'effect_clock<Unit>("op",request)',
    }),
    requestId = effectRequestId();
  const input = {
    appId: app.id,
    id: 'ink.begin',
    input: { arg0: '0' },
    requestId,
  };
  const first = await runCommand(p, owner, input),
    second = await runCommand(p, owner, input);
  assert.equal(first.data.effectRun.id, second.data.effectRun.id);
  assert.equal(first.data.valueWire, second.data.valueWire);
});
