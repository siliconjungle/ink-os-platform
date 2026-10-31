import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('a clean authenticated instance creates projects and publishes an isolated local app without cloud services', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-server-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR: directory, NODE_ENV: 'production' });
  const child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail(output);
    try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const config = JSON.parse(await readFile(join(directory, 'client.json'), 'utf8'));
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  assert.equal((await fetch(base + '/api/v1/apps')).status, 401);
  assert.deepEqual(await request('apps'), []);
  const project = await request('projects', 'POST', { title: 'Local source' });
  assert.equal((await request('projects/' + project.id + '/status')).commit, null);
  const app = await request('apps', 'POST', { slug: 'local-proof', title: 'Local proof', capabilities: [], desktop: { entry: 'app', icon: 'layers' } });
  const release = await request('apps/' + app.id + '/releases', 'POST', { entry: 'index.html', files: [{ path: 'index.html', base64: Buffer.from('<p>local release</p>').toString('base64') }] });
  await request('apps/' + app.id + '/releases/' + release.id + '/publish', 'POST', {});
  const launch = await request('apps/' + app.id + '/launch', 'POST', {});
  assert.notEqual(new URL(launch.url).origin, base);
  const redirect = await fetch(launch.url, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  const cookie = redirect.headers.get('set-cookie').split(';')[0];
  assert.equal(await (await fetch(launch.origin, { headers: { cookie } })).text(), '<p>local release</p>');
});
