import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildInkApp, validateInkBundle, inkExecutionSource, installedInk, runInstalledInk } from '../server/ink-apps.mjs';
import { compileInkProgram } from '../server/ink-compiler.mjs';
import { planningOptions, runPlanningProcess } from '../server/ink-planning.mjs';
import { Code } from '../server/code.mjs';
import { World } from '../server/world.mjs';
import { Platform, validateBundle } from '../server/platform.mjs';

const source = await readFile(new URL('./fixtures/planned-counter.ink', import.meta.url), 'utf8');
const plan = await readFile(new URL('./fixtures/planned-counter.plan.json', import.meta.url), 'utf8');
const file = (path, text) => ({ path, base64: Buffer.from(text).toString('base64') });
const manifest = { language: 'ink', slug: 'planned-counter', exports: ['add', 'fail', 'total', 'amount'], optimisation: { version: 1, mode: 'replay', plan: 'counter.plan.json' } };
const files = [file('main.ink', source), file('counter.plan.json', plan)];
const implementation = bundle => JSON.parse(Buffer.from(bundle.files.find(f => f.path === bundle.ink.implementation.path).base64, 'base64'));
function changeImplementation(bundle, update) {
  const result = structuredClone(bundle), value = implementation(result); update(value);
  result.files.find(f => f.path === result.ink.implementation.path).base64 = Buffer.from(JSON.stringify(value)).toString('base64');
  return result;
}
test('release binds real selected code, full evidence, target inventory and explicit selection provenance', async () => {
  const bundle = await buildInkApp(manifest, files), value = implementation(bundle);
  assert.equal(bundle.ink.version, 3);
  assert.equal(value.checked.steps, 1);
  assert.notEqual(value.checked.input, value.checked.selected);
  assert.equal(value.selection.mode, 'replay');
  assert.ok(Object.keys(JSON.parse(value.plan).steps[0].package.knowledge.objects).length);
  assert.equal(JSON.parse(value.artifact.core).program.functions.find(f => f.name === 'amount').body.Var, 'n');
  assert.equal(value.targets.native.available, true);
  assert.equal(value.targets.gpu.available, false);
  await validateInkBundle(validateBundle(bundle));
  const execution = await inkExecutionSource(bundle.ink, bundle.files), artifact = await compileInkProgram(execution);
  assert.equal(artifact.manifest.core_sha256, value.checked.selected);
  const module = await import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));
  assert.equal(module.callOwned('amount', [18446744073709551615n]), 18446744073709551615n);
});

test('deployment rejects false proofs, modified artifacts, stale source, compiler and inventory substitutions', async () => {
  const bundle = await buildInkApp(manifest, files);
  for (const update of [
    value => { value.artifact.javascript += '\n// substituted target'; value.targets.javascript.sha256 = createHash('sha256').update(value.artifact.javascript).digest('hex'); },
    value => { value.compiler = '0'.repeat(64); },
    value => { value.targets.auto.nativeFallback = 'unchecked'; },
    value => { value.checked.selected = '0'.repeat(64); },
    value => { const packet = JSON.parse(value.plan); packet.steps[0].package.proofs = {}; value.plan = JSON.stringify(packet); },
    value => { const packet = JSON.parse(value.plan); packet.steps[0].package.selected.program.functions.find(f => f.name === 'amount').body = { Num: 99 }; value.plan = JSON.stringify(packet); },
    value => { value.selection.mode = 'baseline'; },
  ]) await assert.rejects(validateInkBundle(changeImplementation(bundle, update)));
  const changed = structuredClone(bundle); changed.files.find(f => f.path === 'server/main.ink').base64 = Buffer.from(source + '\n// changed source bytes').toString('base64');
  await assert.rejects(validateInkBundle(changed), /identity mismatch/);
});

