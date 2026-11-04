import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture, file, library, exports as libraryExports, owner } from './ink-effects-fixture.mjs';
import { buildInkApp, runInstalledInk } from '../server/ink-apps.mjs';
import { InkTasks } from '../server/ink-tasks.mjs';
import { parseExactJSON } from '../shared/exact-json.mjs';

const TASK = `module app;
enum Label { Bug, Billing, Other, }
state Count:u64=0;
effect fetch(request:HttpEffectRequest) -> Result<HttpEffectResponse,EffectError>;
effect classify(text:String) -> Label;
effect summarise(text:String) -> String;
ordered effect notify(message:String) -> Result<u64,String>;
change record(l:Label)->Result<u64,String> reads(Count) writes(Count){Count=Count+1;return Ok(Count);}
query total()->u64 reads(Count){return Count;}
fn rule(t:String)->Label{return Label.Other;}
task triage(path:String) -> Result<Label,EffectError> {
  let page = fetch(HttpEffectRequest{method:"GET",path:path,body:None,bytes:None,expected:None})?;
  let text: String = page.body.unwrap_or("");
  let label = classify(text) ensures label != Label.Other else rule(text);
  let summary = summarise(text) ensures string_byte_len(summary) <= 40 else "";
  let n = record(label);
  let sent = notify(summary);
  return Ok(label);
}
`;
const LOG = `module log;
state N:u64=0; state Last:String="";
change log(message:String)->Result<u64,String> reads(N) writes(N,Last){N=N+1;Last=message;return Ok(N);}
query last()->String reads(Last){return Last;}`;

function taskApp(log, { tasks, source = TASK, capabilities = ['effects.model', 'effects.http', 'apps.invoke'] } = {}) {
  return buildInkApp(
    {
      slug: 'triage-' + crypto.randomUUID().slice(0, 8),
      language: 'ink',
      exports: ['total'],
      capabilities,
      modules: {
        version: 1,
        root: 'main.ink',
        modules: [
          { path: 'main.ink', name: 'app', dependencies: ['effects.ink'], exports: ['total', 'record'] },
          { path: 'effects.ink', name: 'ink_effects', dependencies: [], exports: libraryExports },
        ],
      },
      tasks: tasks || {
        version: 1,
        entries: ['triage'],
        concurrency: 4,
        effects: [
          { name: 'classify', kind: 'model', resource: 'assistant', effect: 'read', deadlineMs: 5000 },
          { name: 'summarise', kind: 'model', resource: 'assistant', effect: 'read', deadlineMs: 5000 },
          { name: 'fetch', kind: 'http', resource: 'tickets', effect: 'read', deadlineMs: 5000 },
          { name: 'notify', kind: 'app', resource: { appId: log.app.id, releaseId: log.release.id, entry: 'log' }, effect: 'write', deadlineMs: 5000 },
        ],
      },
    },
    [file('main.ink', source), file('effects.ink', library)],
  );
}
async function install(platform, bundle) {
  const app = await platform.createApp({ slug: 'task-' + crypto.randomUUID().slice(0, 8), capabilities: bundle.capabilities }),
    release = await platform.createRelease(app.id, bundle);
  await platform.publish(app.id, release.id);
  return { app, release };
}

