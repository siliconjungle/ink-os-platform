import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Code } from '../server/code.mjs';
import { World } from '../server/world.mjs';
import { Platform, validateBundle } from '../server/platform.mjs';
import { compileInkModules, inkProgramIdentity } from '../server/ink-compiler.mjs';
import { buildInkApp, validateInkBundle, installedInk, runInstalledInk, inkSource } from '../server/ink-apps.mjs';
import { inkModuleGraph, inkSpec } from '../shared/ink-app.mjs';
import { migrateInstalledInk } from '../server/ink-migrations.mjs';
import { NativeInk } from '../server/native-ink.mjs';
import { NativeJobs } from '../server/native-jobs.mjs';

const owner = { owner: true, admin: true, namespace: 'os' };
const file = (path, bytes) => ({ path, base64: Buffer.from(bytes).toString('base64') });
const library = 'module library;fn bump(n:u64)->u64{return n+1;}fn hidden()->u64{return 99;}';
const oldRoot = 'module counter;state Total:u64=0;change add(n:u64)->u64 reads(Total) writes(Total){Total=Total+bump(n);return Total;}query total()->u64 reads(Total){return Total;}fn private_root()->u64{return 12;}';
const nextRoot = 'module counter;state Current:u64=0;change initialize(n:u64)->u64 writes(Current){Current=n;return Current;}query current()->u64 reads(Current){return Current;}fn private_root()->u64{return 12;}';
function graph(root = oldRoot, exports = ['add', 'total']) {
  return { version: 1, root: 'main.ink', modules: [
    { path: 'main.ink', name: 'counter', source: root, dependencies: ['lib/math.ink'], exports },
    { path: 'lib/math.ink', name: 'library', source: library, dependencies: [], exports: ['bump'] },
  ] };
}
function packageInput(input = graph(), exports = input.modules.find(module => module.path === input.root).exports) {
  const modules = { ...input, modules: input.modules.map(({ source, ...module }) => module) };
  return { manifest: { language: 'ink', slug: 'module-proof', title: 'Module proof', modules, exports }, files: input.modules.map(module => file(module.path, module.source)) };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-module-apps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const world = await new World(directory).open();
  const platform = await new Platform({ root: '.', directory, world, origin: 'http://127.0.0.1:1', adminToken: 'test-owner', environmentKey: Buffer.alloc(32, 5).toString('base64'), provider: { async deploy() { return { provider: 'fixture', url: 'http://127.0.0.1:1' }; } } }).open();
  platform.code = new Code('.', join(directory, 'code'), world);
  const app = await platform.createApp({ slug: 'module-proof', capabilities: ['code.execute', 'world.read', 'world.write'] });
  const release = async (input = graph(), exports) => {
    const pkg = packageInput(input, exports);
    const bundle = await buildInkApp(pkg.manifest, pkg.files);
    return platform.createRelease(app.id, bundle);
  };
  return { directory, platform, appId: app.id, release };
}

test('actual graph Wasm compiles, executes and selects only declared concrete root entries', async t => {
  const f = await fixture(t), input = graph(), code = f.platform.code;
  const compiled = await code.compile(input);
  assert.deepEqual(compiled.entries.map(entry => entry.name), ['add', 'total']);
  assert.equal(compiled.digest, compiled.artifact.module_graph.identity);
  assert.equal(compiled.sourceIdentity.coreHash, compiled.artifact.manifest.core_sha256);
  for (const entry of ['hidden', 'bump', 'private_root']) await assert.rejects(code.run({ source: input, entry }), /Select an exported/);
  const run = await code.run({ source: input, entry: 'add', input: '[18446744073709551614]', namespace: f.appId, stateKey: 'graph-state', backend: 'javascript' });
  assert.equal(run.wire.includes('18446744073709551615'), true);
  assert.deepEqual(run.sourceIdentity, compiled.sourceIdentity);
  const saved = await code.loadCheckpoint(f.appId, 'graph-state', owner);
  assert.deepEqual(saved.value.sourceIdentity, compiled.sourceIdentity);
  const reversed = structuredClone(input); reversed.modules.reverse(); reversed.modules[1].exports.reverse();
  assert.equal((await code.compile(reversed)).digest, compiled.digest);
  const commented = structuredClone(input); commented.modules[1].source += '\n// dependency revision\n';
  const changed = await code.compile(commented);
  assert.equal(changed.artifact.manifest.core_sha256, compiled.artifact.manifest.core_sha256);
  assert.notEqual(changed.digest, compiled.digest);
  await assert.rejects(code.run({ source: commented, entry: 'total', namespace: f.appId, stateKey: 'graph-state' }), { status: 409 });
  assert.deepEqual(await code.loadCheckpoint(f.appId, 'graph-state', owner), saved);
  const restarted = new Code('.', join(f.directory, 'restart-code'), f.platform.world);
  assert.equal((await restarted.run({ source: input, entry: 'total', namespace: f.appId, stateKey: 'graph-state', backend: 'javascript' })).output.result, '18446744073709551615');
});

