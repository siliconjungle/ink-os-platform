import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { uiFixture, owner } from '../tests/ink-ui-fixture.mjs';
import { buildInkApp, inkExecutionSource } from '../server/ink-apps.mjs';
import { NativeInk } from '../server/native-ink.mjs';
import {
  StorageFixture,
  scopeStorageQuery,
} from '../server/data-path-workload.mjs';
const cleanup = [],
  native = process.argv.includes('--native');
let browser, server;
try {
  const { p, directory } = await uiFixture({
      after: (fn) => cleanup.unshift(fn),
    }),
    root = new URL('../examples/planned-storage/', import.meta.url),
    manifest = JSON.parse(
      await readFile(new URL('ink-app.json', root), 'utf8'),
    );
  const files = await Promise.all(
    ['main.ink', 'ui.ink', 'storage-workload.json'].map(async (path) => ({
      path,
      base64: (await readFile(new URL(path, root))).toString('base64'),
    })),
  );
  const bundle = await buildInkApp(manifest, files),
    app = await p.createApp({
      slug: 'planned-storage-browser',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  if (native) {
    const driver = new NativeInk(join(directory, 'native'), {
        offline: process.env.INK_NATIVE_OFFLINE === '1',
      }),
      artifact = await driver.build(
        await inkExecutionSource(bundle.ink, bundle.files),
        { namespace: app.id },
      );
    p.code.nativeJobs = {
      native: driver,
      readyFor: async (id) => (id === app.id ? artifact.id : null),
    };
  }
  const workload = JSON.parse(Buffer.from(files[2].base64, 'base64'));
  for (const record of new StorageFixture(workload, {
    namespace: app.id,
  }).all())
    await p.world.create(record);
  server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/sdk/')) {
        const name = req.url.slice(5);
        if (!/^[a-z-]+\.js$/.test(name)) throw Error('Invalid module');
        res.setHeader('Content-Type', 'text/javascript');
        res.end(await readFile(new URL('../sdk/src/' + name, import.meta.url)));
        return;
      }
      if (req.url === '/rpc') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { action, id, input } = JSON.parse(body);
        if (!['open', 'refresh', 'dispose'].includes(action))
          throw Error('Unsupported verification request');
        const result =
          action === 'open'
            ? await p.inkViews.openApp(app.id, owner)
            : await p.inkViews[action](id, owner, input);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end('<main id="first"></main><main id="second"></main>');
    } catch (error) {
      res.statusCode = error.status || 500;
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.INK_UI_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(async () => {
    const { mountInkUi } = await import('/sdk/ui-runtime.js');
    globalThis.controllers = [];
    globalThis.uiErrors = [];
    const rpc = async (action, id, input) => {
      const r = await fetch('/rpc', {
          method: 'POST',
          body: JSON.stringify({ action, id, input }),
        }),
        value = await r.json();
      if (!r.ok) throw Error(value.error);
      return value;
    };
    for (const id of ['first', 'second'])
      controllers.push(
        await mountInkUi({
          element: document.getElementById(id),
          transport: {
            open: () => rpc('open'),
            refresh: (id, input) => rpc('refresh', id, input),
            dispose: (id) => rpc('dispose', id, {}),
          },
          onError: (e) => uiErrors.push(e.message),
        }),
      );
  });
  assert.equal(await page.locator('li').count(), 40);
  assert.equal(p.inkViews.queries.reads, 1);
  const row = p.world
      .all()
      .find(
        (o) =>
          o.namespace === app.id &&
          o.kind === 'ink-table-row' &&
          JSON.parse(o.body).key === '1',
      ),
    body = JSON.parse(row.body);
  await p.world.update(row.id, {
    body: JSON.stringify({
      ...body,
      values: { ...body.values, title: 'Held-out browser edit', score: 999 },
    }),
  });
  await page.evaluate(() => Promise.all(controllers.map((c) => c.refresh())));
  assert.equal(
    await page.getByText('Held-out browser edit', { exact: true }).count(),
    2,
  );
  assert.equal(p.inkViews.queries.reads, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => uiErrors), []);
  const manager = [...p.inkViews.queries.plans.values()][0],
    query = scopeStorageQuery(manifest.ui.components[0].query, app.id),
    result = manager.query('page', { ...query, explain: true });
  assert.equal(result.plan.admission.fallback, null);
  console.log(
    JSON.stringify(
      {
        target: native ? 'native' : 'javascript',
        rows: 512,
        panes: 2,
        renderedRows: 40,
        queryReads: 2,
        sharedHits: p.inkViews.queries.hits,
        admission: result.plan.admission,
        stats: result.plan.stats,
        scope:
          'Actual compiled Ink UI, loopback owner fixture and headless Chrome DOM; excludes production authentication, desktop packaging and physical paint.',
      },
      null,
      2,
    ),
  );
  await page.evaluate(() => controllers.forEach((c) => c.dispose()));
} finally {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  for (const fn of cleanup) await fn();
}
