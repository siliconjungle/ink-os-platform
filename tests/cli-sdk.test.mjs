import test from 'node:test';
import assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { readFile } from 'node:fs/promises';

test('the bundled CLI SDK watches typed rows and preserves selection/preview APIs', async (t) => {
  const listeners = new Map(),
    origin = 'https://desktop.example.invalid',
    namespace = 'a'.repeat(32),
    parent = { postMessage() {} },
    window = {};
  let reads = 0,
    next;
  const add = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  const port = {
    start() {},
    postMessage(message) {
      if (message.type !== 'request') return;
      assert.equal(message.method, 'world.query');
      reads++;
      queueMicrotask(() =>
        port.onmessage({
          data: {
            type: 'response',
            id: message.id,
            result: {
              format: 'ink-relational-v1',
              rows: [{ value: reads }],
              tables: [],
              dependencies: [{ namespace }],
              version: reads,
              total: 1,
            },
          },
        }),
      );
    },
  };
  const context = createContext({
    window,
    parent,
    location: {
      search: '?desktopOrigin=' + encodeURIComponent(origin),
      origin: 'https://app.example.invalid',
    },
    document: { addEventListener() {}, querySelectorAll: () => [] },
    addEventListener: add,
    removeEventListener: (type, listener) =>
      listeners.get(type)?.delete(listener),
    URL,
    URLSearchParams,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance,
    crypto: globalThis.crypto,
  });
  new Script(
    await readFile(new URL('../cli/templates/sdk.js', import.meta.url), 'utf8'),
  ).runInContext(context);
  const connecting = window.Ink.connect();
  for (const listener of [...listeners.get('message')])
    listener({
      source: parent,
      origin,
      data: {
        source: 'ink-desktop',
        version: 1,
        type: 'connect',
        instance: 'fixture',
        snapshot: { namespace },
      },
      ports: [port],
    });
  const client = await connecting;
  assert.equal(typeof client.desktop.preview, 'function');
  assert.equal(typeof client.selection.set, 'function');
  const query = {
      format: 'ink-relational-v1',
      relation: { op: 'scan', namespace, tableId: 'b'.repeat(32), as: 'row' },
    },
    seen = [],
    watch = client.world.watch(query, (result) => {
      seen.push(result);
      next?.(result);
      next = null;
    });
  t.after(() => watch.unsubscribe());
  assert.equal((await watch.ready).rows[0].value, 1);
  const updated = new Promise((resolve) => (next = resolve));
  port.onmessage({
    data: {
      type: 'world.delta',
      data: { objects: [{ namespace, kind: 'ink-table-row' }] },
    },
  });
  assert.equal((await updated).rows[0].value, 2);
  assert.equal(seen.length, 2);
  watch.unsubscribe();
});
