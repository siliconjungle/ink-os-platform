import test from 'node:test';
import assert from 'node:assert/strict';
import { api, uploadFile } from '../src/api.ts';

test('desktop reads and file uploads construct valid HTTP headers with the server actor contract', async t => {
  const previousFetch = globalThis.fetch, previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), calls = [];
  t.after(() => { globalThis.fetch = previousFetch; if (!previousStorage) delete globalThis.localStorage; else Object.defineProperty(globalThis, 'localStorage', previousStorage); });
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'Agent / preview' }, configurable: true, writable: true });
  globalThis.fetch = async (path, init) => {
    const request = new Request(new URL(path, 'http://localhost'), init);
    calls.push(request);
    return Response.json(path.startsWith('/api/v1/files') ? { objects: [] } : { objects: [{ id: 'app' }] });
  };
  assert.equal((await api('/world')).objects[0].id, 'app');
  assert.deepEqual(await uploadFile(new File(['pixels'], 'image.png', { type: 'image/png' })), { objects: [] });
  assert.equal(calls.length, 2);
  for (const request of calls) assert.equal(decodeURIComponent(request.headers.get('x-ink-actor')), 'Agent / preview');
});
