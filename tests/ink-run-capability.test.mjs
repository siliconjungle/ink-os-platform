import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, file, owner } from './ink-effects-fixture.mjs';
import { buildInkApp } from '../server/ink-apps.mjs';
import { platformRouter } from '../server/platform-router.mjs';

const SOURCE = 'module app; state N:u64=0; change bump()->u64 reads(N) writes(N){N=N+1;return N;} query total()->u64 reads(N){return N;}';

// The app's own token reaches its Ink code only while the app holds
// code.execute; the owner is not limited by the app's grants.
test('ink/run and code/run require the app to hold code.execute', async (t) => {
  const { platform } = await fixture(t);
  const install = async (capabilities) => {
    const bundle = { ...(await buildInkApp({ slug: 'run-' + crypto.randomUUID().slice(0, 8), language: 'ink', exports: ['bump', 'total'] }, [file('main.ink', SOURCE)])), capabilities },
      app = await platform.createApp({ slug: bundle.slug || 'run-' + crypto.randomUUID().slice(0, 8), capabilities }),
      release = await platform.createRelease(app.id, bundle);
    await platform.publish(app.id, release.id);
    return { app, release, principal: { owner: false, appId: app.id, namespace: app.id, releaseId: release.id } };
  };
  const route = async (appId, action, payload, principal) => {
    let reply;
    const send = (_res, status, value) => (reply = { status, value });
    try {
      await platformRouter(platform, { send, body: async () => payload })(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/v1/apps/' + appId + '/' + action),
        principal,
      );
    } catch (error) {
      reply = { status: error.status || 500, value: { error: error.message } };
    }
    return reply;
  };
  const granted = await install(['code.execute', 'world.read', 'world.write']),
    revoked = await install(['world.read', 'world.write']);
  assert.equal((await route(granted.app.id, 'ink/run', { entry: 'bump', input: '[]' }, granted.principal)).status, 200);
  for (const [action, payload] of [
    ['ink/run', { entry: 'bump', input: '[]' }],
    ['code/run', { source: SOURCE, entry: 'bump', input: '[]' }],
  ]) {
    const denied = await route(revoked.app.id, action, payload, revoked.principal);
    assert.equal(denied.status, 403, action + ': ' + JSON.stringify(denied.value));
    assert.match(denied.value.error, /Ink execution not granted/);
  }
  assert.equal((await route(revoked.app.id, 'ink/run', { entry: 'total', input: '[]' }, owner)).status, 200, 'the owner is not limited');
});