test('release packaging preserves the complete private graph and enforces API, command and UI allowlists', async t => {
  const f = await fixture(t), pkg = packageInput();
  const bundle = await buildInkApp(pkg.manifest, pkg.files);
  assert.equal(bundle.ink.source, 'server/modules/main.ink');
  assert.deepEqual(bundle.ink.modules.modules.map(module => module.path), ['server/modules/lib/math.ink', 'server/modules/main.ink']);
  assert.equal(bundle.files.filter(file => file.path.endsWith('.ink')).length, 2);
  const metadata = JSON.parse(Buffer.from(bundle.files.find(file => file.path === 'app.json').base64, 'base64'));
  assert.deepEqual(metadata.entries.map(entry => entry.name), ['add', 'total']);
  assert.deepEqual(bundle.commands.map(command => command.handler.entry), ['add', 'total']);
  await validateInkBundle(validateBundle(bundle));
  const release = await f.platform.createRelease(f.appId, bundle); await f.platform.publish(f.appId, release.id);
  assert.deepEqual((await installedInk(f.platform, f.appId)).entries.map(entry => entry.name), ['add', 'total']);
  assert.equal((await runInstalledInk(f.platform, f.appId, { entry: 'add', input: '[8]', backend: 'javascript' }, owner)).valueWire, '9');
  for (const entry of ['hidden', 'bump', 'private_root']) await assert.rejects(runInstalledInk(f.platform, f.appId, { entry }, owner), { status: 403 });
  await assert.rejects(buildInkApp({ ...pkg.manifest, exports: ['bump'] }, pkg.files), /root module exports/);
  await assert.rejects(buildInkApp({ ...pkg.manifest, ui: { entry: 'hidden' } }, pkg.files), /root module exports/);
  const forged = structuredClone(bundle); forged.ink.exports.push('private_root');
  await assert.rejects(validateInkBundle(forged), /root module exports/);
  const replaced = structuredClone(bundle); replaced.files.find(file => file.path.endsWith('lib/math.ink')).base64 = Buffer.from('module library;fn bump(n:u64)->Bool{return true;}').toString('base64');
  await assert.rejects(validateInkBundle(replaced), /type|expected|mismatch/i);
});

test('graph packages reject missing closure, unsafe bytes/paths, cycles and unsupported frontend semantics', async () => {
  const pkg = packageInput();
  await assert.rejects(buildInkApp(pkg.manifest, pkg.files.slice(0, 1)), /missing/);
  const invalid = structuredClone(pkg.files); invalid[1].base64 = Buffer.from([0xff]).toString('base64');
  await assert.rejects(buildInkApp(pkg.manifest, invalid), /UTF-8/);
  for (const mutate of [
    value => value.modules.push({ ...value.modules[1], path: 'orphan.ink', name: 'orphan' }),
    value => value.modules[1].dependencies.push('main.ink'),
    value => value.modules[1].path = '../foreign.ink',
    value => value.modules[1].path = 'https://example.invalid/lib.ink',
    value => value.modules[1].exports.push('hidden'),
  ]) {
    const value = graph(); mutate(value);
    if (value.modules[1].exports.includes('hidden')) { value.modules[0].source = oldRoot.replace('bump(n)', 'missing(n)'); await assert.rejects(compileInkModules(value)); }
    else assert.throws(() => inkModuleGraph(value, { sources: true }));
  }
  const unsupported = graph('module counter;record R{n:u64,}fn run(v:R)->R{return R{..v,n:1};}', ['run']);
  await assert.rejects(compileInkModules(unsupported), /do not yet support record updates/);
  const foreign = graph(oldRoot.replace('bump(n)', 'hidden()'));
  await assert.rejects(compileInkModules(foreign), /directly imported export/);
  assert.throws(() => inkSpec({ source: 'server/main.ink', exports: [], modules: packageInput().manifest.modules }), /missing|root/);
});

