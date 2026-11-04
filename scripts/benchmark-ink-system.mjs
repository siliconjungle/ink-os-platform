import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { systemFixture, owner } from '../tests/ink-system-fixture.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { InkViews } from '../server/ink-ui.mjs';
import { runInstalledInk } from '../server/ink-apps.mjs';
const execute = promisify(execFile),
  args = process.argv.slice(2),
  option = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  },
  mode = option('--mode');
if (!mode) {
  const runs = [];
  for (const target of ['baseline-javascript', 'javascript', 'native']) {
    const result = await execute(
      process.execPath,
      [fileURLToPath(import.meta.url), '--mode', target],
      { env: process.env, maxBuffer: 8 * 1024 * 1024 },
    );
    runs.push(JSON.parse(result.stdout));
  }
  const report = {
      schema: 1,
      recordedAt: new Date().toISOString(),
      host: {
        platform: platform(),
        arch: arch(),
        node: process.version,
        cpu: cpus()[0].model,
        logicalCpus: cpus().length,
      },
      scope:
        'Fresh Node/browser process per mode; loopback owner HTTP fixture, typed UI runtime and actual DOM paint in two panes. Explicit replay, exploratory measurements; no automatic profitability claim. Excludes production authentication, desktop MessagePort and Electron/window-compositor coverage. Lost reply is a deliberately discarded completed application reply.',
      runs,
    },
    path = resolve(option('--output', 'docs/benchmarks/tables-system.json'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      output: path,
      runs: runs.map((r) => ({
        mode: r.mode,
        editToPaint: r.editToPaint,
        concurrency: r.concurrency,
        recoveryMs: r.recoveryMs,
      })),
    }),
  );
  process.exit(0);
}
if (!['baseline-javascript', 'javascript', 'native'].includes(mode))
  throw Error('Unknown benchmark mode');
const cleanups = [],
  f = await systemFixture(
    { after: (fn) => cleanups.push(fn) },
    {
      native: mode === 'native',
      baseline: mode === 'baseline-javascript',
      collaborative: true,
    },
  );
let p = f.p,
  version = 0;
const streams = new Set();
let received = 0,
  sent = 0,
  requests = 0,
  loseReply = false;
for (let id = 1; id <= 64; id++) {
  await f.call(
    'put',
    [version, { id, title: 'Item ' + id, amount: id, open: true }],
    { requestId: 'seed-' + id },
  );
  version++;
}
let stop = p.world.subscribe((event) => {
  if (
    event.type === 'ink-state' ||
    (event.type === 'object' &&
      event.object.kind === 'state' &&
      event.object.title === 'ink-app:state')
  )
    for (const stream of streams) stream.write('data: {}\n\n');
});
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/sdk/')) {
      const name = req.url.slice(5);
      if (!/^[a-z-]+\.js$/.test(name)) throw Error('Invalid module');
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(new URL('../sdk/src/' + name, import.meta.url)));
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ready\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (req.url === '/rpc') {
      let text = '';
      for await (const b of req) text += b;
      received += Buffer.byteLength(text);
      requests++;
      const { action, name, id, input } = JSON.parse(text);
      let value;
      if (action === 'put')
        value = await runInstalledInk(
          p,
          f.deployed.apps.tables.appId,
          {
            entry: 'put',
            input: JSON.stringify(input.args),
            requestId: input.requestId,
          },
          owner,
        );
      else if (action === 'dashboard')
        value = await runInstalledInk(
          p,
          f.deployed.apps.tables.appId,
          { entry: 'dashboard', input: '[0,0]' },
          owner,
        );
      else if (action === 'open')
        value = await p.inkViews.openApp(f.deployed.apps[name].appId, owner);
      else value = await p.inkViews[action](id, owner, input);
      if (action === 'put' && loseReply) {
        loseReply = false;
        res.setHeader('X-Ink-Benchmark-Lost-Reply', '1');
      }
      const body = JSON.stringify(value);
      sent += Buffer.byteLength(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<main id="tables"></main><main id="dashboard"></main>');
  } catch (error) {
    res.statusCode = error.status || 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error.message, current: error.current }));
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.INK_UI_BROWSER_EXECUTABLE,
  }),
  page = await browser.newPage(),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let peakNodeRss = process.memoryUsage().rss;
