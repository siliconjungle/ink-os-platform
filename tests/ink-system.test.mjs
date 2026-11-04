import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  systemFixture,
  logicalHistory,
  owner,
  example,
} from './ink-system-fixture.mjs';
import { buildInkSystem, verifyInkSystem } from '../server/ink-system.mjs';
import { loadInkSystem } from '../cli/bin/ink-system.mjs';
import { validateInkBundle } from '../server/ink-apps.mjs';
import { moduleSummaries } from '../server/ink-module-summaries.mjs';
import { compileInkProgram, compilerRequest } from '../server/ink-compiler.mjs';
test('checked system deploys selected maintained aggregate and shares typed query snapshots across both incremental apps', async (t) => {
  const f = await systemFixture(t),
    { p, deployed } = f,
    table = await p.inkViews.openApp(deployed.apps.tables.appId, owner),
    dashboard = await p.inkViews.openApp(deployed.apps.dashboard.appId, owner);
  assert.equal(
    f.packet.graph.units.find((u) => u.name === 'tables').implementation.steps,
    1,
  );
  assert.equal(p.inkViews.reads.reads, 1);
  await f.call('put', [0, { id: 1, title: 'First', amount: 7, open: true }], {
    requestId: 'first',
  });
  const a = await p.inkViews.refresh(table.id, owner, {
      revision: table.revision,
    }),
    b = await p.inkViews.refresh(dashboard.id, owner, {
      revision: dashboard.revision,
    });
  assert.deepEqual(a.computed, ['results']);
  assert.deepEqual(b.computed, ['results']);
  assert.equal(p.inkViews.reads.reads, 2);
  for (const frame of [a, b])
    assert.ok(
      frame.patch.operations.some(
        (op) =>
          op.props?.text === 'Open total: 7' ||
          op.node?.props.text === 'Open total: 7',
      ),
    );
  const before = p.world.version;
  await f.call('abort_edit', [
    { id: 2, title: 'Abort', amount: 100, open: true },
  ]);
  assert.equal(p.world.version, before);
  assert.deepEqual(
    (await p.inkViews.refresh(dashboard.id, owner, { revision: b.revision }))
      .computed,
    [],
  );
  await assert.rejects(
    validateInkBundle(f.packet.apps.find((a) => a.name === 'dashboard').bundle),
    /Bind every/,
  );
});
test('complete histories preserve conflicts, aborted changes, duplicate/lost replies and concurrent version guards', async (t) => {
  const f = await systemFixture(t),
    history = await logicalHistory(f);
  assert.equal(history[8].valueWire, history[9].valueWire);
  assert.equal(history[10].valueWire, '{"Err":"conflict"}');
  assert.equal(history[11].committed, false);
  const result = JSON.parse(history.at(-1).valueWire);
  assert.equal(result.version, 11);
  assert.equal(result.total.Some, 6);
  assert.equal(result.rows[0].aggregate, 32);
  assert.equal(
    history
      .slice(15, 19)
      .filter((r) => JSON.parse(r.valueWire).Ok !== undefined).length,
    1,
  );
});
test('system graph and summary forgery reject, and unchanged units reuse bounded replayed caches', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-system-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = await loadInkSystem(example),
    first = await buildInkSystem(input, { cacheDirectory: directory }),
    second = await buildInkSystem(input, { cacheDirectory: directory });
  assert.deepEqual(second.stats.reused, ['tables', 'dashboard']);
  assert.equal(first.graph.identity, second.graph.identity);
  const forged = structuredClone(second);
  forged.graph.units[0].storage = [];
  await assert.rejects(verifyInkSystem(forged), /graph or summary/);
  const renamed = structuredClone(second);
  renamed.apps[0].manifest.slug = 'different-registration';
  await assert.rejects(verifyInkSystem(renamed), /graph or summary/);
  const bad = structuredClone(input);
  bad.links[0].entry = 'put';
  await assert.rejects(buildInkSystem(bad), /readonly/);
  const changed = structuredClone(input);
  changed.apps[1].files.find((f) => f.path === 'main.ink').base64 = Buffer.from(
    Buffer.from(
      changed.apps[1].files.find((f) => f.path === 'main.ink').base64,
      'base64',
    ).toString() + '\n// independent UI edit\n',
  ).toString('base64');
  const next = await buildInkSystem(changed, { cacheDirectory: directory });
  assert.deepEqual(next.stats.reused, ['tables']);
  assert.deepEqual(next.stats.built, ['dashboard']);
  for (const name of await readdir(directory))
    if (name.endsWith('.json')) await writeFile(join(directory, name), '{}');
  const recovered = await buildInkSystem(input, { cacheDirectory: directory });
  assert.equal(recovered.stats.reused.length, 0);
});
test('parser-derived module summaries reuse unrelated closures and reject forged ownership', async () => {
  const graph = {
      version: 1,
      root: 'main.ink',
      modules: [
        {
          path: 'main.ink',
          name: 'app',
          dependencies: ['a.ink', 'b.ink'],
          exports: ['run'],
          source: 'module app;fn run(n:u32)->u32{return first(n)+second(n);}',
        },
        {
          path: 'a.ink',
          name: 'a',
          dependencies: [],
          exports: ['first'],
          source: 'module a;fn first(n:u32)->u32{return n+1;}',
        },
        {
          path: 'b.ink',
          name: 'b',
          dependencies: [],
          exports: ['second'],
          source:
            'module b;/* fn first is only a comment */fn second(n:u32)->u32{return n+2;}',
        },
      ],
    },
    a = await moduleSummaries(graph, await compileInkProgram(graph)),
    changed = structuredClone(graph);
  changed.modules[1].source += '\n// changed implementation source\n';
  const b = await moduleSummaries(changed, await compileInkProgram(changed));
  assert.equal(
    a.modules.find((m) => m.name === 'b').identity,
    b.modules.find((m) => m.name === 'b').identity,
  );
  assert.notEqual(
    a.modules.find((m) => m.name === 'a').identity,
    b.modules.find((m) => m.name === 'a').identity,
  );
  assert.notEqual(
    a.modules.find((m) => m.name === 'app').identity,
    b.modules.find((m) => m.name === 'app').identity,
  );
  const describe = await compilerRequest({ op: 'describeModules', graph });
  assert.deepEqual(
    describe.modules.find((m) => m.path === 'b.ink').declarations,
    ['second'],
  );
  assert.ok(Object.isFrozen(await compileInkProgram(graph)));
});

