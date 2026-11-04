// The real desktop refreshes another app's frames only when `ink-reads` lists
// them.
//
//   npx vite build
//   INK_UI_BROWSER_EXECUTABLE=/path/to/chrome node scripts/verify-ink-reads-desktop.mjs [--output FILE]
//
// One production host (scripts/start.mjs, built desktop from dist/) runs two
// copies of examples/tables-system: Tables A with Dashboard A, and Tables B
// with Dashboard B. Every app has code.execute, and both dashboards hold
// apps.invoke. Before `ink-reads`, every such frame refreshed on every commit
// of every app.
//
// The desktop opens Tables A, Dashboard A and Dashboard B as windows. Each
// window's Ink UI requests (open, refresh, watch, event) carry its app id, so
// the script counts each app's requests from the browser's network log.
//
// Then:
// 1. A commit to Tables A must refresh Dashboard A and leave Dashboard B silent.
// 2. A commit to Tables B must refresh Dashboard B and leave Dashboard A silent.
// 3. Dashboard A's frame must show the new row.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { loadInkSystem } from '../cli/bin/ink-system.mjs';

const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const root = await mkdtemp(join(tmpdir(), 'ink-reads-desktop-')),
  directory = join(root, 'data');
await writeFile(join(root, 'storage-retention.json'), JSON.stringify({ keep: { data: 'Desktop ink-reads verification instance.' }, safe_to_remove: {} }));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const url = 'http://127.0.0.1:' + port;
let host, browser, log = '';
try {
  host = spawn(process.execPath, ['scripts/start.mjs'], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME|LANG|LC_ALL|TMPDIR)$/.test(k))),
      NODE_ENV: 'production',
      PORT: String(port),
      INK_OS_DEFAULT_APPS: '0',
      INK_OS_NATIVE: '0',
      INK_OS_DATA_DIR: directory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', (b) => (log += b));
  host.stderr.on('data', (b) => (log += b));
  for (let i = 0; ; i++) {
    if (host.exitCode !== null) throw Error('Host exited: ' + log.slice(-2000));
    try {
      if ((await fetch(url + '/api/health')).ok) break;
    } catch {}
    if (i > 300) throw Error('Host did not start: ' + log.slice(-2000));
    await pause(100);
  }
  const { token } = JSON.parse(await readFile(join(directory, 'client.json'), 'utf8')),
    call = async (path, body) => {
      const response = await fetch(url + '/api/v1' + path, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw Error(path + ': ' + value.error);
      return value;
    };

  // Two copies of the system under distinct slugs.
  const deploy = async (suffix) => {
    const input = await loadInkSystem(new URL('../examples/tables-system/', import.meta.url).pathname);
    for (const app of input.apps) {
      app.manifest.slug += suffix;
      app.manifest.name = (app.manifest.name || app.name) + ' ' + suffix.toUpperCase().slice(1);
      app.files.find((f) => f.path === 'ink-app.json').base64 = Buffer.from(JSON.stringify(app.manifest)).toString('base64');
    }
    return (await call('/ink/systems/deploy', { input })).apps;
  };
  const a = await deploy('-a'),
    b = await deploy('-b'),
    names = new Map([
      [a.tables.appId, 'Tables A'],
      [a.dashboard.appId, 'Dashboard A'],
      [b.tables.appId, 'Tables B'],
      [b.dashboard.appId, 'Dashboard B'],
    ]);

  browser = await chromium.launch({ executablePath: process.env.INK_UI_BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const login = await context.request.post(url + '/login', { data: { token } });
  assert.equal(login.status(), 200);
  const page = await context.newPage(),
    requests = [];
  // Watch long-polls answer with a delivery or, after 15 s, a heartbeat; only
  // deliveries count.
  page.on('response', async (response) => {
    const match = /\/api\/v1\/apps\/([a-f0-9]{32})\/ink\/ui(?:\/[a-f0-9]{32}\/(refresh|watch|event))?$/.exec(new URL(response.url()).pathname);
    if (!match || response.request().method() !== 'POST') return;
    let kind = match[2] || 'open';
    if (kind === 'watch') {
      const value = await response.json().catch(() => null);
      if (!value || value.heartbeat) return;
      kind = 'delivery';
    }
    requests.push({ app: names.get(match[1]) || match[1], kind, at: Date.now() });
  });
  // Messages the desktop sends into app frames, recorded inside each frame.
  await context.addInitScript(() => {
    const seen = (globalThis.__inkMessages = []);
    const record = (event) => {
      if (event?.data && typeof event.data.type === 'string')
        seen.push({ type: event.data.type, at: Date.now(), detail: event.data.type === 'context' || event.data.type === 'connect' ? JSON.stringify(event.data).slice(0, 400) : event.data.type === 'ink.state' ? JSON.stringify(event.data.data) : undefined });
    };
    const add = MessagePort.prototype.addEventListener;
    MessagePort.prototype.addEventListener = function (type, listener, options) {
      if (type === 'message') add.call(this, 'message', record);
      return add.call(this, type, listener, options);
    };
    const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
      configurable: true,
      get: descriptor.get,
      set(listener) {
        descriptor.set.call(this, (event) => {
          record(event);
          return listener?.call(this, event);
        });
      },
    });
  });
  await page.goto(url + '/');
  await page.waitForFunction(() => document.querySelector('.desktop-dock'), null, { timeout: 30000 });
  for (const appId of [a.tables.appId, a.dashboard.appId, b.dashboard.appId]) {
    await page.evaluate((id) => (location.hash = '#x/' + id), appId);
    await pause(500);
  }
  // Every window has opened its interface and finished its first reads.
  const opened = async () => {
    for (let i = 0; i < 200; i++) {
      const apps = new Set(requests.filter((r) => r.kind === 'open').map((r) => r.app));
      if (['Tables A', 'Dashboard A', 'Dashboard B'].every((n) => apps.has(n))) return;
      await pause(100);
    }
    throw Error('Windows did not open their interfaces: ' + JSON.stringify(requests));
  };
  await opened();
  const quiet = async (ms = 2500) => {
    let last = requests.length;
    for (;;) {
      await pause(ms);
      if (requests.length === last) return;
      last = requests.length;
    }
  };
  await quiet();
  const counts = (since) => {
    const out = {};
    for (const r of requests.slice(since)) out[r.app] = (out[r.app] || 0) + 1;
    return out;
  };
  const row = (id) => ({ id, title: 'Desktop row ' + id, amount: id, open: true });

  const steps = [];
  for (const [label, target] of [
    ['commit to Tables A', a.tables.appId],
    ['commit to Tables B', b.tables.appId],
  ]) {
    const since = requests.length,
      version = BigInt(JSON.parse((await call('/apps/' + target + '/ink/run', { entry: 'dashboard', input: '[0,1]' })).valueWire).version),
      id = 1000 + steps.length;
    const reply = await call('/apps/' + target + '/ink/run', { entry: 'put', input: JSON.stringify([Number(version), row(id)]) });
    assert.match(reply.valueWire, /"Ok"/);
    await quiet();
    steps.push({ label, requests: counts(since) });
  }

  // Inside the frames: which received `ink.state` for which provider.
  const frames = (
    await Promise.all(
      page.frames().map(async (frame) => ({
        messages: (await frame.evaluate(() => globalThis.__inkMessages || []).catch(() => [])).filter((m) => m.type === 'ink.state'),
        text: await frame.evaluate(() => document.body?.innerText || '').catch(() => ''),
      })),
    )
  ).filter((f) => f.messages.length);
  const notified = (provider) => frames.filter((f) => f.messages.some((m) => JSON.parse(m.detail).provider === provider));
  const [first, second] = steps;
  assert.ok(first.requests['Dashboard A'] > 0, 'Dashboard A receives a delivery after a commit to Tables A');
  assert.equal(first.requests['Dashboard B'] || 0, 0, 'Dashboard B receives nothing after a commit to Tables A');
  assert.ok(second.requests['Dashboard B'] > 0, 'Dashboard B receives a delivery after a commit to Tables B');
  assert.equal(second.requests['Dashboard A'] || 0, 0, 'Dashboard A receives nothing after a commit to Tables B');
  const [toA, toB] = [notified(a.tables.appId), notified(b.tables.appId)];
  assert.equal(toA.length, 1, 'exactly one frame is told that Tables A changed');
  assert.equal(toB.length, 1, 'exactly one frame is told that Tables B changed');
  assert.notEqual(toA[0], toB[0], 'different frames are told about each provider');
  const shown = toA[0].text.includes('Desktop row 1000') && toB[0].text.includes('Desktop row 1001');
  assert.ok(shown, 'each told frame shows the row committed to its own provider');
  const report = {
    schema: 1,
    recordedAt: new Date().toISOString(),
    browser: browser.version(),
    scope:
      'Production host with the built desktop (dist/), two copies of examples/tables-system, three windows (Tables A, Dashboard A, Dashboard B). Requests are Ink UI opens, refreshes, events and non-heartbeat watch deliveries per app after each commit; frames are told by in-frame ink.state messages.',
    steps,
    framesToldPerProvider: { 'Tables A': toA.length, 'Tables B': toB.length },
    dashboardsShowOwnRows: shown,
  };
  if (output) {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (host && host.exitCode === null) {
    host.kill('SIGTERM');
    await once(host, 'exit');
  }
  await rm(root, { recursive: true, force: true });
}