test('baseline/selected release switching preserves exact state, events, rollback and restart without migration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-planned-lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const world = await new World(directory).open();
  const platform = await new Platform({ root: '.', directory, world, origin: 'http://127.0.0.1:1', adminToken: 'test', environmentKey: Buffer.alloc(32, 3).toString('base64'), provider: { async deploy() { return { provider: 'fixture', url: 'http://127.0.0.1:1' }; } } }).open();
  platform.code = new Code('.', join(directory, 'code'), world);
  const app = await platform.createApp({ slug: 'planned-counter' }), owner = { owner: true, admin: true, namespace: 'os' };
  const baseline = await buildInkApp({ ...manifest, optimisation: { version: 1, mode: 'baseline' } }, files);
  const plainRelease = await platform.createRelease(app.id, baseline); await platform.publish(app.id, plainRelease.id);
  assert.equal((await runInstalledInk(platform, app.id, { entry: 'add', input: '[7]' }, owner)).valueWire, '7');
  const before = await platform.code.loadCheckpoint(app.id, 'ink-app:state', owner);
  const selected = await platform.createRelease(app.id, await buildInkApp(manifest, files)); await platform.publish(app.id, selected.id);
  assert.equal((await installedInk(platform, app.id)).implementation.steps, 1);
  assert.equal((await runInstalledInk(platform, app.id, { entry: 'total' }, owner)).valueWire, '7');
  assert.deepEqual(await platform.code.loadCheckpoint(app.id, 'ink-app:state', owner), before);
  const failed = await runInstalledInk(platform, app.id, { entry: 'fail', input: '[9]' }, owner);
  assert.equal(failed.output.committed, false); assert.deepEqual(failed.output.events, []);
  assert.deepEqual(await platform.code.loadCheckpoint(app.id, 'ink-app:state', owner), before);
  const changed = await runInstalledInk(platform, app.id, { entry: 'add', input: '[4]' }, owner);
  assert.equal(changed.valueWire, '11'); assert.equal(changed.output.events.length, 1);
  const after = await platform.code.loadCheckpoint(app.id, 'ink-app:state', owner);
  platform.code = new Code('.', join(directory, 'restart'), world);
  assert.equal((await runInstalledInk(platform, app.id, { entry: 'total' }, owner)).valueWire, '11');
  await platform.publish(app.id, plainRelease.id);
  assert.equal((await runInstalledInk(platform, app.id, { entry: 'total' }, owner)).valueWire, '11');
  assert.deepEqual(await platform.code.loadCheckpoint(app.id, 'ink-app:state', owner), after);
});

test('complete module closure remains bound even when a source edit leaves the core unchanged', async () => {
  const graph = { version: 1, root: 'main.ink', modules: [{ path: 'main.ink', name: 'planned_counter', dependencies: [], exports: manifest.exports }] };
  const bundle = await buildInkApp({ ...manifest, modules: graph }, files);
  await validateInkBundle(validateBundle(bundle));
  const changed = structuredClone(bundle); changed.files.find(f => f.path.endsWith('/main.ink')).base64 = Buffer.from(source + '\n// closure revision').toString('base64');
  await assert.rejects(validateInkBundle(changed), /identity mismatch/);
});

test('planning inputs are bounded and do not choose executable host commands', async () => {
  for (const options of [{ version: 1, mode: 'replay' }, { version: 1, mode: 'search', profile: 'profile.json' }, { version: 1, mode: 'search', compiler: '/arbitrary' }, { version: 1, mode: 'search', timeSeconds: 121 }, { version: 1, mode: 'replay', plan: '../outside' }]) assert.throws(() => planningOptions(options));
  await assert.rejects(runPlanningProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 50), /time limit/);
});

test('auto records a failed build search as a checked baseline; explicit search reports failure and replay needs no planner', async t => {
  const keys = ['INK_OS_PLANNER_COMPILER', 'INK_OS_KNOWLEDGE_ROOT', 'INK_OS_KNOWLEDGE_SNAPSHOT'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]));
  for (const key of keys) process.env[key] = '/missing-ink-os-test-planner';
  const auto = await buildInkApp({ ...manifest, optimisation: { version: 1, mode: 'auto' } }, files);
  assert.equal(implementation(auto).checked.steps, 0);
  assert.equal(implementation(auto).selection.mode, 'baseline');
  assert.equal(implementation(auto).selection.searchFailure, 'ENOENT');
  await assert.rejects(buildInkApp({ ...manifest, optimisation: { version: 1, mode: 'search' } }, files), { code: 'ENOENT' });
  assert.equal(implementation(await buildInkApp(manifest, files)).checked.steps, 1);
});
