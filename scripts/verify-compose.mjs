import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient } from '../sdk/src/server.js';
import { DockerEngine } from '../infra/docker-engine.mjs';
import { proofHTTP } from './proof-http.mjs';

const execute = promisify(execFile), file = resolve(process.env.INK_OS_COMPOSE_FILE || '../ink-os-deploy/compose.yaml');
const compose = args => execute('docker', ['compose', '-f', file, ...args], { maxBuffer: 4 * 1024 * 1024 });
const config = JSON.parse((await compose(['config', '--format', 'json'])).stdout);
const port = config.services['ink-os'].ports[0].published;
const connection = JSON.parse((await compose(['exec', '-T', 'ink-os', 'cat', '/data/client.json'])).stdout);
const url = 'http://127.0.0.1:' + port, sdk = createClient({ url, token: connection.token }), engine = new DockerEngine();
const health = await (await fetch(url + '/api/health')).json();
assert.match(health.instanceId, /^[a-f0-9]{32}$/);
assert.deepEqual((await sdk.apps.list()).map(app=>JSON.parse(app.body).slug).sort(), ['finder','ink-environment','preview']);
const encode = (path, text) => ({ path, base64: Buffer.from(text).toString('base64') });
const app = await sdk.apps.create({ slug: 'compose-proof', title: 'Compose proof' });
const source = 'let hold;export async function fetch(request,{ink}){const path=new URL(request.url).pathname;if(path==="/hold"){hold=await ink.compute.hold("Compose restart");return Response.json({held:true});}if(path==="/release"){await hold.release();return Response.json({released:true});}const state=await ink.state.get("count");if(request.method!=="POST")return Response.json(state);return Response.json(await ink.state.set("count",{count:(state.value?.count||0)+1},state.revision));}';
const release = await sdk.request('apps/' + app.id + '/releases', { method: 'POST', body: { entry: 'index.html', files: [encode('index.html', '<p>Compose backend</p>'), encode('server/main.mjs', source)], backend: { entry: 'server/main.mjs', idleSafe: true }, desktop: { entry: 'app', icon: 'code' } } });
await sdk.apps.publish(app.id, release.id);
const cli = JSON.parse((await compose(['exec', '-T', 'ink-os', 'node', 'cli/bin/ink-os.mjs', 'invoke', app.id, '/count', '--method', 'POST'])).stdout);
assert.equal(cli.body.value.count, 1);
let launch = await sdk.request('apps/' + app.id + '/launch', { method: 'POST', body: {} });
const get = (path, cookie, selected = launch) => proofHTTP(url, path, { host: new URL(selected.origin).host, headers: cookie ? { Cookie: cookie } : {} });
assert.equal((await get('/')).status, 401);
const redirect = await get(new URL(launch.url).pathname + new URL(launch.url).search);
assert.equal(redirect.status, 302);
const cookie = redirect.headers.get('set-cookie').split(';')[0];
assert.equal(await (await get('/', cookie)).text(), '<p>Compose backend</p>');
assert.equal((await get('/server/main.mjs', cookie)).status, 404);
assert.equal((await (await get('/backend/count', cookie)).json()).value.count, 1);
await sdk.request('apps/' + app.id + '/invoke', { method: 'POST', body: { path: '/hold', method: 'POST' } });
const before = (await sdk.runtimes.list()).slots.find(slot => slot.appId === app.id);
await compose(['restart', 'ink-os']);
for (let attempt = 0; attempt < 100; attempt++) {
  try { const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.ok) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
launch = await sdk.request('apps/' + app.id + '/launch', { method: 'POST', body: {} });
const state = await sdk.request('apps/' + app.id + '/invoke', { method: 'POST', body: { path: '/count', method: 'GET' } });
assert.equal(state.body.value.count, 1);
const after = (await sdk.runtimes.list()).slots.find(slot => slot.appId === app.id);
assert.equal(after.leaseId, before.leaseId);
await sdk.request('apps/' + app.id + '/invoke', { method: 'POST', body: { path: '/release', method: 'POST' } });
await new Promise(resolve => setTimeout(resolve, 2400));
await sdk.runtimes.reap();
assert.ok((await sdk.runtimes.list()).slots.every(slot => slot.status === 'idle'));
const filters = encodeURIComponent(JSON.stringify({ label: ['ink.os.instance=' + health.instanceId] }));
for (const container of await engine.request('/containers/json?all=1&filters=' + filters)) {
  assert.equal((await engine.request('/containers/' + container.Id + '/json')).State.Running, false);
  await engine.request('/containers/' + container.Id, { method: 'DELETE' });
}
for (const network of await engine.request('/networks?filters=' + filters)) await engine.request('/networks/' + network.Id, { method: 'DELETE' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = { format: 'ink-os-compose-proof-v1', platformCommit: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), composeSha256: sha(await readFile(file)), runtimeImage: config.services['runtime-image'].image, observed: ['Compose built its runtime image and started with Finder, Preview and Ink Environment.', 'Owner API installed a module backend and the in-container CLI invoked it through a Docker lease.', 'Separate release hostname required its own launch cookie and hid backend source.', 'Gateway forwarded authenticated frontend backend requests to the container.', 'Compose restart preserved app data and reattached the same compute lease.', 'Idle workers stopped safely and their containers/networks were removed without force.'], limits: ['Real Linux Docker Compose acceptance; no graphical browser or desktop Docker-engine acceptance.', 'External domains/TLS, cloud provisioning and managed desktop engines are separate checks.'] };
await writeFile('evidence/compose.json', JSON.stringify(proof, null, 2) + '\n');
console.log('Compose backend, gateway and restart proof passed.');
