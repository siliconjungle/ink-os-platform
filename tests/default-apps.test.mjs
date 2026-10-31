import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../server/world.mjs';
import { Storage } from '../server/storage.mjs';
import { Platform } from '../server/platform.mjs';
import { LocalProvider } from '../infra/local-provider.mjs';
import { installDefaultApps } from '../server/default-apps.mjs';
import { distributionApps } from '../shared/distribution-apps.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-default-apps-'));
  const world = await new World(directory).open();
  const storage = await new Storage(directory, { env: {} }).open();
  const provider = new LocalProvider();
  const platform = await new Platform({ root, directory, world, storage, provider, origin: 'http://127.0.0.1:4318', adminToken: 'synthetic-default-app-test' }).open();
  t.after(async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); });
  return platform;
}

test('fresh instances install exactly three usable default apps and preserve removals and edits', async t => {
  const platform = await fixture(t);
  await installDefaultApps(platform, { fresh: true });
  const apps = platform.apps();
  assert.deepEqual(apps.map(app => JSON.parse(app.body).slug).sort(), ['finder', 'ink-environment', 'preview']);
  assert.equal(distributionApps(apps).length, 3);
  for (const app of apps) {
    const meta = JSON.parse(app.body), bundle = await platform.bundle(meta.releaseId);
    assert.equal(bundle.backend, null);
    assert.match(bundle.source.commit, /^[a-f0-9]{40}$/);
    assert.ok(bundle.files.some(file => file.path === 'ink-commands.mjs'));
    const ticket = await platform.launch(app.id);
    const redirect = await fetch(ticket.url, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const headers = { Cookie: redirect.headers.get('set-cookie').split(';')[0] };
    const response = await fetch(ticket.origin, { headers });
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const [, path] of html.matchAll(/(?:src|href)="([^"#]+\.(?:m?js|css|svg))"/g)) {
      if (/^https?:/.test(path)) continue;
      assert.equal((await fetch(new URL(path, ticket.origin), { headers })).status, 200, meta.slug + ': ' + path);
    }
  }
  const preview = apps.find(app => JSON.parse(app.body).slug === 'preview');
  const finder = apps.find(app => JSON.parse(app.body).slug === 'finder');
  await platform.world.update(preview.id, { archived: true }, { writer: 'os' });
  await platform.world.update(finder.id, { title: 'My files' }, { writer: 'os' });
  const count = platform.world.all().length;
  await installDefaultApps(platform, { fresh: false });
  assert.equal(platform.world.all().length, count);
  assert.equal(platform.world.get(preview.id).archived, true);
  assert.equal(platform.world.get(finder.id).title, 'My files');
  const reopened = await new World(platform.directory).open();
  assert.equal(reopened.get(preview.id).archived, true);
  assert.equal(reopened.get(finder.id).title, 'My files');
});

test('an interrupted first installation resumes the same releases without duplicating apps', async t => {
  const platform = await fixture(t), publish = platform.publish.bind(platform);
  let interrupted = false;
  platform.publish = async (appId, releaseId) => {
    if (!interrupted && JSON.parse(platform.app(appId).body).slug === 'preview') { interrupted = true; throw Error('Synthetic publication interruption'); }
    return publish(appId, releaseId);
  };
  await assert.rejects(installDefaultApps(platform, { fresh: true }), /Synthetic publication interruption/);
  const firstRelease = JSON.parse(platform.apps().find(app => JSON.parse(app.body).slug === 'finder').body).releaseId;
  await installDefaultApps(platform, { fresh: false });
  assert.equal(platform.apps().length, 3);
  assert.equal(JSON.parse(platform.apps().find(app => JSON.parse(app.body).slug === 'finder').body).releaseId, firstRelease);
  assert.equal(JSON.parse(await readFile(join(platform.directory, 'default-apps.json'), 'utf8')).status, 'complete');
});

test('existing and explicitly empty instances remain unchanged on later starts', async t => {
  const platform = await fixture(t);
  await installDefaultApps(platform, { fresh: true, enabled: false });
  await installDefaultApps(platform, { fresh: true });
  assert.equal(platform.apps().length, 0);
  assert.equal(JSON.parse(await readFile(join(platform.directory, 'default-apps.json'), 'utf8')).reason, 'disabled');
  assert.deepEqual(distributionApps([{ kind: 'app', body: '{' }]), []);
});
