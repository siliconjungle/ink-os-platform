// End-to-end edit-to-screen latency in the real desktop at large table sizes.
//
//   npx vite build
//   INK_UI_BROWSER_EXECUTABLE=/path/to/chrome node scripts/benchmark-ink-scale-browser.mjs \
//     [--rows 100000] [--edits 9] [--plan on|off|both] [--output FILE] [--note TEXT]
//
// For each plan setting, a fresh production host (scripts/start.mjs, built
// desktop from dist/) deploys examples/tables-system, extended with a bulk
// `seed` change, and seeds --rows rows (one in ten open). With `--plan on`
// the dashboard's link carries a plan (its own filter `amount >= 5`, a page
// of 20 and a sum), evaluated next to a read-only copy of Tables; with
// `--plan off` it reads the provider's 20-row page directly.
//
// The desktop opens Tables and the dashboard as windows; both receive live
// delivery (watch long-polls). Each edit commits through the HTTP API and
// renames an open row on the first page. Inside each frame a mutation
// observer records when the new title first appears. Latency is that time
// minus the moment just before the commit request was sent (same host clock).
// Physical paint is not measured.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, cpus, platform as os, arch } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { loadInkSystem } from '../cli/bin/ink-system.mjs';
import { extendTables, planned } from '../tests/ink-system-fixture.mjs';

const args = process.argv.slice(2),
  option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback),
  rows = Number(option('--rows', '100000')),
  edits = Number(option('--edits', '9')),
  plans = { on: [true], off: [false], both: [false, true] }[option('--plan', 'both')];
if (!Number.isInteger(rows) || rows < 1000 || rows > 200000 || !Number.isInteger(edits) || edits < 3 || edits > 50 || !plans)
  throw Error('Use 1000–200000 rows, 3–50 edits and --plan on|off|both');