test('Ink tasks run model, HTTP and app effects through the effect system, overlapping independent requests', async (t) => {
  let inFlight = 0,
    overlap = 0,
    replies = { classify: '"Label.Bug"', summarise: '"crash on start"' };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/tickets/1') return res.end('the app crashes on start');
    if (req.url !== '/v1/messages' || req.method !== 'POST') return res.writeHead(404).end();
    const prompt = JSON.parse(body).messages[0].content;
    inFlight++;
    overlap = Math.max(overlap, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 100));
    inFlight--;
    const text = prompt.includes('classify(') ? replies.classify : replies.summarise;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = 'http://127.0.0.1:' + server.address().port,
    { platform } = await fixture(t, {
      allowHttp: true,
      policy: {
        version: 1,
        resources: {
          assistant: { kind: 'model', namespaces: ['*'], origin, model: 'test-model', maxTokens: 256 },
          tickets: { kind: 'http', namespaces: ['*'], origin, methods: ['GET'], pathPrefix: '/tickets/' },
        },
      },
    });
  platform.inkTasks = new InkTasks({ platform });
  const log = await install(platform, await buildInkApp({ slug: 'log', language: 'ink', exports: ['log', 'last'] }, [file('main.ink', LOG)])),
    triage = await install(platform, await taskApp({ app: log.app, release: log.release }));

  const run = await platform.inkTasks.run(triage.app.id, { task: 'triage', input: '["/tickets/1"]', requestId: 'first' }, owner);
  assert.equal(run.valueWire, '{"Ok":"Label.Bug"}');
  const trace = parseExactJSON(run.trace);
  assert.deepEqual(
    trace.effects.map((e) => [e.effect, e.outcome]),
    [['fetch', 'accepted'], ['classify', 'accepted'], ['summarise', 'accepted'], ['notify', 'accepted']],
  );
  assert.equal(overlap, 2, 'classify and summarise depend only on the page and overlap');
  assert.equal((await runInstalledInk(platform, triage.app.id, { entry: 'total', input: '[]' }, owner)).valueWire, '1');
  assert.equal((await runInstalledInk(platform, log.app.id, { entry: 'last', input: '[]' }, owner)).valueWire, '"crash on start"');
  const stored = platform.world.get(run.traceId);
  assert.equal(stored.kind, 'ink-task-run');
  assert.equal(JSON.parse(stored.body).trace, run.trace);

  // A model reply outside the declared type takes the authored fallback.
  replies = { classify: 'not json', summarise: '"' + 'x'.repeat(60) + '"' };
  const fallback = await platform.inkTasks.run(triage.app.id, { task: 'triage', input: '["/tickets/1"]' }, owner);
  assert.equal(fallback.valueWire, '{"Ok":"Label.Other"}');
  assert.deepEqual(
    parseExactJSON(fallback.trace).effects.map((e) => e.outcome),
    ['accepted', 'fallback', 'fallback', 'accepted'],
  );

  // A path outside the operator resource fails as a typed EffectError, and `?` ends the task.
  const denied = await platform.inkTasks.run(triage.app.id, { task: 'triage', input: '["/secret"]' }, owner);
  assert.equal(JSON.parse(denied.valueWire).Err.code, 'Denied');
  assert.equal(parseExactJSON(denied.trace).effects.length, 1);

  // Only the task's own steps are callable, and only declared tasks run.
  await assert.rejects(platform.inkTasks.run(triage.app.id, { task: 'other', input: '[]' }, owner), { status: 404 });
});

test('task contracts bind every effect, order writes, match driver types and declare capabilities', async (t) => {
  const { platform } = await fixture(t, { policy: { version: 1, resources: {} } }),
    log = { app: { id: 'a'.repeat(32) }, release: { id: 'b'.repeat(32) } };
  const reject = async (options, pattern) => {
    const bundle = await taskApp(log, options),
      app = await platform.createApp({ slug: 'bad-' + crypto.randomUUID().slice(0, 8), capabilities: bundle.capabilities });
    await assert.rejects(platform.createRelease(app.id, bundle), pattern);
  };
  const base = (await taskApp(log)).ink.tasks.effects;
  await reject({ tasks: { version: 1, entries: ['triage'], effects: base.filter((b) => b.name !== 'summarise') } }, /Bind Ink effect summarise/);
  await reject(
    { tasks: { version: 1, entries: ['triage'], effects: base.map((b) => (b.name === 'fetch' ? { ...b, effect: 'write' } : b)) } },
    /declare it as an ordered effect/,
  );
  await reject({ source: TASK.replace('effect fetch(request:HttpEffectRequest)', 'effect fetch(request:ClockEffectRequest)').replace('fetch(HttpEffectRequest{method:"GET",path:path,body:None,bytes:None,expected:None})', 'fetch(ClockEffectRequest{delayMs:0})') }, /http effect request/);
  await reject({ capabilities: ['effects.http', 'apps.invoke'] }, /effects.model/);
});

