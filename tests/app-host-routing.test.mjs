import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PooledProvider } from '../infra/pooled-provider.mjs';
import worker from '../infra/edge/worker.mjs';

const appId = 'a'.repeat(32), releaseId = 'b'.repeat(32), edgeToken = 'routing-fixture-private-token';
function fixture({ domain = 'apps.example.com', hostSuffix } = {}) {
  const objects = new Map(), reads = [], operations = [], retired = [];
  const bundle = { entry: 'index.html', files: [{ path: 'index.html', base64: Buffer.from('<title>Isolated app</title>').toString('base64') }] };
  const bytes = JSON.stringify(bundle), digest = createHash('sha256').update(bytes).digest('hex'); objects.set('objects/' + digest, bytes);
  const env = { APP_DOMAIN: domain, ...(hostSuffix === undefined ? {} : { APP_HOST_SUFFIX: hostSuffix }), EDGE_TOKEN: edgeToken, OS_ORIGIN: 'https://os.example.com', ASSETS: {
    get: async key => { reads.push(key); return objects.has(key) ? new Response(objects.get(key)) : null; },
    put: async (key, value) => { objects.set(key, value); },
  } };
  const provider = new PooledProvider({ domain, ...(hostSuffix === undefined ? {} : { hostSuffix }), edgeToken, fly: { retire: async value => retired.push(value) } });
  provider.edge = async (path, body, method = 'PUT') => {
    operations.push({ path, body, method });
    const response = await worker.fetch(new Request('https://edge.example.com/_internal/' + path, { method, headers: { Authorization: 'Bearer ' + edgeToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
    assert.equal(response.status, 200); return response.json();
  };
  const deploy = () => provider.deploy({ appId, releaseId, meta: { bundleLocation: 'r2://fixture/objects/' + digest, digest, entry: 'index.html' } });
  return { provider, env, reads, operations, retired, deploy };
}

test('default inkos suffix preserves nested app origins, launch authentication and exact file serving', async () => {
  const f = fixture(), deployment = await f.deploy();
  assert.equal(deployment.url, `https://${releaseId}-inkos.apps.example.com`);
  assert.equal((await worker.fetch(new Request(deployment.url), f.env)).status, 401);
  const launch = await worker.fetch(new Request(f.provider.launch(appId, releaseId)), f.env);
  assert.equal(launch.status, 303); assert.equal(launch.headers.get('location'), '/');
  const cookie = launch.headers.get('set-cookie').split(';')[0];
  const response = await worker.fetch(new Request(deployment.url, { headers: { Cookie: cookie } }), f.env);
  assert.equal(response.status, 200); assert.equal(await response.text(), '<title>Isolated app</title>');
  assert.equal(f.provider.releaseOrigin(deployment.url), releaseId);
});

test('optional instance suffix yields first-level zone hostnames and rejects every foreign suffix/domain before R2 lookup', async () => {
  const hostSuffix = 'inkos-0123456789abcdef', f = fixture({ domain: 'example.com', hostSuffix }), deployment = await f.deploy();
  assert.equal(deployment.url, `https://${releaseId}-${hostSuffix}.example.com`);
  assert.equal(new URL(deployment.url).hostname.split('.').length, 3);
  const launch = await worker.fetch(new Request(f.provider.launch(appId, releaseId)), f.env); assert.equal(launch.status, 303);
  const foreign = [
    `${releaseId}-inkos.example.com`, `${releaseId}-inkos-fedcba9876543210.example.com`,
    `${releaseId}-${hostSuffix}.foreign.example.com`, `${releaseId}-${hostSuffix}.example.com.attacker.test`,
    `${releaseId}-extra-${hostSuffix}.example.com`, `${releaseId}-${hostSuffix}.apps.example.com`,
    `${'c'.repeat(31)}-${hostSuffix}.example.com`, `${'g'.repeat(32)}-${hostSuffix}.example.com`,
  ];
  for (const hostname of foreign) {
    f.reads.length = 0;
    const response = await worker.fetch(new Request('https://' + hostname + '/'), f.env);
    assert.equal(response.status, 404, hostname); assert.deepEqual(f.reads, []);
  }
  const other = fixture({ domain: 'example.com', hostSuffix: 'inkos-fedcba9876543210' });
  assert.notEqual(other.provider.url(releaseId), deployment.url);
});

test('host suffixes are bounded DNS labels including the complete release prefix', async () => {
  for (const hostSuffix of ['', '-inkos', 'inkos-', 'INkOS', 'ink.os', 'a/b', 'a?b', 'a'.repeat(31), 7]) {
    assert.throws(() => new PooledProvider({ domain: 'example.com', hostSuffix }), { status: 400 });
    const f = fixture(); f.env.APP_HOST_SUFFIX = hostSuffix;
    assert.equal((await worker.fetch(new Request(`https://${releaseId}-inkos.apps.example.com/`), f.env)).status, 503);
    assert.deepEqual(f.reads, []);
  }
  for (const hostSuffix of ['a', 'a-b', 'a'.repeat(30)]) {
    const f = fixture({ domain: 'example.com', hostSuffix });
    assert.ok(new URL(f.provider.url(releaseId)).hostname.split('.')[0].length <= 63);
    assert.equal((await worker.fetch(new Request(f.provider.url(releaseId)), f.env)).status, 404);
  }
  for (const domain of ['a..example.com', '-bad.example.com', 'https://example.com', 'a'.repeat(64) + '.com', 'example.com/path']) assert.throws(() => new PooledProvider({ domain }), { status: 400 });
  assert.throws(() => fixture().provider.url('../foreign'), { status: 400 });
});

test('owner environment selects the same suffix as the Worker binding without changing default routing', async () => {
  const previous = process.env.INK_OS_APP_HOST_SUFFIX;
  try {
    process.env.INK_OS_APP_HOST_SUFFIX = 'inkos-0123456789abcdef';
    const provider = new PooledProvider({ domain: 'example.com' });
    assert.equal(provider.url(releaseId), `https://${releaseId}-inkos-0123456789abcdef.example.com`);
    delete process.env.INK_OS_APP_HOST_SUFFIX;
    assert.equal(new PooledProvider({ domain: 'example.com' }).url(releaseId), `https://${releaseId}-inkos.example.com`);
  } finally {
    if (previous === undefined) delete process.env.INK_OS_APP_HOST_SUFFIX;
    else process.env.INK_OS_APP_HOST_SUFFIX = previous;
  }
  const domain = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(23)].join('.');
  const f = fixture({ domain, hostSuffix: 'a' });
  assert.equal(new URL(f.provider.url(releaseId)).hostname.length, 250);
  const tooLong = domain + 'dddd';
  assert.throws(() => new PooledProvider({ domain: tooLong, hostSuffix: 'a' }), { status: 400 });
  f.env.APP_DOMAIN = tooLong;
  assert.equal((await worker.fetch(new Request(f.provider.url(releaseId)), f.env)).status, 503);
  assert.deepEqual(f.reads, []);
});

test('retirement verifies the complete HTTPS origin before publication or legacy provider side effects', async () => {
  for (const settings of [{}, { domain: 'example.com', hostSuffix: 'inkos-0123456789abcdef' }]) {
    const f = fixture(settings), deployment = await f.deploy(), own = new URL(deployment.url);
    const invalid = [
      deployment.url.replace('https:', 'http:'), deployment.url + '/path', deployment.url + '?query=1', deployment.url + '#fragment',
      `https://user:password@${own.hostname}`, `https://${own.hostname}:444/`, `https://${own.hostname}.foreign.test`,
      `https://${releaseId}-inkos-other.${f.provider.domain}`, 'https://not-a-release.' + f.provider.domain,
    ];
    for (const url of invalid) {
      const before = f.operations.length;
      await assert.rejects(f.provider.retire({ provider: 'pool', url, legacy: { provider: 'fly' } }), { status: 409 });
      assert.equal(f.operations.length, before); assert.deepEqual(f.retired, []);
    }
    const legacy = { provider: 'fly', app: 'fixture' };
    await f.provider.retire({ ...deployment, legacy });
    assert.deepEqual(f.operations.at(-1), { path: 'releases/' + releaseId, body: { disabled: true }, method: 'PATCH' });
    assert.deepEqual(f.retired, [legacy]);
    assert.equal((await worker.fetch(new Request(deployment.url), f.env)).status, 410);
  }
});
