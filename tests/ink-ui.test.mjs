import test from 'node:test';
import assert from 'node:assert/strict';
import { uiFixture, uiFiles, owner, event } from './ink-ui-fixture.mjs';
import { runInstalledInk, buildInkApp } from '../server/ink-apps.mjs';
const node = (frame, kind) =>
  frame.tree.nodes.find((node) => node.kind === kind);

test('typed UI mounts source-checked components and event input types, then updates only affected state dependencies', async (t) => {
  const { p, app } = await uiFixture(t),
    frame = await p.inkViews.openApp(app.id, owner);
  assert.deepEqual(frame.computed, ['root', 'editor', 'rows']);
  const form = node(frame, 'Form'),
    field = node(frame, 'Field'),
    submit = event(frame, form, 'Submit', {
      text: '',
      checked: false,
      expected: '',
      fields: [
        {
          id: field.id,
          text: 'Hello',
          checked: false,
          expected: field.props.valueToken,
        },
      ],
    });
  const changed = await p.inkViews.event(frame.id, owner, submit);
  assert.equal(changed.event.status, 'accepted');
  assert.deepEqual(changed.computed, ['rows']);
  assert.ok(
    changed.patch.operations.some(
      (operation) =>
        operation.op === 'mount' && operation.node.props.text === 'Hello',
    ),
  );
  assert.ok(
    !changed.patch.operations.some((operation) => operation.id === field.id),
  );
  const latest = await p.inkViews.refresh(frame.id, owner, { revision: 0 });
  assert.ok(latest.tree.nodes.some((node) => node.props.text === 'Hello'));
  const retry = await p.inkViews.event(frame.id, owner, submit);
  assert.equal(retry.event.status, 'accepted');
  assert.equal(
    (
      await p.inkViews.refresh(frame.id, owner, { revision: 0 })
    ).tree.nodes.filter((node) => node.kind === 'Item').length,
    1,
  );
  await assert.rejects(
    p.inkViews.event(frame.id, owner, {
      ...submit,
      input: {
        ...submit.input,
        fields: [{ ...submit.input.fields[0], text: 'Different' }],
      },
    }),
    { status: 409 },
  );
  const nav = latest.tree.nodes.find(
      (node) => node.kind === 'NavItem' && node.props.text === 'Second',
    ),
    navigation = await p.inkViews.event(frame.id, owner, {
      ...event(latest, nav, 'Activate'),
      sequence: 2,
    });
  assert.equal(navigation.event.status, 'accepted');
  assert.deepEqual(navigation.computed, ['root']);
});

test('wide event actions survive without JavaScript number coercion and undeclared bindings fail before writes', async (t) => {
  const { p, app } = await uiFixture(t);
  await runInstalledInk(p, app.id, { entry: 'seed', input: '[]' }, owner);
  const frame = await p.inkViews.openApp(app.id, owner),
    button = frame.tree.nodes.find(
      (node) => node.kind === 'Button' && node.props.text === 'Delete',
    );
  assert.ok(button.id.endsWith('18446744073709551615'));
  const input = event(frame, button, 'Activate');
  await assert.rejects(
    p.inkViews.event(frame.id, owner, { ...input, token: '0'.repeat(32) }),
    { status: 409 },
  );
  const done = await p.inkViews.event(frame.id, owner, input);
  assert.equal(done.event.status, 'accepted');
  assert.equal(
    (
      await p.inkViews.refresh(frame.id, owner, { revision: 0 })
    ).tree.nodes.filter((node) => node.kind === 'Item').length,
    0,
  );
});

test('UI release contracts reject mismatched handler types before installation', async () => {
  const data = uiFiles();
  data.manifest.ui.components[0].event = 'remove';
  await assert.rejects(
    buildInkApp(data.manifest, data.files),
    /action\/input type/,
  );
});

