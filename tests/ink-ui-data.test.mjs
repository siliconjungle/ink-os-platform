import test from 'node:test';
import assert from 'node:assert/strict';
import { uiFixture, uiFiles, source, owner, event } from './ink-ui-fixture.mjs';
import { buildInkApp } from '../server/ink-apps.mjs';
import { tableQuery } from '../sdk/src/relations.js';
import { Script, createContext } from 'node:vm';
const tableId = 'b'.repeat(32);
async function installData(p) {
  const code = source
    .replace(
      'fn editor()->UiView<Unit>',
      'record DataRow {title:String,note:Option<String>,}\nfn data_view(data:UiData<DataRow>)->UiView<Unit>{return UiView<Unit>{root:"data",nodes:[ui_text<Unit>("data",data.rows.map(fn(row)=>row.title).at_or(0,"Empty"))]};}\nfn editor()->UiView<Unit>',
    )
    .replace(
      '"editor-slot","rows-slot"',
      '"editor-slot","rows-slot","data-a","data-b"',
    )
    .replace(
      'ui_component<Bool>("rows-slot","rows")',
      'ui_component<Bool>("rows-slot","rows"),ui_component<Bool>("data-a","data"),ui_component<Bool>("data-b","data")',
    );
  const data = uiFiles(code);
  data.manifest.ui.components.push({
    name: 'data',
    entry: 'data_view',
    event: 'add',
    query: tableQuery('self', tableId, {
      select: ['title', 'note'],
      limit: 20,
      count: true,
    }),
  });
  data.manifest.modules.modules[0].exports.push('data_view');
  const bundle = await buildInkApp(data.manifest, data.files),
    app = await p.createApp({
      slug: 'data-ui',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  await p.world.create({
    id: tableId,
    namespace: app.id,
    kind: 'ink-table',
    title: 'Items',
    tags: ['ink-table:' + tableId],
    body: JSON.stringify({
      format: 'ink-table',
      version: 1,
      columns: [
        { key: 'title', type: 'text' },
        { key: 'note', type: 'text', nullable: true },
      ],
    }),
  });
  return app;
}
test('shared typed query snapshots invalidate only for their tables, including nullable row values', async (t) => {
  const { p } = await uiFixture(t),
    app = await installData(p),
    views = p.inkViews;
  const row = await p.world.create({
    namespace: app.id,
    kind: 'ink-table-row',
    tags: ['ink-table:' + tableId],
    body: JSON.stringify({
      format: 'ink-table-row',
      version: 1,
      tableId,
      key: 'one',
      values: { title: 'One', note: null },
    }),
  });
  const a = await views.openApp(app.id, owner),
    b = await views.openApp(app.id, owner);
  assert.equal(a.computed.filter((name) => name === 'data').length, 1);
  assert.equal(
    a.tree.nodes.filter((node) => node.props.text === 'One').length,
    2,
  );
  assert.equal(views.queries.reads, 1);
  assert.ok(views.queries.hits >= 1);
  await p.world.create({ namespace: app.id, kind: 'note', body: 'unrelated' });
  assert.deepEqual(
    (await views.refresh(a.id, owner, { revision: a.revision })).computed,
    [],
  );
  assert.equal(views.queries.reads, 1);
  const body = JSON.parse(row.body);
  await p.world.update(row.id, {
    body: JSON.stringify({ ...body, values: { title: 'Two', note: 'some' } }),
  });
  const changed = await views.refresh(a.id, owner, { revision: a.revision });
  assert.deepEqual(changed.computed, ['data']);
  assert.equal(views.queries.reads, 2);
  await views.refresh(b.id, owner, { revision: b.revision });
  assert.equal(views.queries.reads, 2);
  p.world.relationalStorage.reset();
  assert.deepEqual(
    (await views.refresh(a.id, owner, { revision: changed.revision })).computed,
    ['data'],
  );
  await p.world.erase([row.id]);
  const empty = await views.refresh(a.id, owner, { revision: 0 });
  assert.equal(
    empty.tree.nodes.filter((node) => node.props.text === 'Empty').length,
    2,
  );
});
test('typed previews isolate event state, parse the sandboxed runtime and dispose mounted resources', async (t) => {
  const { p, data } = await uiFixture(t),
    version = p.world.version,
    preview = await p.inkPreviews.create(owner, { files: data.files });
  const frame = await p.inkViews.openPreview(preview.id, owner),
    nav = frame.tree.nodes.find(
      (node) => node.kind === 'NavItem' && node.props.text === 'Second',
    );
  assert.equal(
    (await p.inkViews.event(frame.id, owner, event(frame, nav, 'Activate')))
      .event.status,
    'accepted',
  );
  assert.equal(p.world.version, version);
  const page = await p.inkPreviews.view(preview.id, owner),
    outer = page.html.match(
      /<script nonce="[a-f0-9]+">([\s\S]*)<\/script>$/,
    )[1],
    iframe = {};
  new Script(outer).runInContext(
    createContext({
      document: { querySelector: () => iframe },
      location: { origin: 'https://example.invalid' },
    }),
  );
  const inner = iframe.srcdoc.match(
    /<script type="module" nonce="[a-f0-9]+">([\s\S]*)<\/script>$/,
  )[1];
  assert.doesNotThrow(() => new Script(inner));
  assert.match(inner, /startTypedUi/);
  await p.inkPreviews.remove(preview.id, owner);
  assert.ok(!p.inkViews.mounts.has(frame.id));
  assert.throws(() => p.inkViews.refresh(frame.id, owner, { revision: 0 }), {
    status: 410,
  });
});
test('interface ownership, release fences, lease expiry, admission and disposal are enforced', async (t) => {
  let now = 100;
  const { p, app } = await uiFixture(t, { now: () => now, ttlMs: 50 }),
    views = p.inkViews,
    frame = await views.openApp(app.id, { ...owner, accountId: 'alice' });
  assert.throws(
    () =>
      views.refresh(frame.id, { ...owner, accountId: 'bob' }, { revision: 0 }),
    { status: 403 },
  );
  assert.throws(
    () =>
      views.refresh(
        frame.id,
        { appId: app.id, releaseId: 'f'.repeat(32) },
        { revision: 0 },
      ),
    { status: 403 },
  );
  await assert.rejects(views.openApp(app.id, owner, { target: 'native' }), {
    status: 501,
  });
  views.closeAdmission();
  assert.throws(() => views.refresh(frame.id, owner, { revision: 0 }), {
    status: 503,
  });
  views.resumeAdmission();
  now = 151;
  assert.throws(() => views.refresh(frame.id, owner, { revision: 0 }), {
    status: 410,
  });
  views.prune();
  assert.equal(views.mounts.size, 0);
  assert.equal(views.bytes, 0);
});