test('an interrupted task run resumes from its journal without repeating effects, and replays on scratch state', async (t) => {
  let hang = true;
  const hits = { tickets: 0, classify: 0, summarise: 0 },
    hung = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/tickets/1') {
      hits.tickets++;
      return res.end('the app crashes on start');
    }
    const prompt = JSON.parse(body).messages[0].content,
      kind = prompt.includes('classify(') ? 'classify' : 'summarise';
    hits[kind]++;
    // The first summarise never answers: the host "stops" while it is open.
    if (kind === 'summarise' && hang) return hung.push(res);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: kind === 'classify' ? '"Label.Bug"' : '"crash on start"' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const res of hung) res.destroy();
    server.close();
  });
  const origin = 'http://127.0.0.1:' + server.address().port,
    { platform } = await fixture(t, {
      allowHttp: true,
      policy: {
        version: 1,
        resources: {
          assistant: { kind: 'model', namespaces: ['*'], origin, model: 'test-model', maxTokens: 256 },
          tickets: { kind: 'http', namespaces: ['*'], origin, methods: ['GET'], pathPrefix: '/tickets/' },
        },
      },
    });
  const log = await install(platform, await buildInkApp({ slug: 'log', language: 'ink', exports: ['log', 'last'] }, [file('main.ink', LOG)])),
    triage = await install(platform, await taskApp({ app: log.app, release: log.release })),
    total = async () => (await runInstalledInk(platform, triage.app.id, { entry: 'total', input: '[]' }, owner)).valueWire,
    last = async () => (await runInstalledInk(platform, log.app.id, { entry: 'last', input: '[]' }, owner)).valueWire;

  // First host: the run keeps fetch and classify, then stops mid-summarise.
  const first = new InkTasks({ platform }),
    stop = new AbortController(),
    running = first.run(triage.app.id, { task: 'triage', input: '["/tickets/1"]', requestId: 'durable' }, owner, { signal: stop.signal }).catch((e) => e);
  const journal = async () => {
    const keys = await platform.code.stateKeys('ink-tasks', 'run:');
    const key = keys.find((k) => /^run:[a-f0-9]{32}$/.test(k));
    return key && (await platform.code.readState('ink-tasks', key)).value;
  };
  for (let i = 0; i < 200 && !(hung.length && JSON.parse((await journal())?.records || '[]').length >= 2); i++) await new Promise((r) => setTimeout(r, 25));
  const kept = JSON.parse((await journal()).records);
  assert.deepEqual(kept.map((r) => r.effect), ['fetch', 'classify']);
  stop.abort();
  assert.match(String((await running).message), /abort/i);
  assert.equal((await journal()).status, 'running');
  assert.equal(await total(), '0');

  // Second host: the run continues where it stopped.
  hang = false;
  const second = new InkTasks({ platform }),
    [resumed] = await second.resume();
  assert.equal(resumed.valueWire, '{"Ok":"Label.Bug"}');
  assert.equal(second.resumed, 1);
  assert.deepEqual(hits, { tickets: 1, classify: 1, summarise: 2 }, 'only the unfinished effect runs again');
  assert.equal(await total(), '1');
  assert.equal(await last(), '"crash on start"');
  assert.deepEqual(
    parseExactJSON(resumed.trace).effects.map((e) => [e.effect, e.outcome]),
    [['fetch', 'accepted'], ['classify', 'accepted'], ['summarise', 'accepted'], ['notify', 'accepted']],
  );
  const done = await journal();
  assert.equal(done.status, 'done');
  assert.equal(done.records, '[]');

  // The same request identity returns the finished run without running it.
  const again = await second.run(triage.app.id, { task: 'triage', input: '["/tickets/1"]', requestId: 'durable' }, owner);
  assert.equal(again.traceId, resumed.traceId);
  assert.deepEqual(hits, { tickets: 1, classify: 1, summarise: 2 });
  await assert.rejects(second.run(triage.app.id, { task: 'triage', input: '["/tickets/2"]', requestId: 'durable' }, owner), { status: 409 });

  // In-platform replay: effects come from the trace and state changes land on
  // a scratch copy of the state the run started from.
  const replay = await second.replay(triage.app.id, resumed.runId, owner);
  assert.equal(replay.matches, true);
  assert.equal(replay.valueWire, resumed.valueWire);
  assert.deepEqual(hits, { tickets: 1, classify: 1, summarise: 2 }, 'replay performs no effect');
  assert.equal(await total(), '1', 'replay leaves live state alone');
  assert.equal(await last(), '"crash on start"');
  assert.deepEqual(
    (await platform.code.stateKeys('ink-tasks', '')).filter((k) => k.startsWith('replay:') || (k.startsWith('@ink:') && !k.includes('run:'))),
    [],
    'scratch state is removed',
  );
  await assert.rejects(second.replay(log.app.id, resumed.runId, owner), { status: 404 });
});

