import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCloudHost } from '../scripts/verify-cloud-host.mjs';
import edgeWorker from '../infra/edge/worker.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const owner = 'fixture-owner-private', edgeToken = 'fixture-edge-private', instanceId = '1'.repeat(32);
async function fixture(t, { foreign = false, lose, busy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-cloud-host-verifier-'));
  const journal = join(directory, 'journal.json'), output = join(directory, 'proof.json');
  const objects = new Map(), apps = new Map(), records = new Map(), releases = new Map(), state = new Map(), mutations = [], invocations = [], credentials = [];
  let slot, allowIdle = false, idlePolls = 0, lost = false, backend, sourceBytes, bundle, sourceAssetId;
  const env = { EDGE_TOKEN: edgeToken, APP_DOMAIN: 'example.test', APP_HOST_SUFFIX: 'inkos-0123456789abcdef', ASSETS: {
    get: async key => objects.has(key) ? new Response(objects.get(key)) : null,
    put: async (key, value) => objects.set(key, value),
  } };
  if (foreign) apps.set('f'.repeat(32), { id: 'f'.repeat(32), title: 'Do not touch', archived: true, body: JSON.stringify({ slug: 'existing-app' }) });
  function json(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
  async function invoke(appId, input) {
    invocations.push({ method: input.method, path: input.path });
    slot = { slotId: '3'.repeat(32), appId, releaseId: [...releases.keys()][0], leaseId: '4'.repeat(32), status: 'ready', inFlight: 0, holds: busy ? [{ id: 'busy' }] : [] };
    const ink = { state: {
      get: async key => ({ namespace: appId, key, value: state.get(key) || null, revision: state.has(key) ? 1 : 0 }),
      set: async (key, value, expected) => { assert.equal(expected, state.has(key) ? 1 : 0); state.set(key, value); const id = hash(appId + '\0state\0' + key).slice(0, 32), document = hash(appId + '\0state'); records.set(id, { id, namespace: appId, kind: 'state', title: key, tags: [], body: JSON.stringify(value) }); records.set(document.slice(0, 32), { id: document.slice(0, 32), namespace: appId, kind: 'collaboration', title: 'state', tags: [], body: JSON.stringify({ key: 'state', kind: 'state', cursor: 1 }), location: 'ink-collaboration:' + document }); return { value, revision: 1 }; },
    }, compute: { allowIdle: async () => { allowIdle = true; } } };
    const response = await backend.fetch(new Request('https://backend.test' + input.path, { method: input.method || 'GET', ...(input.body === undefined ? {} : { body: JSON.stringify(input.body), headers: { 'Content-Type': 'application/json' } }) }), { ink });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture'); let input;
      const chunks = []; for await (const chunk of request) chunks.push(chunk); if (chunks.length) input = JSON.parse(Buffer.concat(chunks));
      if (url.pathname === '/api/health') return json(response, { ok: true, instanceId });
      credentials.push(request.headers.authorization);
      if (url.pathname === '/_ink/edge/invoke') { assert.equal(request.headers.authorization, 'Bearer ' + edgeToken); return json(response, await invoke(input.appId, input)); }
      assert.equal(request.headers.authorization, 'Bearer ' + owner);
      const path = url.pathname.slice('/api/v1/'.length), method = request.method;
      if (method !== 'GET') mutations.push({ path, method });
      if (path === 'apps' && method === 'GET') { assert.equal(url.searchParams.get('archived'), 'true'); return json(response, [...apps.values()]); }
      if (path === 'runtimes') {
        if (allowIdle && ++idlePolls >= 2 && !busy) slot = { slotId: '3'.repeat(32), appId: null, releaseId: null, leaseId: null, status: 'idle', inFlight: 0, holds: [] };
        return json(response, { slots: slot ? [slot] : [] });
      }
      if (path === 'apps' && method === 'POST') {
        const intent = JSON.parse(await readFile(journal));
        assert.equal(intent.phase, 'create-intent'); assert.equal(intent.initialCatalogVerified, true);
        assert.equal(input.slug, intent.slug); assert.equal((await stat(journal)).mode & 0o777, 0o600);
        const id = hash('ink-os-app:' + input.slug).slice(0, 32), app = { id, title: input.title, namespace: 'os', kind: 'app', body: JSON.stringify({ slug: input.slug, capabilities: input.capabilities }) };
        apps.set(id, app); if (lose === 'create' && !lost) { lost = true; return response.destroy(); } return json(response, app, 201);
      }
      const appId = path.split('/')[1], app = apps.get(appId);
      if (path === 'apps/' + appId + '/status') return app ? json(response, { app, releases: [...releases.values()] }) : json(response, { error: 'Missing' }, 404);
      if (path === 'apps/' + appId + '/releases' && method === 'POST') {
        bundle = input; sourceBytes = Buffer.from(JSON.stringify(bundle)); const digest = hash(sourceBytes), id = '2'.repeat(32); sourceAssetId = '6'.repeat(32);
        const record = { id: sourceAssetId, namespace: appId, kind: 'file', title: 'App source ' + digest.slice(0, 12), tags: ['app-source', 'release'], body: JSON.stringify({ digest }), location: 'r2://fixture/objects/' + digest };
        records.set(sourceAssetId, record); objects.set('objects/' + digest, sourceBytes);
        backend = await import('data:text/javascript;base64,' + bundle.files.find(file => file.path === 'server/main.mjs').base64);
        const release = { id, body: JSON.stringify({ appId, digest, bundleObjectId: sourceAssetId, bundleLocation: record.location }) }; releases.set(id, release);
        if (lose === 'release' && !lost) { lost = true; return response.destroy(); } return json(response, release, 201);
      }
      if (path.startsWith('runtime/bundle/')) return json(response, bundle);
      if (path.startsWith('assets/')) return records.has(path.slice(7)) ? (response.writeHead(200), response.end(sourceBytes)) : json(response, { error: 'Missing' }, 404);
      if (path.endsWith('/publish')) {
        const id = path.split('/')[3], meta = JSON.parse(releases.get(id).body);
        app.body = JSON.stringify({ ...JSON.parse(app.body), releaseId: id });
        objects.set('edge/releases/' + id + '.json', JSON.stringify({ appId, releaseId: id, digest: meta.digest, backend: bundle.backend, entry: bundle.entry }));
        if (lose === 'publish' && !lost) { lost = true; return response.destroy(); } return json(response, app);
      }
      if (path.endsWith('/invoke')) {
        const result = await invoke(appId, input);
        if (lose === 'invoke' && input.path === '/count' && !lost) { lost = true; return response.destroy(); } return json(response, result);
      }
      if (path.startsWith('state/')) return json(response, { value: state.get(decodeURIComponent(path.slice(6))) || null, revision: state.size ? 1 : 0 });
      if (path.endsWith('/launch')) {
        const releaseId = JSON.parse(app.body).releaseId, origin = 'http://' + releaseId + '-' + env.APP_HOST_SUFFIX + '.' + env.APP_DOMAIN;
        const { sign } = await import('../infra/edge/worker.mjs'); const ticket = await sign({ kind: 'launch', appId, releaseId, exp: Date.now() + 60000 }, edgeToken);
        return json(response, { releaseId, origin, url: origin + '/_ink/launch?ticket=' + ticket });
      }
      if (path === 'data') return json(response, [...records.values()].filter(record => record.namespace === url.searchParams.get('namespace')));
      if (path === 'apps/' + appId && method === 'DELETE') {
        assert.ok(!slot?.appId, 'only quiescent canary may be deleted');
        if (!url.searchParams.has('permanent')) { app.archived = true; return json(response, app); }
        apps.delete(appId); records.clear(); releases.clear(); state.clear(); objects.clear();
        if (lose === 'purge' && !lost) { lost = true; return response.destroy(); }
        return json(response, { deleted: true, permanent: true, removedBlobs: sourceBytes ? 1 : 0 });
      }
      json(response, { error: 'Unimplemented fixture path' }, 404);
    } catch (error) { json(response, { error: error.message }, 500); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = 'http://127.0.0.1:' + server.address().port; env.OS_ORIGIN = url;
  const transport = async (input, init) => {
    const target = new URL(input);
    if (target.hostname.endsWith('.example.test')) { assert.equal(new Headers(init.headers).get('authorization'), null, 'owner token must not reach edge'); return edgeWorker.fetch(new Request(input, init), env); }
    return fetch(input, init);
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const options = { url, token: owner, journal, output, fetch: transport, idleTimeoutMs: 500, pollMs: 1, allowLoopbackHTTP: true };
  return { options, apps, records, releases, state, mutations, invocations, journal, output, directory, credentials };
}

test('real HTTP owner SDK and actual edge Worker execute canary source, isolate/authenticate HTML, then delete only idle generated data', async t => {
  const f = await fixture(t), proof = await verifyCloudHost(f.options);
  assert.equal(proof.status, 'passed'); assert.equal(proof.backendVerified, true); assert.equal(proof.edgeVerified, true);
  assert.equal(proof.sourceDeletionAcknowledged, true); assert.equal(proof.restartExternallyAttested, false);
  assert.equal(f.apps.size, 0); assert.equal(f.records.size, 0); assert.equal((await stat(f.journal)).mode & 0o777, 0o600);
  const text = await readFile(f.output, 'utf8'); assert.ok(!text.includes(owner)); assert.ok(!text.includes(f.options.url));
  const before = f.mutations.length; assert.deepEqual(await verifyCloudHost(f.options), proof); assert.equal(f.mutations.length, before);
});

test('nonempty initial archived catalog rejects all mutation', async t => {
  const f = await fixture(t, { foreign: true }); await assert.rejects(verifyCloudHost(f.options), { code: 'INK_CLOUD_PROOF_NONEMPTY_CATALOG' });
  assert.deepEqual(f.mutations, []); assert.equal(f.apps.size, 1);
});

for (const lose of ['create', 'release', 'publish', 'invoke', 'purge']) test('lost ' + lose + ' response recovers the same journal-owned canary without duplication', async t => {
  const f = await fixture(t, { lose }); await assert.rejects(verifyCloudHost(f.options));
  const first = JSON.parse(await readFile(f.journal)); const proof = await verifyCloudHost(f.options);
  assert.equal(proof.status, 'passed'); assert.equal(proof.canaryId, first.appId);
  assert.equal(f.mutations.filter(item => item.path === 'apps' && item.method === 'POST').length, 1);
  assert.equal(f.mutations.filter(item => item.path.endsWith('/releases')).length, 1);
  assert.equal(f.apps.size, 0);
});

test('busy owned worker is preserved and cleanup remains pending', async t => {
  const f = await fixture(t, { busy: true }); await assert.rejects(verifyCloudHost(f.options), { code: 'INK_CLOUD_PROOF_WORKER_PRESERVED' });
  assert.equal(f.apps.size, 1); assert.equal(f.mutations.filter(item => item.method === 'DELETE').length, 0);
});

test('journal canary title/slug and release identity drift block cleanup without touching unrelated records', async t => {
  const f = await fixture(t, { lose: 'create' }); await assert.rejects(verifyCloudHost(f.options));
  const app = [...f.apps.values()][0]; app.title = 'Foreign changed title';
  await assert.rejects(verifyCloudHost({ ...f.options, phase: 'cleanup' }), { code: 'INK_CLOUD_PROOF_NONEMPTY_CATALOG' });
  assert.equal(f.mutations.filter(item => item.method === 'DELETE').length, 0);
  const g = await fixture(t, { lose: 'release' }); await assert.rejects(verifyCloudHost(g.options));
  g.releases.set('e'.repeat(32), { id: 'e'.repeat(32), body: JSON.stringify({ appId: [...g.apps.keys()][0] }) });
  await assert.rejects(verifyCloudHost(g.options), { code: 'INK_CLOUD_PROOF_RELEASE_IDENTITY' });
  assert.equal(g.mutations.filter(item => item.method === 'DELETE').length, 0);
  const h = await fixture(t); await verifyCloudHost({ ...h.options, phase: 'prepare-restart' });
  h.records.set('9'.repeat(32), { id: '9'.repeat(32), namespace: [...h.apps.keys()][0], kind: 'collaboration', title: 'other-document', body: JSON.stringify({ key: 'state', kind: 'state', cursor: 1 }), tags: [] });
  await assert.rejects(verifyCloudHost({ ...h.options, phase: 'cleanup' }), { code: 'INK_CLOUD_PROOF_NAMESPACE_IDENTITY' });
  assert.equal(h.mutations.filter(item => item.method === 'DELETE').length, 0);
});

test('private journal permissions and concurrent lock are enforced before resource mutation', async t => {
  const f = await fixture(t, { lose: 'create' }); await assert.rejects(verifyCloudHost(f.options));
  const { chmod } = await import('node:fs/promises'); await chmod(f.journal, 0o644);
  const before = f.mutations.length;
  await assert.rejects(verifyCloudHost(f.options), { code: 'INK_CLOUD_PROOF_PRIVATE_FILE' });
  assert.equal(f.mutations.length, before);
  await chmod(f.journal, 0o600); await writeFile(f.journal + '.lock', 'reserved', { mode: 0o600 });
  await assert.rejects(verifyCloudHost(f.options), { code: 'INK_CLOUD_PROOF_LOCKED' });
  assert.equal(await readFile(f.journal + '.lock', 'utf8'), 'reserved');
  assert.equal(f.mutations.length, before);
});

test('restart challenge rejects future/mismatched receipts; resume observes existing state without replaying the write', async t => {
  const f = await fixture(t), pending = await verifyCloudHost({ ...f.options, phase: 'prepare-restart' });
  assert.equal(pending.status, 'awaiting-restart'); assert.equal(f.apps.size, 1);
  const receipt = join(f.directory, 'restart.json'), input = { format: 'ink-os-cloud-restart-receipt-v1', instanceId, challenge: pending.challenge, evidenceSha256: '9'.repeat(64), completedAt: new Date(Date.now() + 120000).toISOString() };
  await writeFile(receipt, JSON.stringify(input), { mode: 0o600 });
  await assert.rejects(verifyCloudHost({ ...f.options, phase: 'resume', restartReceipt: receipt }), { code: 'INK_CLOUD_PROOF_RESTART_RECEIPT' });
  input.completedAt = '2000-01-01T00:00:00.000Z'; await writeFile(receipt, JSON.stringify(input));
  await assert.rejects(verifyCloudHost({ ...f.options, phase: 'resume', restartReceipt: receipt }), { code: 'INK_CLOUD_PROOF_RESTART_RECEIPT' });
  input.completedAt = new Date().toISOString(); input.challenge = '0'.repeat(64); await writeFile(receipt, JSON.stringify(input));
  await assert.rejects(verifyCloudHost({ ...f.options, phase: 'resume', restartReceipt: receipt }), { code: 'INK_CLOUD_PROOF_RESTART_RECEIPT' });
  input.challenge = pending.challenge; await writeFile(receipt, JSON.stringify(input));
  const writes = f.invocations.filter(item => item.path === '/count' && item.method === 'POST').length;
  const proof = await verifyCloudHost({ ...f.options, phase: 'resume', restartReceipt: receipt });
  assert.equal(proof.restartExternallyAttested, true); assert.equal(proof.persistenceAfterRestartHookVerified, true);
  assert.equal(f.invocations.filter(item => item.path === '/count' && item.method === 'POST').length, writes);
});

test('missing state after external restart is a failure and never silently recreated', async t => {
  const f = await fixture(t), pending = await verifyCloudHost({ ...f.options, phase: 'prepare-restart' }); f.state.clear();
  const receipt = join(f.directory, 'restart.json'); await writeFile(receipt, JSON.stringify({ format: 'ink-os-cloud-restart-receipt-v1', instanceId, challenge: pending.challenge, evidenceSha256: '9'.repeat(64), completedAt: new Date().toISOString() }), { mode: 0o600 });
  const writes = f.invocations.filter(item => item.path === '/count' && item.method === 'POST').length;
  await assert.rejects(verifyCloudHost({ ...f.options, phase: 'resume', restartReceipt: receipt }), { code: 'INK_CLOUD_PROOF_CONTRACT' });
  assert.equal(f.invocations.filter(item => item.path === '/count' && item.method === 'POST').length, writes); assert.equal(f.apps.size, 1);
});
