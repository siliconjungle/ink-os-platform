import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NativeInk } from '../server/native-ink.mjs';
import { uiFixture, owner, event } from './ink-ui-fixture.mjs';
import { inkExecutionSource, runInstalledInk } from '../server/ink-apps.mjs';
test(
  'actual native UI components and typed wide events share JavaScript state and incremental contracts',
  { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 },
  async (t) => {
    const { p, app, bundle, directory } = await uiFixture(t),
      source = await inkExecutionSource(bundle.ink, bundle.files),
      native = new NativeInk(join(directory, 'native'), {
        offline: process.env.INK_NATIVE_OFFLINE === '1',
      }),
      artifact = await native.build(source, { namespace: app.id });
    await runInstalledInk(
      p,
      app.id,
      { entry: 'seed', backend: 'javascript' },
      owner,
    );
    const js = await p.inkViews.openApp(app.id, owner);
    p.code.nativeJobs = { native, readyFor: async () => artifact.id };
    const rust = await p.inkViews.openApp(app.id, owner),
      visible = (frame) =>
        frame.tree.nodes.map((node) => ({
          ...node,
          events: node.events.map((event) => event.kind),
          props: { ...node.props, valueToken: '' },
        }));
    assert.deepEqual(visible(rust), visible(js));
    assert.equal(p.code.residents.starts >= 2, true);
    const remove = rust.tree.nodes.find(
      (node) => node.kind === 'Button' && node.props.text === 'Delete',
    );
    assert.ok(remove.id.endsWith('18446744073709551615'));
    const result = await p.inkViews.event(
      rust.id,
      owner,
      event(rust, remove, 'Activate'),
    );
    assert.equal(result.event.status, 'accepted');
    assert.deepEqual(result.computed, ['rows']);
    p.code.nativeJobs = undefined;
    const final = await p.inkViews.openApp(app.id, owner);
    assert.equal(
      final.tree.nodes.filter((node) => node.kind === 'Item').length,
      0,
    );
  },
);