test('committed Ink-only example switches list/table components without remounting the form', async (t) => {
  const { readFile } = await import('node:fs/promises'),
    { file } = await import('./ink-ui-fixture.mjs'),
    { p } = await uiFixture(t),
    root = new URL('../examples/typed-ui/', import.meta.url),
    manifest = JSON.parse(
      await readFile(new URL('ink-app.json', root), 'utf8'),
    ),
    files = await Promise.all(
      ['main.ink', 'ui.ink'].map(async (path) =>
        file(path, await readFile(new URL(path, root), 'utf8')),
      ),
    ),
    bundle = await buildInkApp(manifest, files),
    app = await p.createApp({
      slug: 'example-ui',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  const mounted = await p.inkViews.openApp(app.id, owner),
    form = mounted.tree.nodes.find((node) => node.kind === 'Form'),
    field = mounted.tree.nodes.find((node) => node.kind === 'Field');
  const added = await p.inkViews.event(
    mounted.id,
    owner,
    event(mounted, form, 'Submit', {
      text: '',
      checked: false,
      expected: '',
      fields: [
        {
          id: field.id,
          text: 'Example',
          checked: false,
          expected: field.props.valueToken,
        },
      ],
    }),
  );
  assert.equal(added.event.status, 'accepted');
  const latest = await p.inkViews.refresh(mounted.id, owner, { revision: 0 }),
    tab = latest.tree.nodes.find(
      (node) => node.kind === 'NavItem' && node.props.text === 'Table',
    ),
    switched = await p.inkViews.event(mounted.id, owner, {
      ...event(latest, tab, 'Activate'),
      sequence: 2,
    });
  assert.deepEqual(switched.computed, ['root', 'grid']);
  assert.ok(
    !switched.patch.operations.some(
      (op) => op.id === form.id || op.id === field.id,
    ),
  );
  const grid = await p.inkViews.refresh(mounted.id, owner, { revision: 0 });
  assert.ok(
    grid.tree.nodes.some(
      (node) => node.kind === 'Cell' && node.props.text === 'Example',
    ),
  );
  const row = grid.tree.nodes.find(
      (node) => node.kind === 'TableRow' && node.events.length,
    ),
    removed = await p.inkViews.event(mounted.id, owner, {
      ...event(grid, row, 'Activate'),
      sequence: 3,
    });
  assert.equal(removed.event.status, 'accepted');
  assert.deepEqual(removed.computed, ['grid']);
});

test('canonical form changes reject an older draft before dispatch even at the current view revision', async (t) => {
  const { source } = await import('./ink-ui-fixture.mjs'),
    { p } = await uiFixture(t),
    data = uiFiles(
      source
        .replace(
          'fn editor()->UiView<Unit>',
          'query editor()->UiView<Unit> reads(Next)',
        )
        .replace(
          'ui_field<Unit>("title","Title","")',
          'ui_field<Unit>("title","Title",ui_key(Next))',
        ),
    ),
    bundle = await buildInkApp(data.manifest, data.files),
    app = await p.createApp({
      slug: 'draft-ui',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  const frame = await p.inkViews.openApp(app.id, owner),
    form = node(frame, 'Form'),
    field = node(frame, 'Field'),
    input = {
      text: '',
      checked: false,
      expected: '',
      fields: [
        {
          id: field.id,
          text: 'Initial',
          checked: false,
          expected: field.props.valueToken,
        },
      ],
    };
  assert.equal(
    (
      await p.inkViews.event(
        frame.id,
        owner,
        event(frame, form, 'Submit', input),
      )
    ).event.status,
    'accepted',
  );
  const latest = await p.inkViews.refresh(frame.id, owner, { revision: 0 });
  assert.notEqual(
    node(latest, 'Field').props.valueToken,
    field.props.valueToken,
  );
  await assert.rejects(
    p.inkViews.event(frame.id, owner, {
      ...event(latest, node(latest, 'Form'), 'Submit', input),
      sequence: 2,
    }),
    { status: 409, current: { notApplied: true } },
  );
  assert.equal(
    (
      await p.inkViews.refresh(frame.id, owner, { revision: 0 })
    ).tree.nodes.filter((node) => node.kind === 'Item').length,
    1,
  );
  const updated = await buildInkApp(
    data.manifest,
    data.files.map((item) =>
      item.path === 'main.ink'
        ? {
            ...item,
            base64: Buffer.from(
              Buffer.from(item.base64, 'base64').toString() +
                '\n// Next release\n',
            ).toString('base64'),
          }
        : item,
    ),
  );
  const second = await p.createRelease(app.id, updated);
  assert.notEqual(second.id, release.id);
  await p.publish(app.id, second.id);
  await assert.rejects(p.inkViews.refresh(frame.id, owner, { revision: 0 }), {
    status: 409,
  });
});
