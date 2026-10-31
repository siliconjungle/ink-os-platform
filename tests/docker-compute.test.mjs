import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DockerEngine } from '../infra/docker-engine.mjs';
import { DockerCompute } from '../infra/docker-compute.mjs';

test('Docker Engine transport uses the configured local socket and does not return sensitive error bodies', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-engine-')), socket = join(directory, 'engine.sock');
  const server = http.createServer((req, res) => {
    assert.match(req.url, /^\/v1\.45\//);
    if (req.url.endsWith('/missing/json')) { res.writeHead(404); return res.end('{}'); }
    if (req.url.endsWith('/bad/json')) { res.writeHead(500); return res.end(JSON.stringify({ error: 'private-environment-value' })); }
    res.end(JSON.stringify({ Id: 'sha256:' + 'a'.repeat(64) }));
  });
  server.listen(socket); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const engine = new DockerEngine({ socket });
  assert.equal(await engine.image('runtime:local'), 'sha256:' + 'a'.repeat(64));
  assert.equal(await engine.request('/images/missing/json', { missing: true }), null);
  await assert.rejects(engine.request('/images/bad/json'), error => error.dockerStatus === 500 && !error.message.includes('private-environment-value'));
});

test('container cleanup preserves running workers and refuses another instance or lease', async () => {
  const calls = [], slot = { id: 'b'.repeat(32), leaseId: 'c'.repeat(32), kind: 'module' };
  let container;
  const compute = new DockerCompute({ engine: { request: async (path, input) => { calls.push({ path, input }); return path.endsWith('/json') ? container : null; } } });
  compute.attach({ instanceId: 'a'.repeat(32) });
  container = { Id: 'd'.repeat(64), State: { Running: true }, Config: { Labels: compute.labels(slot) } };
  assert.ok(compute.name(slot, true).length < 64);
  assert.equal(await compute.poolStopped(slot), false);
  await assert.rejects(compute.removeStopped(slot), { status: 409 });
  assert.equal(calls.some(call => call.input?.method === 'DELETE'), false);
  container.State.Running = false;
  container.Config.Labels['ink.os.instance'] = 'f'.repeat(32);
  await assert.rejects(compute.removeStopped(slot), { status: 409 });
  assert.equal(calls.some(call => call.input?.method === 'DELETE'), false);
});