test(
  'task steps run on the native artifact and its traces replay identically on JavaScript state',
  { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 600000 },
  async (t) => {
    const { NativeInk } = await import('../server/native-ink.mjs'),
      { NativeJobs } = await import('../server/native-jobs.mjs'),
      { inkExecutionSource } = await import('../server/ink-apps.mjs'),
      { join } = await import('node:path');
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (req.url === '/tickets/1') return res.end('the app crashes on start');
      const prompt = JSON.parse(body).messages[0].content;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: prompt.includes('classify(') ? '"Label.Bug"' : '"crash on start"' }] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const origin = 'http://127.0.0.1:' + server.address().port,
      { platform, directory } = await fixture(t, {
        allowHttp: true,
        policy: {
          version: 1,
          resources: {
            assistant: { kind: 'model', namespaces: ['*'], origin, model: 'test-model', maxTokens: 256 },
            tickets: { kind: 'http', namespaces: ['*'], origin, methods: ['GET'], pathPrefix: '/tickets/' },
          },
        },
      });
    const log = await install(platform, await buildInkApp({ slug: 'log', language: 'ink', exports: ['log', 'last'] }, [file('main.ink', LOG)])),
      bundle = await taskApp({ app: log.app, release: log.release }),
      triage = await install(platform, bundle);
    const jobs = await new NativeJobs(directory, {
      native: new NativeInk(join(directory, 'native'), { offline: process.env.INK_NATIVE_OFFLINE === '1' }),
      source: () => inkExecutionSource(bundle.ink, bundle.files),
    }).open();
    t.after(() => jobs.close());
    const job = await jobs.enqueue(triage.app.id, triage.release.id);
    await jobs.pump();
    assert.equal(jobs.get(triage.app.id, job.id).status, 'succeeded', JSON.stringify(jobs.get(triage.app.id, job.id)));
    platform.code.nativeJobs = jobs;
    const backends = [],
      run = platform.code.run.bind(platform.code);
    platform.code.run = async (input) => {
      const result = await run(input);
      if (input.namespace === triage.app.id) backends.push(result.backend);
      return result;
    };
    const tasks = new InkTasks({ platform }),
      native = await tasks.run(triage.app.id, { task: 'triage', input: '["/tickets/1"]' }, owner);
    assert.equal(native.valueWire, '{"Ok":"Label.Bug"}');
    assert.ok(backends.length && backends.every((b) => b === 'native'), 'every step ran on the native artifact: ' + backends);
    // The native run's trace replays on JavaScript state started from the
    // same state, with every effect answered from the trace.
    platform.code.nativeJobs = null;
    const replay = await tasks.replay(triage.app.id, native.runId, owner);
    assert.equal(replay.matches, true);
    assert.equal(replay.valueWire, native.valueWire);
  },
);
