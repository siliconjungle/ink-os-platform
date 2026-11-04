import test from 'node:test';
import assert from 'node:assert/strict';
import { systemFixture, logicalHistory, owner } from './ink-system-fixture.mjs';
import { InkViews } from '../server/ink-ui.mjs';
import { runInstalledInk } from '../server/ink-apps.mjs';
test(
  'independently compiled system units preserve exact histories through actual native execution and journal recovery',
  { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 },
  async (t) => {
    const js = await systemFixture(t),
      rust = await systemFixture(t, { native: true, collaborative: true }),
      a = await logicalHistory(js),
      b = await logicalHistory(rust);
    assert.deepEqual(b, a);
    const before = (await rust.call('dashboard', [0, 20])).valueWire;
    await rust.p.inkViews.close();
    await rust.p.code.close();
    const old = rust.p.collaboration;
    old.fixtureRetired = true;
    for (const task of old.documents.values()) {
      const doc = await task;
      clearTimeout(doc.projectTimer);
      await doc.tail;
      await doc.journal.sync();
      await doc.journal.close();
    }
    await old.textWorkers.close();
    const restarted = await rust.open();
    const { Collaboration } = await import('../server/collaboration.mjs');
    restarted.collaboration = new Collaboration({
      directory: rust.directory,
      world: restarted.world,
    });
    await restarted.collaboration.index();
    restarted.code.nativeJobs = rust.p.code.nativeJobs;
    restarted.inkViews = await new InkViews({ platform: restarted }).open();
    t.after(() => restarted.inkViews.close());
    const after = await runInstalledInk(
      restarted,
      rust.deployed.apps.tables.appId,
      { entry: 'dashboard', input: '[0,20]', backend: 'native' },
      owner,
    );
    assert.equal(after.valueWire, before);
    assert.equal(after.backend, 'native');
    const retry = await runInstalledInk(
      restarted,
      rust.deployed.apps.tables.appId,
      {
        entry: 'put',
        input: '[8,{"id":9,"title":"Item 9","amount":9,"open":true}]',
        requestId: 'lost-reply',
        backend: 'native',
      },
      owner,
    );
    assert.equal(retry.valueWire, b[8].valueWire);
    const view = await restarted.inkViews.openApp(
      rust.deployed.apps.dashboard.appId,
      owner,
    );
    assert.ok(
      view.tree.nodes.some((node) => node.props.text === 'Open total: 32'),
    );
  },
);
