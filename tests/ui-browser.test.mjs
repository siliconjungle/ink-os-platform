import test from 'node:test';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { uiFixture, owner } from './ink-ui-fixture.mjs';
test(
  'browser controls retain identity, drafts, focus and IME state through Ink patches',
  { skip: process.env.INK_TEST_UI_BROWSER !== '1', timeout: 60000 },
  async () => {
    const cleanups = [];
    const { p, app } = await uiFixture({ after: (fn) => cleanups.push(fn) });
    const server = createServer(async (req, res) => {
      try {
        if (req.url.startsWith('/sdk/')) {
          const path = req.url.slice(5);
          if (!/^[a-z-]+\.js$/.test(path)) throw Error('path');
          res.setHeader('Content-Type', 'text/javascript');
          res.end(
            await readFile(new URL('../sdk/src/' + path, import.meta.url)),
          );
          return;
        }
        if (req.url === '/rpc') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const { method, id, input } = JSON.parse(body);
          let value;
          if (method === 'open')
            value = await p.inkViews.openApp(app.id, owner, input);
          else value = await p.inkViews[method](id, owner, input);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(value));
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end('<main id="app"></main><main id="other"></main>');
      } catch (error) {
        res.statusCode = error.status || 500;
        res.end(
          JSON.stringify({ error: error.message, current: error.current }),
        );
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch({
      executablePath: process.env.INK_UI_BROWSER_EXECUTABLE,
      headless: true,
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(url);
      await page.evaluate(async () => {
        const { mountInkUi } = await import('/sdk/ui-runtime.js');
        globalThis.errors = [];
        globalThis.life = [];
        const rpc = async (method, id, input) => {
          const r = await fetch('/rpc', {
              method: 'POST',
              body: JSON.stringify({ method, id, input }),
            }),
            value = await r.json();
          if (!r.ok)
            throw Object.assign(Error(value.error), {
              status: r.status,
              current: value.current,
            });
          if (method === 'event' && globalThis.loseNextEvent) {
            globalThis.loseNextEvent = false;
            throw Error('Simulated lost acknowledgement');
          }
          return value;
        };
        globalThis.controller = await mountInkUi({
          element: document.querySelector('#app'),
          transport: {
            open: (input) => rpc('open', null, input),
            refresh: (id, input) => rpc('refresh', id, input),
            event: (id, input) => rpc('event', id, input),
            dispose: (id) => rpc('dispose', id, {}),
          },
          onLifecycle: (e) => life.push(e),
          onError: (e) => errors.push(e.message),
        });
        globalThis.field = document.querySelector('input');
      });
      await page.locator('input').fill('First');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.locator('li').filter({ hasText: 'First' }).waitFor();
      await page.waitForFunction(() => !controller.pending);
      assert.equal(
        await page.evaluate(() => field === document.querySelector('input')),
        true,
      );
      assert.equal(await page.locator('input').inputValue(), '');
      await page.locator('input').fill('Unsent draft');
      await page.locator('input').focus();
      await page.evaluate(() => field.setSelectionRange(3, 7));
      await page.evaluate(() => controller.refresh());
      assert.deepEqual(
        await page.evaluate(() => [
          field.value,
          document.activeElement === field,
          field.selectionStart,
          field.selectionEnd,
        ]),
        ['Unsent draft', true, 3, 7],
      );
      await page.getByRole('button', { name: 'Second', exact: true }).click();
      await page.waitForFunction(() => !controller.pending);
      assert.equal(await page.locator('input').inputValue(), 'Unsent draft');
      assert.equal(
        await page.evaluate(
          () =>
            life.filter((e) => e.type === 'mount' && e.kind === 'Field').length,
        ),
        1,
      );
      await page.evaluate(() => {
        globalThis.loseNextEvent = true;
      });
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.waitForFunction(
        () =>
          controller.pending &&
          errors.includes('Simulated lost acknowledgement'),
      );
      await page.locator('input').fill('Typed during retry');
      await page.evaluate(() => controller.retry());
      assert.equal(
        await page.locator('li').filter({ hasText: 'Unsent draft' }).count(),
        1,
      );
      assert.equal(
        await page.locator('input').inputValue(),
        'Typed during retry',
      );
      const direct = await page.evaluate(async () => {
        const { createDomUi, UI_FORMAT } = await import('/sdk/ui-runtime.js');
        const props = {
          text: '',
          value: '',
          checked: false,
          disabled: false,
          label: '',
          description: '',
          selected: false,
          invalid: false,
          placeholder: '',
          fieldKind: 'Text',
          options: [],
          valueToken: '',
        };
        const node = (id, kind, children = [], extra = {}) => ({
          id,
          kind,
          children,
          props: { ...props, ...extra },
          events: [],
        });
        const nodes = [
          node('root', 'Column', ['list', 'field', 'select']),
          node('list', 'List', ['a', 'b']),
          node('a', 'Item', [], { text: 'A' }),
          node('b', 'Item', [], { text: 'B' }),
          node('field', 'Field', [], {
            label: 'Draft',
            value: 'server',
            valueToken: 'a'.repeat(32),
          }),
          node('select', 'Select', [], {
            label: 'Choice',
            value: 'a',
            valueToken: 'a'.repeat(32),
            options: [
              { value: 'a', label: 'A', disabled: false },
              { value: 'b', label: 'B', disabled: false },
            ],
          }),
        ];
        const lifecycle = [];
        const ui = createDomUi(document.querySelector('#other'), {
            onLifecycle: (e) => lifecycle.push(e),
          }),
          frame = (revision) => ({
            format: UI_FORMAT,
            revision,
            baseRevision: revision - 1,
            tree: {
              format: UI_FORMAT,
              root: 'root',
              nodes: structuredClone(nodes),
            },
          });
        ui.apply(frame(1));
        const field = ui.records.get('field').input,
          select = ui.records.get('select').input;
        field.focus();
        field.value = 'draft';
        field.dispatchEvent(new Event('input'));
        field.setSelectionRange(2, 4);
        select.value = 'b';
        select.dispatchEvent(new Event('change'));
        nodes[1].children = ['b', 'a'];
        nodes[4].props.value = 'remote';
        nodes[4].props.valueToken = 'b'.repeat(32);
        nodes[5].props.options.reverse();
        ui.apply(frame(2));
        const after = [
          field.value,
          document.activeElement === field,
          field.selectionStart,
          field.selectionEnd,
          select.value,
          !ui.records.get('field').conflict.hidden,
        ];
        ui.records.get('field').conflict.click();
        const adopted = field.value;
        // On browsers without moveBefore, an IME edit defers subtree moves until composition ends.
        ui.records.get('root').slot.moveBefore = undefined;
        field.dispatchEvent(new CompositionEvent('compositionstart'));
        nodes[0].children = ['select', 'field', 'list'];
        ui.apply(frame(3));
        const held =
          ui.records.get('root').slot.lastChild === select.parentElement;
        field.dispatchEvent(new CompositionEvent('compositionend'));
        const reordered =
          ui.records
            .get('root')
            .slot.querySelector(':scope > [data-ink-ui-id]') ===
          select.parentElement;
        ui.dispose();
        return {
          after,
          adopted,
          held,
          reordered,
          mounts: lifecycle.filter((e) => e.type === 'mount').length,
          disposals: lifecycle.filter((e) => e.type === 'dispose').length,
        };
      });
      assert.deepEqual(direct.after, ['draft', true, 2, 4, 'b', true]);
      assert.equal(direct.adopted, 'remote');
      assert.equal(direct.held, true);
      assert.equal(direct.reordered, true);
      assert.equal(direct.mounts, direct.disposals);
      assert.deepEqual(await page.evaluate(() => errors), [
        'Simulated lost acknowledgement',
      ]);
      assert.deepEqual(errors, []);
      await page.evaluate(() => controller.dispose());
      console.log(
        JSON.stringify({
          result: 'passed',
          checks: [
            'real Ink form events and keyed list changes',
            'stable field identity and caret',
            'navigation preserves drafts',
            'remote draft conflict and explicit adoption',
            'select draft during option reorder',
            'IME subtree move deferral',
            'balanced mount/dispose',
          ],
          direct,
        }),
      );
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
      for (const fn of cleanups.reverse()) await fn();
    }
  },
);