const memoryTimer = setInterval(
  () => (peakNodeRss = Math.max(peakNodeRss, process.memoryUsage().rss)),
  10,
);
const rss = async () => {
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss=']);
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const own = new Set([process.pid]);
  for (let i = 0; i < 8; i++)
    for (const [id, parent] of rows) if (own.has(parent)) own.add(id);
  return rows
    .filter(([id]) => own.has(id))
    .reduce((sum, row) => sum + row[2] * 1024, 0);
};
try {
  const startup = performance.now();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(async () => {
    const { mountInkUi } = await import('/sdk/ui-runtime.js');
    globalThis.uiErrors = [];
    const listeners = new Set(),
      stream = new EventSource('/events');
    stream.onmessage = () => listeners.forEach((fn) => fn());
    globalThis.rpc = async (action, name, id, input) => {
      const r = await fetch('/rpc', {
          method: 'POST',
          body: JSON.stringify({ action, name, id, input }),
        }),
        value = await r.json();
      if (r.headers.get('X-Ink-Benchmark-Lost-Reply'))
        throw Error('Deliberately discarded reply');
      if (!r.ok)
        throw Object.assign(Error(value.error), {
          status: r.status,
          current: value.current,
        });
      return value;
    };
    globalThis.controllers = {};
    for (const name of ['tables', 'dashboard'])
      controllers[name] = await mountInkUi({
        element: document.querySelector('#' + name),
        transport: {
          open: () => rpc('open', name),
          refresh: (id, input) => rpc('refresh', name, id, input),
          event: (id, input) => rpc('event', name, id, input),
          dispose: (id) => rpc('dispose', name, id, {}),
        },
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        onError: (error) => uiErrors.push(error.message),
      });
  });
  await page.waitForFunction(
    () => document.querySelectorAll('li').length === 40,
  );
  const startupMs = performance.now() - startup,
    latencies = [],
    journalBefore = p.world.journal.bytes,
    docBytes = async () => {
      let bytes = 0;
      for (const task of p.collaboration.documents.values())
        bytes += (await task).length;
      return bytes;
    },
    appJournalBefore = await docBytes(),
    networkBefore = { received, sent, requests };
  for (let i = 0; i < 16; i++) {
    const label = 'Edit ' + i,
      latency = await page.evaluate(
        async ({ version, label, i }) => {
          const start = performance.now();
          await rpc('put', null, null, {
            args: [
              version,
              { id: 1, title: label, amount: 100 + i, open: true },
            ],
            requestId: 'edit-' + i,
          });
          while (
            [...document.querySelectorAll('li')].filter(
              (node) => node.textContent === label,
            ).length !== 2
          )
            await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return performance.now() - start;
        },
        { version, label, i },
      );
    version++;
    latencies.push(latency);
  }
  const journalBytes = p.world.journal.bytes - journalBefore,
    appJournalBytes = (await docBytes()) - appJournalBefore,
    wire = {
      received: received - networkBefore.received,
      sent: sent - networkBefore.sent,
      requests: requests - networkBefore.requests,
    };
  const wireRpc = async (action, args, requestId) => {
    const response = await fetch(
      'http://127.0.0.1:' + server.address().port + '/rpc',
      {
        method: 'POST',
        body: JSON.stringify({ action, input: { args, requestId } }),
      },
    );
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  };
  const concurrentStart = performance.now();
  const conflicts = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      wireRpc(
        'put',
        [
          version,
          { id: 500 + i, title: 'Concurrent ' + i, amount: i, open: true },
        ],
        'parallel-' + i,
      ),
    ),
  );
  const concurrencyMs = performance.now() - concurrentStart;
  assert.equal(
    conflicts.filter((r) => JSON.parse(r.valueWire).Ok !== undefined).length,
    1,
  );
  version++;
  let successfulAttempts = 0;
  const successStart = performance.now();
  await Promise.all(
    Array.from({ length: 16 }, async (_, i) => {
      for (let attempt = 0; attempt < 32; attempt++) {
        const state = JSON.parse((await wireRpc('dashboard')).valueWire);
        successfulAttempts++;
        const result = await wireRpc(
          'put',
          [
            state.version,
            { id: 600 + i, title: 'Closed ' + i, amount: i, open: false },
          ],
          'successful-' + i + '-' + attempt,
        );
        if (JSON.parse(result.valueWire).Ok !== undefined) return;
      }
      throw Error('Concurrent retry budget exhausted');
    }),
  );
  const successfulMs = performance.now() - successStart;
  version += 16;
  loseReply = true;
  const retry = await page.evaluate(async (version) => {
    const input = {
      args: [
        version,
        { id: 1, title: 'Recovered reply', amount: 7, open: true },
      ],
      requestId: 'deliberately-lost',
    };
    let lost = false;
    try {
      await rpc('put', null, null, input);
    } catch {
      lost = true;
    }
    const result = await rpc('put', null, null, input);
    return { lost, valueWire: result.valueWire };
  }, version);
  assert.equal(retry.lost, true);
  version++;
  const beforeAbort = p.world.version;
  const aborted = await f.call('abort_edit', [
    { id: 999, title: 'Abort', amount: 999, open: true },
  ]);
  assert.equal(aborted.output.committed, false);
  assert.equal(p.world.version, beforeAbort);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('li')].filter(
        (n) => n.textContent === 'Recovered reply',
      ).length === 2,
  );
  const beforeRecovery = (await f.call('dashboard', [0, 20])).valueWire,
    queryReads = p.inkViews.reads.reads,
    queryHits = p.inkViews.reads.hits,
    processTreeRss = await rss(),
    browserHeap = await page.evaluate(
      () => performance.memory?.usedJSHeapSize ?? null,
    );
  const recoveryStart = performance.now(),
    jobs = p.code.nativeJobs;
  stop();
  await p.inkViews.close();
  await p.code.close();
  p.collaboration.fixtureRetired = true;
  for (const task of p.collaboration.documents.values()) {
    const doc = await task;
    clearTimeout(doc.projectTimer);
    await doc.tail;
    await doc.journal.sync();
    await doc.journal.close();
  }
  await p.collaboration.textWorkers.close();
  p = await f.open();
  p.collaboration = new Collaboration({
    directory: f.directory,
    world: p.world,
  });
  await p.collaboration.index();
  p.code.nativeJobs = jobs;
  p.inkViews = await new InkViews({ platform: p }).open();
  cleanups.push(() => p.inkViews.close());
  stop = p.world.subscribe((event) => {
    if (
      event.type === 'ink-state' ||
      (event.type === 'object' &&
        event.object.kind === 'state' &&
        event.object.title === 'ink-app:state')
    )
      for (const stream of streams) stream.write('data: {}\n\n');
  });
  await page.evaluate(() =>
    Promise.all(
      Object.values(controllers).map((controller) => controller.reopen()),
    ),
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('li')].filter(
        (n) => n.textContent === 'Recovered reply',
      ).length === 2,
  );
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const recoveryMs = performance.now() - recoveryStart,
    restored = await runInstalledInk(
      p,
      f.deployed.apps.tables.appId,
      { entry: 'dashboard', input: '[0,20]' },
      owner,
    );
  assert.equal(restored.valueWire, beforeRecovery);
  assert.deepEqual(errors, []);
  const uiErrors = await page.evaluate(() => uiErrors);
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      mode,
      system: f.packet.graph.identity,
      compiler: f.packet.graph.units[0].modules.compiler,
      planSteps: f.packet.graph.units[0].implementation.steps,
      setup: {
        buildMs: f.buildMs,
        deployMs: f.deployMs,
        nativeBuildMs: f.nativeBuildMs,
        startupMs,
      },
      workload: {
        seedRows: 64,
        edits: 16,
        pageRows: 20,
        apps: 2,
        concurrentRequests: 16,
      },
      editToPaint: {
        samplesMs: latencies,
        p50Ms: latencies[7],
        p95Ms: latencies[15],
      },
      concurrency: {
        durationMs: concurrencyMs,
        requestsPerSecond: 16000 / concurrencyMs,
        committed: 1,
        conflicts: 15,
        includeHttp: true,
        successful: {
          commits: 16,
          attempts: successfulAttempts,
          durationMs: successfulMs,
          commitsPerSecond: 16000 / successfulMs,
        },
      },
      persisted: {
        worldJournalBytes: journalBytes,
        appJournalBytes,
        bytesPerEdit: (journalBytes + appJournalBytes) / 16,
        scope:
          'Authoritative collaboration WAL plus World projection WAL; includes Ink transaction payloads/receipts; excludes checkpoint replacement and filesystem metadata',
      },
      transferred: {
        ...wire,
        bytesPerEdit: (wire.received + wire.sent) / 16,
        scope:
          'HTTP RPC request/response bodies; excludes headers, SSE notifications and initial source/assets',
      },
      memory: {
        peakNodeRss,
        processTreeRss,
        scope:
          'RSS sum of this Node process and its descendants at one steady-state sample; shared pages may be counted more than once',
        browserHeap,
      },
      sharedQueries: { reads: queryReads, hits: queryHits },
      recoveryMs,
      validation: {
        conflicts: true,
        abortedChanges: true,
        lostReply: true,
        duplicateReceipt: true,
        restoredWire: true,
        uiErrors,
      },
    }),
  );
} finally {
  clearInterval(memoryTimer);
  stop();
  await page
    .evaluate(() =>
      Object.values(controllers || {}).forEach((c) => c.dispose()),
    )
    .catch(() => {});
  await browser.close();
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  for (const cleanup of cleanups.reverse()) await cleanup();
}
