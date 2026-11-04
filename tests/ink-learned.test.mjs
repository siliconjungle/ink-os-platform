import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../sdk/src/server.js';
import { Projects } from '../server/projects.mjs';
import { learnedRows, applyLearnedRows, learnedLayout } from '../server/ink-learned.mjs';

const execute = promisify(execFile);
const HOLES = `
enum State { Start, Quoted, Closed, }
enum Class { Quote, Comma, Other, }
enum Step { Keep, Drop, End, }
fn authored(s: State, c: Class) -> Option<Step> {
  if s == State.Start { return Some(Step.Keep); }
  return None;
}
fn step(s: State, c: Class) -> Step { return authored(s, c).unwrap_or(learn recover(s, c): choice<Step>); }
query run(s: State, c: Class) -> Step { return step(s, c); }
record Case { s: State, c: Class, want: Step, }
objective mistakes(cases: List<Case>) -> f32 {
  return foldl(cases, 0.0, fn(k)=>fn(total)=>total + choose(step(k.s, k.c) == k.want, 0.0, 1.0));
}
`;
const layout = { holes: [{ name: 'recover', family: 'choice', field: 'recover', parameters: 9, choices: 3, domains: [['State.Start', 'State.Quoted', 'State.Closed'], ['Class.Quote', 'Class.Comma', 'Class.Other']], values: ['Step.Keep', 'Step.Drop', 'Step.End'], admission: 'error-path', declaration: 'step' }], objectives: ['mistakes'] };

test('rows address learned parameters by argument values and edits are checked', () => {
  const params = { recover: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const rows = learnedRows(layout, params);
  assert.deepEqual(rows[1], { hole: 'recover', key: ['State.Quoted', 'Class.Quote'], value: 'Step.Keep' });
  const { next, changed } = applyLearnedRows(layout, params, [{ hole: 'recover', key: ['State.Quoted', 'Class.Quote'], value: 'Step.End' }]);
  assert.deepEqual([next.recover[1], changed], [2, 1]);
  assert.throws(() => applyLearnedRows(layout, params, [{ hole: 'recover', key: ['State.Gone', 'Class.Quote'], value: 'Step.End' }]), /not one of/);
  assert.throws(() => applyLearnedRows(layout, params, [{ hole: 'nope', key: [], value: 'x' }]), /Unknown learn hole/);
  assert.equal(learnedLayout({ core: JSON.stringify({ program: { contracts: {} } }) }), null);
});

test('an installed Ink app with learn holes lists rows in World and admits only improving edits', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-learned-')), data = join(directory, 'data'), source = join(directory, 'source');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR: data, NODE_ENV: 'production', INK_OS_CONFIG: join(data, 'client.json') });
  let child, output = '';
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  async function start() {
    output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
      try { if ((await fetch(url + '/api/health')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(output);
  }
  const cli = async (...args) => JSON.parse((await execute(process.execPath, ['cli/bin/ink-os.mjs', ...args], { env, maxBuffer: 4 * 1024 * 1024 })).stdout);
  await start();
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG, 'utf8'));
  const sdk = createClient({ url, token: config.token });
  await cli('init', source, '--slug', 'learned-ink');
  const manifest = JSON.parse(await readFile(join(source, 'ink-app.json'), 'utf8'));
  manifest.exports.push('run'); await writeFile(join(source, 'ink-app.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'main.ink'), (await readFile(join(source, 'main.ink'), 'utf8')) + HOLES);
  const git = new Projects(source);
  await git.git(source, ['add', '.']);
  await git.git(source, ['-c', 'user.name=Ink test', '-c', 'user.email=ink@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Add a learn hole']);
  const appId = (await cli('deploy', source)).appId;
  const run = async (s, c) => (await sdk.apps.ink.run(appId, 'run', JSON.stringify([s, c]))).value;
  // Generated entries are not app commands.
  await assert.rejects(sdk.apps.ink.run(appId, '__learn_set', '[{}]'), { status: 403 });

  const first = await sdk.apps.ink.learned.get(appId);
  assert.deepEqual(first.objectives, ['mistakes']);
  assert.deepEqual(first.rows[1], { hole: 'recover', key: ['State.Quoted', 'Class.Quote'], value: 'Step.Keep' });
  assert.equal(first.gate, null);
  const edit = rows => ({ format: 'ink-learn-edit-v1', author: 'test agent', reason: 'a quote inside a quoted field ends it', rows });
  await assert.rejects(sdk.apps.ink.learned.edit(appId, { edit: edit([]) }), { status: 409 });
  const cases = [{ s: 'State.Quoted', c: 'Class.Quote', want: 'Step.End' }, { s: 'State.Closed', c: 'Class.Comma', want: 'Step.Drop' }, { s: 'State.Quoted', c: 'Class.Other', want: 'Step.Keep' }];
  await assert.rejects(sdk.apps.ink.learned.gate(appId, { objective: 'other', data: [cases] }), { status: 400 });
  const gate = await sdk.apps.ink.learned.gate(appId, { objective: 'mistakes', data: [cases] });
  assert.match(gate.dataSha256, /^[a-f0-9]{64}$/);

  // A worse edit is rejected and the live app is unchanged.
  const worse = await sdk.apps.ink.learned.edit(appId, { edit: edit([{ hole: 'recover', key: ['State.Quoted', 'Class.Other'], value: 'Step.Drop' }]) });
  assert.deepEqual([worse.admitted, worse.before, worse.after], [false, 2, 3]);
  assert.equal(await run('State.Quoted', 'Class.Other'), 'Step.Keep');
  // An improving edit is admitted, applied live and recorded in World.
  const good = await sdk.apps.ink.learned.edit(appId, { edit: edit([{ hole: 'recover', key: ['State.Quoted', 'Class.Quote'], value: 'Step.End' }]) });
  assert.deepEqual([good.admitted, good.before, good.after, good.changed], [true, 2, 1, 1]);
  assert.equal(await run('State.Quoted', 'Class.Quote'), 'Step.End');
  // Authored behaviour is untouched: the hole only fills what `authored` leaves open.
  assert.equal(await run('State.Start', 'Class.Quote'), 'Step.Keep');
  const neutral = await sdk.apps.ink.learned.edit(appId, { edit: edit([{ hole: 'recover', key: ['State.Start', 'Class.Comma'], value: 'Step.End' }]) });
  assert.equal(neutral.admitted, false);
  const listed = await sdk.apps.ink.learned.get(appId);
  assert.equal(listed.rows[1].value, 'Step.End');
  assert.equal(listed.history.length, 1);
  assert.equal(listed.history[0].receipt.after, 1);
  const objects = await sdk.data.query({ namespace: appId, limit: 100 });
  const records = (objects.objects || objects).filter(o => (o.tags || []).some(tag => tag.startsWith('ink-learned')));
  assert(records.some(o => o.tags.includes('ink-learned-rows')) && records.some(o => o.tags.includes('ink-learned-edit')));

  // The admitted parameters survive a restart.
  await stop(); await start();
  assert.equal(await run('State.Quoted', 'Class.Quote'), 'Step.End');
  assert.equal((await sdk.apps.ink.learned.get(appId)).rows[1].value, 'Step.End');
});