test('admitted requests retain immutable source and avoid reloading proof packets while release fences remain live', async (t) => {
  const f = await systemFixture(t),
    { p, deployed } = f,
    a = await p.inkViews.openApp(deployed.apps.tables.appId, owner),
    b = await p.inkViews.openApp(deployed.apps.dashboard.appId, owner),
    original = p.bundle.bind(p);
  let loads = 0;
  p.bundle = async (...args) => {
    loads++;
    return original(...args);
  };
  await f.call('put', [0, { id: 1, title: 'Hot', amount: 1, open: true }]);
  await p.inkViews.refresh(a.id, owner, { revision: a.revision });
  await p.inkViews.refresh(b.id, owner, { revision: b.revision });
  assert.equal(loads, 0);
  p.bundle = original;
  const { installedInk } = await import('../server/ink-apps.mjs'),
    admitted = await installedInk(p, deployed.apps.tables.appId);
  assert.ok(Object.isFrozen(admitted.source));
  assert.throws(() => {
    admitted.source.plan = 'unchecked';
  }, TypeError);
  const app = p.app(deployed.apps.tables.appId),
    meta = JSON.parse(app.body);
  await p.world.update(app.id, {
    body: JSON.stringify({ ...meta, releaseId: 'f'.repeat(32) }),
  });
  await assert.rejects(f.call('dashboard', [0, 20]), /release|not found/i);
  await assert.rejects(
    p.inkViews.refresh(b.id, owner, { revision: 0 }),
    /release changed/i,
  );
});

test('recorded system deployments resume interrupted publication and retries keep the same application identities', async (t) => {
  const { fixture } = await import('./ink-effects-fixture.mjs'),
    { installInkSystem } = await import('../server/ink-system.mjs'),
    f = await fixture(t),
    input = await loadInkSystem(example),
    packet = await buildInkSystem(input),
    p = f.platform,
    publish = p.publish.bind(p);
  let failed = false;
  p.publish = async (appId, releaseId) => {
    if (!failed && JSON.parse(p.app(appId).body).slug === 'system-dashboard') {
      failed = true;
      throw Error('Interrupted publication');
    }
    return publish(appId, releaseId);
  };
  await assert.rejects(installInkSystem(p, packet, owner), /Interrupted/);
  assert.equal(p.apps().length, 2);
  p.publish = publish;
  const resumed = await installInkSystem(p, packet, owner),
    again = await installInkSystem(p, packet, owner);
  assert.deepEqual(again, resumed);
  assert.equal(p.apps().length, 2);
  assert.equal(resumed.status, 'deployed');
});

test('cached frontend files never become execution authority for a checked system unit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-system-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = await loadInkSystem(example),
    first = await buildInkSystem(input, { cacheDirectory: directory });
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name),
      bundle = JSON.parse(await readFile(path, 'utf8'));
    bundle.files.find((file) => file.path === 'app.mjs').base64 = Buffer.from(
      'throw Error("substituted frontend")',
    ).toString('base64');
    await writeFile(path, JSON.stringify(bundle));
  }
  const next = await buildInkSystem(input, { cacheDirectory: directory });
  assert.equal(next.graph.identity, first.graph.identity);
  for (const app of next.apps)
    assert.ok(
      !Buffer.from(
        app.bundle.files.find((file) => file.path === 'app.mjs').base64,
        'base64',
      )
        .toString()
        .includes('substituted frontend'),
    );
});

test('durable collaboration commits refresh typed consumers before asynchronous World projection', async (t) => {
  const f = await systemFixture(t, { collaborative: true }),
    { p, deployed } = f,
    project = p.collaboration.project.bind(p.collaboration);
  p.collaboration.project = () => {};
  const a = await p.inkViews.openApp(deployed.apps.tables.appId, owner),
    b = await p.inkViews.openApp(deployed.apps.dashboard.appId, owner);
  await f.call('put', [
    0,
    { id: 1, title: 'Immediate', amount: 7, open: true },
  ]);
  const { stateObjectId } = await import('../server/app-data.mjs');
  assert.equal(
    p.world.get(stateObjectId(deployed.apps.tables.appId, 'ink-app:state')),
    null,
  );
  assert.deepEqual(
    (await p.inkViews.refresh(a.id, owner, { revision: a.revision })).computed,
    ['results'],
  );
  assert.deepEqual(
    (await p.inkViews.refresh(b.id, owner, { revision: b.revision })).computed,
    ['results'],
  );
  p.collaboration.project = project;
});