const SEED = `
change seed(keys:List<u64>,rows:List<Row>)->Result<Unit,String> reads(Rows,Version) writes(Rows,Version){Version=Version+1;return Rows.put_many(keys,rows);}
`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(plan) {
  const root = await mkdtemp(join(tmpdir(), 'ink-scale-browser-')),
    directory = join(root, 'data');
  await writeFile(join(root, 'storage-retention.json'), JSON.stringify({ keep: { data: 'Scale benchmark instance.' }, safe_to_remove: {} }));
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
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME|LANG|LC_ALL|TMPDIR|NODE_OPTIONS)$/.test(k))),
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
    const input = await loadInkSystem(new URL('../examples/tables-system/', import.meta.url).pathname);
    // The extended source no longer matches Tables' recorded optimisation plan.
    input.apps[0].manifest.optimisation = { version: 1, mode: 'baseline' };
    input.apps[0].files = input.apps[0].files.filter((f) => f.path !== 'selected.plan.json');
    extendTables(input, SEED, ['seed']);
    if (plan) planned({ version: 1, where: 'big', limit: 20, aggregate: { op: 'sum', value: 'amount' } }, { twin: false, input: JSON.stringify([0, rows]) })(input);
    const apps = (await call('/ink/systems/deploy', { input })).apps,
      tables = apps.tables.appId,
      run = (entry, value) => call('/apps/' + tables + '/ink/run', { entry, input: JSON.stringify(value) });

    // Seed in bulk commits; one row in ten is open.
    const seedStart = performance.now();
    for (let start = 1; start <= rows; start += 2000) {
      const keys = [],
        values = [];
      for (let id = start; id < Math.min(start + 2000, rows + 1); id++) {
        keys.push(id);
        values.push({ id, title: 'Item ' + id, amount: id % 7, open: id % 10 === 0 });
      }
      assert.match((await run('seed', [keys, values])).valueWire, /"Ok"/);
    }
    const seedMs = performance.now() - seedStart;

    browser = await chromium.launch({ executablePath: process.env.INK_UI_BROWSER_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    assert.equal((await context.request.post(url + '/login', { data: { token } })).status(), 200);
    // Each frame records when each edited title first appears.
    await context.addInitScript(() => {
      const seen = (globalThis.__editSeen = {});
      const scan = () => {
        for (const match of (document.body?.innerText || '').matchAll(/Edit (\d+)/g)) seen[match[1]] ??= Date.now();
      };
      new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
    });
    const page = await context.newPage();
    await page.goto(url + '/');
    await page.waitForFunction(() => document.querySelector('.desktop-dock'), null, { timeout: 60000 });
    const openStart = Date.now();
    // The desktop opens a window from the hash once it has loaded the app's
    // registration; with a large World that can take a while, so retry.
    for (const appId of [tables, apps.dashboard.appId]) {
      const before = page.frames().length;
      for (let i = 0; i < 120 && page.frames().length === before; i++) {
        if (i % 10 === 0) await page.evaluate((id) => {
          location.hash = '';
          location.hash = '#x/' + id;
        }, appId);
        await pause(200);
      }
    }
    const frames = async () =>
      (
        await Promise.all(
          page.frames().map(async (frame) => ({ frame, text: await frame.evaluate(() => document.body?.innerText || '').catch(() => '') })),
        )
      ).filter((f) => /Open total:/.test(f.text));
    // Both windows show their first page (Tables shows its form as well).
    let shown;
    for (let i = 0; i < 600; i++) {
      shown = await frames();
      if (shown.length === 2 && shown.every((f) => /Item 10\b/.test(f.text) || /Item 40\b/.test(f.text))) break;
      await pause(100);
    }
    if (shown.length !== 2) {
      const texts = await Promise.all(page.frames().map((f) => f.evaluate(() => document.body?.innerText || '').catch((e) => 'unreadable: ' + e.message)));
      throw Error('Both windows did not render their data: ' + JSON.stringify(texts.map((t) => t.slice(0, 300))) + '\n' + log.slice(-1500));
    }
    const openMs = Date.now() - openStart;
    const named = Object.fromEntries(shown.map((f) => [/Open orders dashboard/.test(f.text) ? 'dashboard' : 'tables', f.frame]));
    assert.deepEqual(Object.keys(named).sort(), ['dashboard', 'tables']);
    await pause(1500);

    // Each edit renames row 40, which is open, on both first pages and (amount
    // >= 5) admitted by the plan.
    const sent = {},
      writeMs = [];
    for (let n = 1; n <= edits; n++) {
      const version = Number(JSON.parse((await run('dashboard', [0, 1])).valueWire).version);
      sent[n] = Date.now();
      const t = performance.now();
      assert.match((await run('put', [version, { id: 40, title: 'Edit ' + n, amount: 50 + n, open: true }])).valueWire, /"Ok"/);
      writeMs.push(performance.now() - t);
      // Wait until both windows show it before the next edit.
      for (let i = 0; i < 600; i++) {
        const seen = await Promise.all(Object.values(named).map((f) => f.evaluate((k) => globalThis.__editSeen[k], String(n)).catch(() => undefined)));
        if (seen.every(Boolean)) break;
        await pause(20);
      }
      await pause(200);
    }
    const latency = {};
    for (const [name, frame] of Object.entries(named)) {
      const seen = await frame.evaluate(() => globalThis.__editSeen);
      latency[name] = Object.keys(sent).map((n) => (seen[n] ? seen[n] - sent[n] : null));
      assert.ok(latency[name].every((x) => x !== null), name + ' showed every edit');
    }
    return {
      plan,
      seedMs: Math.round(seedMs),
      openMs,
      writeMs: Math.round(median(writeMs) * 10) / 10,
      editToScreenMs: Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, { median: median(v), max: Math.max(...v), samples: v }])),
    };
  } finally {
    await browser?.close().catch(() => {});
    if (host && host.exitCode === null) {
      host.kill('SIGTERM');
      await once(host, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
}

const runs = [];
for (const plan of plans) runs.push(await measure(plan));
const report = {
  schema: 1,
  recordedAt: new Date().toISOString(),
  host: { platform: os(), arch: arch(), node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length },
  scope:
    'Production host and built desktop in headless Chromium; examples/tables-system with a bulk seed; one in ten rows open. Edit-to-screen is the time from just before the commit request until the new title appears in each window (mutation observer, host clock); physical paint is not measured. Medians of --edits edits, one at a time.',
  workload: { rows, openRows: Math.floor(rows / 10), edits },
  compilerSha256: JSON.parse(await readFile(new URL('../dist/compiler-info.json', import.meta.url), 'utf8').catch(() => readFile(new URL('../public/compiler-info.json', import.meta.url), 'utf8'))).sha256,
  ...(option('--note') ? { note: option('--note') } : {}),
  runs,
};
const path = option('--output');
if (path) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
