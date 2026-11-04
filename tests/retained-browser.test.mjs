import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { systemFixture, owner } from './ink-system-fixture.mjs';
import { watchInkUi } from '../server/ink-ui.mjs';
test(
  'live browser patches preserve drafts, reject duplicate/gapped delivery and recover lost query and event replies',
  { skip: process.env.INK_TEST_UI_BROWSER !== '1', timeout: 120000 },
  async () => {
    const cleanups = [],
      f = await systemFixture(
        { after: (fn) => cleanups.push(fn) },
        { collaborative: true },
      ),
      p = f.p;
    const server = createServer(async (req, res) => {
      try {
        if (req.url.startsWith('/sdk/')) {
          const name = req.url.slice(5);
          if (!/^[a-z-]+\.js$/.test(name)) throw Error('module');
          res.setHeader('Content-Type', 'text/javascript');
          res.end(
            await readFile(new URL('../sdk/src/' + name, import.meta.url)),
          );
          return;
        }
        if (req.url === '/rpc') {
          let text = '';
          for await (const bytes of req) text += bytes;
          const { action, name, id, input } = JSON.parse(text);
          let value;
          if (action === 'open')
            value = await p.inkViews.openApp(
              f.deployed.apps[name].appId,
              owner,
            );
          else if (action === 'watch')
            value = await watchInkUi(p.inkViews, id, owner, input, res);
          else if (action === 'put') value = await f.call('put', input);
          else value = await p.inkViews[action](id, owner, input);
          if (!res.destroyed) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(value));
          }
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end('<main id="tables"></main><main id="dashboard"></main>');
      } catch (error) {
        if (!res.destroyed) {
          res.statusCode = error.status || 500;
          res.end(
            JSON.stringify({ error: error.message, current: error.current }),
          );
        }
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.INK_UI_BROWSER_EXECUTABLE,
      }),
      page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.evaluate(async () => {
        const { mountInkUi } = await import('/sdk/ui-runtime.js');
        globalThis.errors = [];
        globalThis.counts = {};
        globalThis.controllers = {};
        globalThis.inject = {};
        globalThis.duplicate = {};
        globalThis.dropEvent = false;
        globalThis.rpc = async (action, name, id, input) => {
          counts[action] = (counts[action] || 0) + 1;
          const response = await fetch('/rpc', {
              method: 'POST',
              body: JSON.stringify({ action, name, id, input }),
            }),
            value = await response.json();
          if (!response.ok)
            throw Object.assign(Error(value.error), {
              status: response.status,
              current: value.current,
            });
          return value;
        };
        for (const name of ['tables', 'dashboard'])
          controllers[name] = await mountInkUi({
            element: document.querySelector('#' + name),
            transport: {
              open: () => rpc('open', name),
              refresh: (id, input) => rpc('refresh', name, id, input),
              dispose: (id) => rpc('dispose', name, id, {}),
              event: async (id, input) => {
                const value = await rpc('event', name, id, input);
                if (dropEvent) {
                  dropEvent = false;
                  throw Error('Lost acknowledgement');
                }
                return value;
              },
              watch: async (id, input) => {
                if (duplicate[name]) {
                  const value = duplicate[name];
                  delete duplicate[name];
                  return value;
                }
                const value = await rpc('watch', name, id, input),
                  fault = inject[name];
                delete inject[name];
                if (fault === 'duplicate')
                  duplicate[name] = structuredClone(value);
                if (fault === 'gap') value.updates.sequence += 1;
                if (fault === 'lost') throw Error('Lost query reply');
                return value;
              },
            },
            onError: (error) => errors.push(error.message),
          });
        globalThis.beforeField = document.querySelector('#tables input');
        beforeField.focus();
        beforeField.value = 'Keep this draft';
        beforeField.setSelectionRange(2, 6);
        beforeField.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const waitTitle = (title) =>
        page.waitForFunction(
          (title) =>
            [...document.querySelectorAll('li')].filter(
              (node) => node.textContent === title,
            ).length === 2,
          title,
        );
      await page.evaluate(() => {
        inject.tables = 'duplicate';
      });
      await f.call(
        'put',
        [0, { id: 1, title: 'First', amount: 7, open: true }],
        { requestId: 'browser-first' },
      );
      await waitTitle('First');
      assert.deepEqual(
        await page.evaluate(() => [
          beforeField === document.querySelector('#tables input'),
          beforeField.value,
          document.activeElement === beforeField,
          beforeField.selectionStart,
          beforeField.selectionEnd,
        ]),
        [true, 'Keep this draft', true, 2, 6],
      );
      assert.equal(await page.evaluate(() => counts.refresh || 0), 0);
      await page.evaluate(() => {
        inject.dashboard = 'lost';
      });
      await f.call(
        'put',
        [1, { id: 1, title: 'Reconnect', amount: 8, open: true }],
        { requestId: 'browser-second' },
      );
      await waitTitle('Reconnect');
      await page.evaluate(() => {
        inject.tables = 'gap';
      });
      await f.call(
        'put',
        [2, { id: 1, title: 'Reset', amount: 9, open: true }],
        { requestId: 'browser-third' },
      );
      await waitTitle('Reset');
      assert.equal(await page.evaluate(() => counts.refresh), 1);
      assert.equal(
        await page.evaluate(() => beforeField.value),
        'Keep this draft',
      );
      await page.evaluate(() => {
        dropEvent = true;
        document.querySelector('#tables form').requestSubmit();
      });
      await page.waitForFunction(
        () => controllers.tables.pending && !dropEvent,
      );
      const beforeRetry = JSON.parse(
        (await f.call('dashboard', [0, 20])).valueWire,
      ).version;
      await page.evaluate(() => controllers.tables.retry());
      await page.waitForFunction(
        () =>
          !controllers.tables.pending &&
          document.querySelector('#tables input').value === '',
      );
      const afterRetry = JSON.parse(
        (await f.call('dashboard', [0, 20])).valueWire,
      ).version;
      assert.equal(afterRetry, beforeRetry);
      assert.equal(afterRetry, 4);
      await waitTitle('Keep this draft');
      assert.deepEqual(await page.evaluate(() => errors), [
        'Lost acknowledgement',
      ]);
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => counts.event), 2);
    } finally {
      await page
        .evaluate(() =>
          Object.values(controllers || {}).forEach((c) => c.dispose()),
        )
        .catch(() => {});
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  },
);
