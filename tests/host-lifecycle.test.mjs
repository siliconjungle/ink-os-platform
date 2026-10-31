import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

test('normal shutdown closes connected desktop event streams and collaboration sockets', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-host-stop-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DATA_DIR: directory, NODE_ENV: 'production' });
  const child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', socket, preconnect;
  const streams = [], abort = new AbortController();
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const exited = once(child, 'exit');
  t.after(async () => {
    abort.abort(); socket?.terminate(); preconnect?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited; await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
    try { if ((await fetch(url + '/api/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const { token } = JSON.parse(await readFile(join(directory, 'client.json'))), headers = { authorization: 'Bearer ' + token };
  for (const path of ['/api/events', '/api/v1/events', '/api/v1/desktop/events?clientId=' + randomUUID()]) {
    const stream = await fetch(url + path, { headers, signal: abort.signal });
    assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type'), /^text\/event-stream/); streams.push(stream);
  }
  socket = new WebSocket(url.replace('http:', 'ws:') + '/api/v1/sync', { headers });
  await once(socket, 'open'); const socketClosed = once(socket, 'close');
  preconnect = createConnection({ host: '127.0.0.1', port }); await once(preconnect, 'connect');
  preconnect.on('error', error => assert.equal(error.code, 'ECONNRESET'));
  const preconnectClosed = new Promise(resolve => preconnect.once('close', resolve));
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0, output); assert.equal(signal, null);
  assert.match(output, /stopped cleanly/);
  await Promise.all(streams.map(stream => stream.text()));
  assert.equal((await socketClosed)[0], 1001);
  await preconnectClosed;
});
