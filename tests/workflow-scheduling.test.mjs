import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, file, until } from './ink-effects-fixture.mjs';
import { Workflows } from '../server/workflows.mjs';
import { buildInkApp, runInstalledInk } from '../server/ink-apps.mjs';
import { runCommand } from '../server/app-commands.mjs';
import {
  checkedWorkflowPlan,
  captureWorkflowSnapshot,
  executeWorkflowGraph,
} from '../server/workflow-scheduling.mjs';
import { workflowDefinition } from '../shared/workflows.mjs';
const defer = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const scheduling = { version: 1, mode: 'parallel', maxConcurrent: 4 };
const literal = (value) => ({ source: 'literal', value });
async function setup(t) {
  const f = await fixture(t),
    p = f.platform,
    source =
      'module app;state Count:u64=0;fn twice(n:u64)->u64{return n*2;}fn reject(n:u64)->u64{return n;}change add(n:u64)->u64 reads(Count) writes(Count){Count=Count+n;return Count;}query total()->u64 reads(Count){return Count;}',
    bundle = await buildInkApp({ slug: 'scheduled', language: 'ink' }, [
      file('main.ink', source),
    ]),
    app = await p.createApp({
      slug: 'scheduled',
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  p.workflows = await new Workflows({
    directory: f.directory,
    platform: p,
  }).open();
  t.after(async () => {
    p.workflows.close();
    await until(() => p.workflows.active.size === 0 && !p.workflows.pumping);
  });
  return { ...f, p, app, release, bundle, w: p.workflows };
}
const step = (
  id,
  app,
  commandId = 'ink.twice',
  bindings = { arg0: literal('7') },
  extra = {},
) => ({ id, appId: app.id, commandId, bindings, ...extra });
async function start(w, definition) {
  const saved = await w.save(owner, { definition }),
    preview = w.preview(owner, { id: saved.id });
  const run = await w.run(owner, {
    id: saved.id,
    fingerprint: preview.fingerprint,
    approved: true,
    requestId: crypto.randomUUID(),
  });
  await until(
    () =>
      !w.active.has(run.id) && w.runs.find((r) => r.id === run.id)?.finishedAt,
  );
  return w.runs.find((r) => r.id === run.id);
}

test('workflow schema retains explicit ordering and bounded opt-in concurrency while legacy definitions stay sequential', () => {
  const app = { id: 'a'.repeat(32) },
    steps = [
      step('one', app),
      step('two', app, undefined, undefined, { dependsOn: ['one'] }),
    ],
    value = workflowDefinition({ title: 'DAG', scheduling, steps });
  assert.deepEqual(value.scheduling, scheduling);
  assert.deepEqual(value.steps[1].dependsOn, ['one']);
  assert.equal(
    workflowDefinition({ title: 'old', steps }).scheduling,
    undefined,
  );
  assert.throws(() =>
    workflowDefinition({
      title: 'bad',
      steps: [step('one', app, undefined, undefined, { dependsOn: ['one'] })],
    }),
  );
  assert.throws(() =>
    workflowDefinition({
      title: 'bad',
      steps,
      scheduling: { ...scheduling, maxConcurrent: 5 },
    }),
  );
});

test('checked source-derived purity permits real concurrent workers while changes, queries and unknown backends remain barriers', async (t) => {
  const f = await setup(t),
    { w, p, app } = f,
    gate = defer(),
    started = [];
  let inFlight = 0,
    max = 0;
  const invoke = w.invoke;
  w.invoke = async (...args) => {
    const name = args[2].id;
    if (name === 'ink.twice') {
      started.push(args[2].input.arg0);
      inFlight++;
      max = Math.max(max, inFlight);
      await gate.promise;
      try {
        return await invoke(...args);
      } finally {
        inFlight--;
      }
    }
    return invoke(...args);
  };
  const definition = {
      title: 'Concurrent',
      scheduling,
      steps: [
        step('a', app),
        step('b', app, 'ink.twice', { arg0: literal('8') }),
        step('write', app, 'ink.add', { arg0: literal('1') }),
        step('read', app, 'ink.total', {}),
      ],
    },
    task = start(w, definition);
  await until(() => started.length === 2);
  assert.equal(max, 2);
  assert.equal(
    (await runInstalledInk(p, app.id, { entry: 'total', input: '[]' }, owner))
      .valueWire,
    '0',
  );
  gate.resolve();
  const run = await task;
  assert.equal(run.status, 'succeeded', run.error);
  assert.deepEqual(
    run.steps.map((s) => s.output?.valueWire || s.output?.data?.valueWire),
    ['14', '16', '1', '1'],
  );
  assert.deepEqual(
    run.schedulerPlan.nodes.map((n) => n.contract.kind),
    ['ink-pure', 'ink-pure', 'ordered', 'ordered'],
  );
  assert.deepEqual(run.schedulerPlan.nodes[2].dependencies, ['a', 'b']);
  assert.equal(p.code.residents.starts >= 2, true);
});

test('result and explicit dependencies constrain a DAG even between pure functions', async (t) => {
  const { w, app } = await setup(t),
    order = [],
    invoke = w.invoke;
  w.invoke = async (...args) => {
    order.push(args[2].input.arg0);
    return invoke(...args);
  };
  const run = await start(w, {
    title: 'Chain',
    scheduling,
    steps: [
      step('a', app),
      step('b', app, 'ink.twice', {
        arg0: { source: 'step', stepId: 'a', path: 'valueWire' },
      }),
      step('c', app, 'ink.twice', { arg0: literal('2') }, { dependsOn: ['b'] }),
    ],
  });
  assert.equal(run.status, 'succeeded', run.error);
  assert.deepEqual(order, ['7', '14', '2']);
  assert.deepEqual(run.schedulerPlan.nodes[1].dependencies, ['a']);
  assert.deepEqual(run.schedulerPlan.nodes[2].dependencies, ['b']);
});

test('concurrent failures drain siblings, retain their results and choose the earliest source error before any write', async (t) => {
  const { w, p, app } = await setup(t),
    gate = defer(),
    invoke = w.invoke;
  let slow = false;
  w.invoke = async (...args) => {
    if (args[2].id === 'ink.twice') {
      slow = true;
      await gate.promise;
    }
    return invoke(...args);
  };
  const task = start(w, {
    title: 'Failure',
    scheduling,
    steps: [
      step('bad', app, 'ink.reject', { arg0: literal('"bad"') }),
      step('sibling', app),
      step('write', app, 'ink.add', { arg0: literal('1') }),
    ],
  });
  await until(() => slow && w.runs.some((r) => r.steps[0].status === 'failed'));
  const current = w.runs.at(-1);
  assert.equal(current.finishedAt, null);
  gate.resolve();
  const run = await task;
  assert.equal(run.status, 'failed');
  assert.equal(run.steps[1].status, 'succeeded');
  assert.equal(run.steps[2].status, 'pending');
  assert.equal(
    (await runInstalledInk(p, app.id, { entry: 'total', input: '[]' }, owner))
      .valueWire,
    '0',
  );
});

test('captured World query batches reuse equivalent work, preserve versions and hide private source rows', async (t) => {
  const f = await fixture(t),
    p = f.platform,
    command = {
      id: 'notes',
      title: 'Notes',
      handler: { type: 'query', query: { scope: 'self', kind: 'note' } },
    },
    app = await p.createApp({ slug: 'snapshot-reader', commands: [command] }),
    bundle = {
      entry: 'index.html',
      files: [file('index.html', '<p>read</p>')],
      commands: [command],
    },
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  await p.world.create({ namespace: app.id, kind: 'note', body: 'before' });
  p.workflows = await new Workflows({
    directory: f.directory,
    platform: p,
  }).open();
  t.after(() => p.workflows.close());
  let injected = false;
  const invoke = p.workflows.invoke;
  p.workflows.invoke = async (...args) => {
    if (!injected) {
      injected = true;
      await p.world.create({ namespace: app.id, kind: 'note', body: 'after' });
    }
    return invoke(...args);
  };
  const run = await start(p.workflows, {
    title: 'Snapshot',
    scheduling,
    steps: [step('a', app, 'notes', {}), step('b', app, 'notes', {})],
  });
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(run.steps[0].output.total, 1);
  assert.deepEqual(run.steps[0].output, run.steps[1].output);
  const receipt = run.schedulerPlan.snapshots[0];
  assert.equal(receipt.logicalQueries, 2);
  assert.equal(receipt.physicalQueries, 1);
  assert.equal(receipt.version, run.steps[0].output.version);
  const source = await p.world.create({
      namespace: app.id,
      kind: 'note',
      tags: ['app-source'],
      body: 'private',
    }),
    snapshot = captureWorkflowSnapshot(p.world);
  assert.ok(
    !snapshot
      .query({ namespace: app.id })
      .objects.some((row) => row.id === source.id),
  );
});

test('cancellation stops queued steps, keeps the run active until admitted siblings settle, and never dispatches a write suffix', async (t) => {
  const { w, app } = await setup(t),
    gate = defer(),
    started = [],
    invoke = w.invoke;
  w.invoke = async (...args) => {
    started.push(args[2].id);
    if (args[2].id === 'ink.twice') await gate.promise;
    return invoke(...args);
  };
  const definition = await w.save(owner, {
      definition: {
        title: 'Cancel',
        scheduling: { ...scheduling, maxConcurrent: 2 },
        steps: [
          step('a', app),
          step('b', app),
          step('write', app, 'ink.add', { arg0: literal('1') }),
        ],
      },
    }),
    preview = w.preview(owner, { id: definition.id }),
    run = await w.run(owner, {
      id: definition.id,
      fingerprint: preview.fingerprint,
      approved: true,
      requestId: crypto.randomUUID(),
    });
  await until(() => started.length === 2);
  await w.cancel(owner, { runId: run.id });
  assert.equal(w.runs.find((r) => r.id === run.id).status, 'cancelling');
  gate.resolve();
  await until(() => !w.active.has(run.id));
  assert.equal(w.runs.find((r) => r.id === run.id).status, 'cancelled');
  assert.equal(started.includes('ink.add'), false);
});

test('the DAG dispatcher does not publish completion before a failed branch and every admitted sibling settle', async () => {
  const gate = defer(),
    nodes = [
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'write', dependencies: ['a', 'b'] },
    ],
    started = [];
  const task = executeWorkflowGraph(nodes, {
    execute: async (node) => {
      started.push(node.id);
      if (node.id === 'a') throw Error('first');
      await gate.promise;
    },
  });
  await until(() => started.length === 2);
  gate.resolve();
  const result = await task;
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(result.errors[0].id, 'a');
  assert.deepEqual(result.pending, ['write']);
});

test('actual compiler-checked pure calls occupy separate resident workers and cannot bypass serialization for changes', async (t) => {
  const { p, app } = await setup(t),
    gate = defer(),
    acquire = p.code.residents.acquire.bind(p.code.residents);
  let calls = 0,
    peak = 0,
    live = 0;
  p.code.residents.acquire = async (...args) => {
    const session = await acquire(...args);
    if (!session.testWrapped) {
      session.testWrapped = true;
      const request = session.endpoint.request.bind(session.endpoint);
      session.endpoint.request = async (message) => {
        if (message.op !== 'call') return request(message);
        live++;
        peak = Math.max(peak, live);
        if (++calls === 2) gate.resolve();
        await gate.promise;
        try {
          return await request(message);
        } finally {
          live--;
        }
      };
    }
    return session;
  };
  t.after(() => gate.resolve());
  const tasks = [7, 8].map((n) =>
    runInstalledInk(
      p,
      app.id,
      { entry: 'twice', input: JSON.stringify([n]) },
      owner,
      undefined,
      { parallelPure: true },
    ),
  );
  const results = await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.deepEqual(
    results.map((r) => r.valueWire),
    ['14', '16'],
  );
  await assert.rejects(
    runInstalledInk(
      p,
      app.id,
      { entry: 'add', input: '[9]' },
      owner,
      undefined,
      { parallelPure: true },
    ),
    { status: 403 },
  );
});

test('author-declared read flags and key hints never authorize parallel backend calls or changes', async (t) => {
  const { w, p, app } = await setup(t),
    backend = await p.createApp({
      slug: 'opaque',
      commands: [
        {
          id: 'read',
          title: 'Read',
          handler: { type: 'backend', path: '/read', method: 'GET' },
          effect: 'read',
          idempotent: true,
        },
      ],
    }),
    release = await p.createRelease(backend.id, {
      files: [
        file('index.html', 'read'),
        file('server.mjs', 'export default {};'),
      ],
      backend: { entry: 'server.mjs' },
      commands: [
        {
          id: 'read',
          title: 'Read',
          handler: { type: 'backend', path: '/read', method: 'GET' },
          effect: 'read',
          idempotent: true,
        },
      ],
    });
  await p.publish(backend.id, release.id);
  const definition = workflowDefinition({
      title: 'Conservative',
      scheduling,
      steps: [
        step('a', backend, 'read', {}),
        step('b', app, 'ink.add', { arg0: literal('1') }),
        step('c', app),
      ],
    }),
    prepared = w.prepare(definition, {}),
    plan = await checkedWorkflowPlan(p, { definition, steps: prepared.steps });
  assert.deepEqual(
    plan.nodes.map((n) => n.contract.kind),
    ['ordered', 'ordered', 'ink-pure'],
  );
  assert.deepEqual(plan.nodes[1].dependencies, ['a']);
  assert.deepEqual(plan.nodes[2].dependencies, ['a', 'b']);
});

test('a restarted parallel run keeps completed siblings and marks every unfinished dispatched step interrupted', async (t) => {
  const { w, p, directory, app } = await setup(t);
  w.pumping = true;
  const definition = await w.save(owner, {
      definition: {
        title: 'Recover',
        scheduling,
        steps: [step('a', app), step('b', app), step('c', app)],
      },
    }),
    preview = w.preview(owner, { id: definition.id }),
    run = await w.run(owner, {
      id: definition.id,
      fingerprint: preview.fingerprint,
      requestId: crypto.randomUUID(),
    });
  await w.patch(run.id, (r) => {
    r.status = 'running';
    r.steps[0].status = 'succeeded';
    r.steps[0].output = { valueWire: '14' };
    r.steps[1].status = 'running';
    r.steps[2].status = 'running';
  });
  const recovered = await new Workflows({ directory, platform: p }).open();
  t.after(() => {
    recovered.close();
    w.pumping = false;
  });
  w.pumping = false;
  const saved = recovered.runs.find((r) => r.id === run.id);
  assert.equal(saved.status, 'interrupted');
  assert.deepEqual(
    saved.steps.map((s) => s.status),
    ['succeeded', 'interrupted', 'interrupted'],
  );
});

test('nested Ink parallel_map runs inside its admitted host lane with exact ordered values', async (t) => {
  const { p, app } = await setup(t),
    source =
      'module lanes;fn mapped(xs:List<u32>)->List<u32>{return parallel_map(xs,1,fn(i)=>fn(x)=>x+i);}',
    input = Array.from({ length: 64 }, (_, i) => i);
  const compiled = await p.code.compile(source);
  assert.equal(
    compiled.entries.find((entry) => entry.name === 'mapped').parallel,
    true,
  );
  const result = await p.code.run({
    source,
    entry: 'mapped',
    args: [input],
    namespace: app.id,
    parallelPure: true,
  });
  assert.deepEqual(
    result.output,
    input.map((x) => x * 2),
  );
});

test('the shipped Ink-only workflow computes concurrently and publishes its joined result in order', async (t) => {
  const { readFile } = await import('node:fs/promises'),
    f = await fixture(t),
    p = f.platform,
    root = new URL('../examples/parallel-workflow/', import.meta.url),
    manifest = JSON.parse(await readFile(new URL('ink-app.json', root))),
    source = await readFile(new URL('main.ink', root), 'utf8'),
    bundle = await buildInkApp(manifest, [file('main.ink', source)]),
    app = await p.createApp({
      slug: manifest.slug,
      capabilities: bundle.capabilities,
    }),
    release = await p.createRelease(app.id, bundle);
  await p.publish(app.id, release.id);
  p.workflows = await new Workflows({
    directory: f.directory,
    platform: p,
  }).open();
  t.after(() => p.workflows.close());
  const definition = JSON.parse(await readFile(new URL('workflow.json', root)));
  for (const step of definition.steps) step.appId = app.id;
  const done = await start(p.workflows, definition);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.steps.at(-1).output.valueWire, '36');
  assert.deepEqual(done.schedulerPlan.nodes[2].dependencies, ['left', 'right']);
});

test('aggregate host resource inspection is administrator-only and exposes no owner identities', async (t) => {
  const { platform: p } = await fixture(t),
    { platformRouter } = await import('../server/platform-router.mjs');
  let result;
  const route = platformRouter(p, {
      send: (_res, status, value) => (result = { status, value }),
      body: async () => ({}),
    }),
    req = { method: 'GET', headers: {} },
    url = new URL('http://local.invalid/api/v1/execution');
  await route(req, {}, url, owner);
  assert.equal(result.status, 200);
  assert.equal(result.value.format, 'ink-os-execution-budget-v1');
  assert.ok(result.value.limits.cpu > 0);
  assert.equal(result.value.owners, undefined);
  await assert.rejects(
    route(req, {}, url, { owner: true, accountId: 'member' }),
    { status: 403 },
  );
});