test('migration uses verified old and new complete graphs, exact wire and checkpoint identity', async t => {
  const f = await fixture(t), from = await f.release(); await f.platform.publish(f.appId, from.id);
  await runInstalledInk(f.platform, f.appId, { entry: 'add', input: '[18446744073709551614]', backend: 'javascript' }, owner);
  const before = await f.platform.code.loadCheckpoint(f.appId, 'ink-app:state', owner);
  const to = await f.release(graph(nextRoot, ['initialize', 'current'])); await f.platform.publish(f.appId, to.id, from.id);
  await assert.rejects(runInstalledInk(f.platform, f.appId, { entry: 'current' }, owner), { status: 409 });
  const input = { fromReleaseId: from.id, toReleaseId: to.id, query: 'total', change: 'initialize', expectedAppRevision: f.platform.app(f.appId).revision, expectedCheckpointRevision: before.revision };
  const migrated = await migrateInstalledInk(f.platform, f.appId, input, owner);
  assert.equal(migrated.exportValueWire, '18446744073709551615'); assert.notEqual(migrated.fromDigest, migrated.digest);
  assert.notEqual(migrated.fromSourceIdentity.graphHash, migrated.sourceIdentity.graphHash);
  const after = await f.platform.code.loadCheckpoint(f.appId, 'ink-app:state', owner);
  assert.deepEqual(after.value.sourceIdentity, migrated.sourceIdentity);
  assert.equal((await runInstalledInk(f.platform, f.appId, { entry: 'current', backend: 'javascript' }, owner)).valueWire, '18446744073709551615');
});

test('native planning and queue bind graph identity without invoking a toolchain; hidden native entries fail before spawn', async t => {
  const f = await fixture(t), input = graph(), native = new NativeInk(join(f.directory, 'native'), { execute: async () => assert.fail('No toolchain execution authorized in this test.') });
  const first = await native.compatibility(input, f.appId), changed = structuredClone(input); changed.modules[1].source += '\n// changed\n';
  const second = await native.compatibility(changed, f.appId);
  assert.notEqual(first.compatibilityKey, second.compatibilityKey);
  assert.equal(first.artifact.manifest.core_sha256, second.artifact.manifest.core_sha256);
  const id = '1'.repeat(64), directory = join(f.directory, 'native', id), executable = Buffer.from('never executed');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, process.platform === 'win32' ? 'program.exe' : 'program'), executable);
  const record = { namespace: f.appId, source: input, host: { platform: process.platform, arch: process.arch }, sourceIdentity: first.artifact.manifest.core_sha256, programIdentity: inkProgramIdentity(first.artifact), executableSHA256: createHash('sha256').update(executable).digest('hex') };
  await writeFile(join(directory, 'artifact.json'), JSON.stringify(record));
  await assert.rejects(native.run(id, { namespace: f.appId, entry: 'hidden' }), { status: 403 });
  record.source = changed; await writeFile(join(directory, 'artifact.json'), JSON.stringify(record));
  await assert.rejects(native.run(id, { namespace: f.appId, entry: 'total' }), { status: 409 });
  const queuedNative = { compatibility: (...args) => native.compatibility(...args), plan: async (source, namespace, artifact) => ({ ...await native.compatibility(source, namespace, artifact), id }), build: async () => ({ id, sourceIdentity: first.artifact.manifest.core_sha256, programIdentity: inkProgramIdentity(first.artifact), cached: true }), record: async () => record };
  const queue = await new NativeJobs(join(f.directory, 'queue'), { native: queuedNative, source: async () => input }).open();
  t.after(() => queue.close());
  const job = await queue.enqueue(f.appId, 'a'.repeat(32)); await queue.pump();
  assert.deepEqual(queue.get(f.appId, job.id).programIdentity, inkProgramIdentity(first.artifact));
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'queue/native-jobs.json'), 'utf8')).jobs[0].programIdentity, inkProgramIdentity(first.artifact));
});
