import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code } from '../server/code.mjs';
import { World, hash } from '../server/world.mjs';
import { Platform } from '../server/platform.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { inkSpec, inkEntries, inkCommands } from '../shared/ink-app.mjs';
import { runInstalledInk } from '../server/ink-apps.mjs';
import { migrateInstalledInk } from '../server/ink-migrations.mjs';

const owner = { owner: true, admin: true, namespace: 'os' }, stateKey = 'ink-app:state';
const oldSource = 'module old_counter; state Total:u64=0; change seed(value:u64)->u64 writes(Total){Total=value;return Total;} query export_state()->u64 reads(Total){return Total;} fn plain()->u64{return 0;}';
const newSource = 'module new_counter; state Current:u64=0; change initialize(value:u64)->u64 writes(Current){Current=value;return Current;} query current()->u64 reads(Current){return Current;}';
const max = '18446744073709551615';

async function fixture(t, { old = oldSource, next = newSource, oldExports = ['seed', 'export_state', 'plain'], nextExports = ['initialize', 'current'], value = max, collaborative = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-migration-')); let collaboration;
  t.after(async () => { await collaboration?.close(); await rm(directory, { recursive: true, force: true }); });
  const world = await new World(directory).open();
  const platform = await new Platform({ root: '.', directory, world, origin: 'http://127.0.0.1:1', adminToken: 'test-owner-only', environmentKey: Buffer.alloc(32, 3).toString('base64'), provider: { async deploy() { return { provider: 'fixture', url: 'http://127.0.0.1:1' }; } } }).open();
  platform.code = new Code('.', join(directory, 'code'), world);
  if (collaborative) { collaboration = new Collaboration({ directory, world }); platform.collaboration = collaboration; await collaboration.recover(); }
  const app = await platform.createApp({ slug: 'migration-proof', title: 'Migration proof', capabilities: ['code.execute', 'world.read', 'world.write'] });
  async function release(source, exports) {
    const compiled = await platform.code.compile(source), spec = inkSpec({ source: 'server/main.ink', exports });
    return platform.createRelease(app.id, { ink: spec, commands: inkCommands(spec, inkEntries(compiled.artifact.manifest)), entry: 'index.html', files: [
      { path: 'server/main.ink', base64: Buffer.from(source).toString('base64') }, { path: 'index.html', base64: Buffer.from('<!doctype html>').toString('base64') },
    ] });
  }
  const from = await release(old, oldExports); await platform.publish(app.id, from.id);
  await runInstalledInk(platform, app.id, { entry: 'seed', input: `[${value}]`, backend: 'javascript' }, owner);
  const to = await release(next, nextExports); await platform.publish(app.id, to.id, from.id);
  const saved = await platform.code.loadCheckpoint(app.id, stateKey, owner), before = structuredClone(saved);
  const input = { fromReleaseId: from.id, toReleaseId: to.id, query: 'export_state', change: 'initialize', expectedAppRevision: platform.app(app.id).revision, expectedCheckpointRevision: saved.revision };
  return { directory, world, platform, appId: app.id, from, to, old, next, before, input, release, closeCollaboration: async () => { await collaboration?.close(); collaboration = null; } };
}

test('actual Wasm-checked migration exports old state and imports exact u64 into a different source/schema', async t => {
  const f = await fixture(t);
  await assert.rejects(runInstalledInk(f.platform, f.appId, { entry: 'current', backend: 'javascript' }, owner), { status: 409 });
  const result = await migrateInstalledInk(f.platform, f.appId, f.input, owner);
  assert.equal(result.committed, true); assert.equal(result.exportValueWire, max); assert.equal(result.valueWire, max);
  assert.notEqual(result.fromDigest, result.digest); assert.equal(result.previousRevision, f.before.revision); assert.ok(result.revision > result.previousRevision);
  assert.equal((await runInstalledInk(f.platform, f.appId, { entry: 'current', backend: 'javascript' }, owner)).valueWire, max);
  const stored = await f.platform.code.loadCheckpoint(f.appId, stateKey, owner);
  assert.notEqual(stored.value.snapshot, f.before.value.snapshot); assert.equal(stored.value.digest, hash(newSource));
  const restartedWorld = await new World(f.directory).open(), restarted = new Code('.', join(f.directory, 'code'), restartedWorld);
  assert.equal((await restarted.run({ source: newSource, entry: 'current', namespace: f.appId, stateKey, backend: 'javascript', principal: owner })).output.result, max);
});

test('collaborative state uses its actual cursor CAS and persists the migrated snapshot', async t => {
  const f = await fixture(t, { collaborative: true });
  const result = await migrateInstalledInk(f.platform, f.appId, f.input, owner);
  assert.equal(result.valueWire, max); assert.ok(result.revision > f.before.revision);
  const migrated = await f.platform.code.loadCheckpoint(f.appId, stateKey, owner);
  await f.closeCollaboration();
  const world = await new World(f.directory).open(), collaboration = new Collaboration({ directory: f.directory, world });
  try {
    await collaboration.recover(); const code = new Code('.', join(f.directory, 'code'), world);
    assert.deepEqual(await code.loadCheckpoint(f.appId, stateKey, owner), migrated);
    assert.equal((await code.run({ source: newSource, entry: 'current', namespace: f.appId, stateKey, backend: 'javascript', principal: owner })).output.result, max);
  } finally { await collaboration.close(); }
});

test('float bit tokens pass through exact query wire to new initializer without Number coercion', async t => {
  const old = 'module old_float; state Total:f32=0.0; change seed(value:f32)->f32 writes(Total){Total=value;return Total;} query export_state()->f32 reads(Total){return Total;}',
    next = 'module new_float; state Current:f32=0.0; change initialize(value:f32)->f32 writes(Current){Current=value;return Current;} query current()->f32 reads(Current){return Current;}';
  const bits = '{"F32Bits":2147483648}';
  const f = await fixture(t, { old, next, oldExports: ['seed', 'export_state'], value: bits });
  const result = await migrateInstalledInk(f.platform, f.appId, f.input, owner);
  assert.equal(result.exportValueWire, bits); assert.equal(result.valueWire, bits);
  assert.equal((await runInstalledInk(f.platform, f.appId, { entry: 'current', backend: 'javascript' }, owner)).valueWire, bits);
});

test('compiler rejects incompatible new parameter type and preserves the exact old checkpoint', async t => {
  const next = 'module wrong_type; state Current:Bool=false; change initialize(value:Bool)->Bool writes(Current){Current=value;return Current;} query current()->Bool reads(Current){return Current;}';
  const f = await fixture(t, { next });
  await assert.rejects(migrateInstalledInk(f.platform, f.appId, f.input, owner), { status: 400, code: 'new-change-input-or-type-invalid' });
  assert.deepEqual(await f.platform.code.loadCheckpoint(f.appId, stateKey, owner), f.before);
});

test('old query/new change effects and actual app exports cannot be relabelled or bypassed', async t => {
  const f = await fixture(t);
  for (const patch of [{ query: 'seed' }, { query: 'plain' }, { query: 'missing' }, { change: 'current' }, { change: 'missing' }]) {
    await assert.rejects(migrateInstalledInk(f.platform, f.appId, { ...f.input, ...patch }, owner), { status: 400 });
    assert.deepEqual(await f.platform.code.loadCheckpoint(f.appId, stateKey, owner), f.before);
  }
  const hidden = await fixture(t, { nextExports: ['current'] });
  await assert.rejects(migrateInstalledInk(hidden.platform, hidden.appId, hidden.input, owner), { code: 'new-entry-must-be-exported-single-argument-change' });
  assert.deepEqual(await hidden.platform.code.loadCheckpoint(hidden.appId, stateKey, owner), hidden.before);
});

test('owner authority, explicit checkpoint/app revisions and matching old release provenance are required', async t => {
  const f = await fixture(t);
  assert.throws(() => migrateInstalledInk(f.platform, f.appId, f.input, { owner: false }), { status: 403 });
  assert.throws(() => migrateInstalledInk(f.platform, f.appId, f.input, { ...owner, keyId: 'read-only-owner-key', scopes: ['world:read'] }), { status: 403 });
  for (const patch of [{ expectedCheckpointRevision: f.before.revision + 1 }, { expectedAppRevision: f.input.expectedAppRevision + 1 }, { toReleaseId: f.from.id }, { fromReleaseId: 'f'.repeat(32) }]) {
    await assert.rejects(migrateInstalledInk(f.platform, f.appId, { ...f.input, ...patch }, owner));
    assert.deepEqual(await f.platform.code.loadCheckpoint(f.appId, stateKey, owner), f.before);
  }
  const unrelated = await f.release(newSource + '\nfn unrelated()->u32{return 1;}\n', ['initialize', 'current']);
  await assert.rejects(migrateInstalledInk(f.platform, f.appId, { ...f.input, fromReleaseId: unrelated.id }, owner), { code: 'old-release-does-not-match-checkpoint' });
  const record = f.world.get(f.from.id), body = JSON.parse(record.body);
  await f.world.update(record.id, { body: JSON.stringify({ ...body, appId: 'f'.repeat(32) }) }, { writer: 'os', expected: record.revision });
  await assert.rejects(migrateInstalledInk(f.platform, f.appId, f.input, owner), { code: 'release-source-provenance-mismatch' });
  assert.deepEqual(await f.platform.code.loadCheckpoint(f.appId, stateKey, owner), f.before);
});

test('invalid snapshots and corrupt release bytes never get identity-patched or reset', async t => {
  const f = await fixture(t), originalBundle = f.platform.bundle.bind(f.platform);
  f.platform.bundle = async id => id === f.from.id ? { ...(await originalBundle(id)), entry: 'tampered.html' } : originalBundle(id);
  await assert.rejects(migrateInstalledInk(f.platform, f.appId, f.input, owner), { code: 'release-bundle-integrity-mismatch' });
  assert.deepEqual(await f.platform.code.loadCheckpoint(f.appId, stateKey, owner), f.before);
  f.platform.bundle = originalBundle;
  const invalid = { ...f.before.value, snapshot: Buffer.from('not a checkpoint').toString('base64') };
  const changed = await f.platform.code.saveCheckpoint(f.appId, stateKey, invalid, f.before.revision, owner);
  const before = await f.platform.code.loadCheckpoint(f.appId, stateKey, owner);
  await assert.rejects(migrateInstalledInk(f.platform, f.appId, { ...f.input, expectedCheckpointRevision: changed.revision }, owner));
  assert.deepEqual(await f.platform.code.loadCheckpoint(f.appId, stateKey, owner), before);
});

test('checkpoint CAS preserves an intervening winner instead of overwriting it or restoring stale state', async t => {
  for (const collaborative of [false, true]) {
    const f = await fixture(t, { collaborative }), save = f.platform.code.saveCheckpoint.bind(f.platform.code); let raced = false, winner;
    f.platform.code.saveCheckpoint = async (...args) => {
      if (!raced) { raced = true; await save(f.appId, stateKey, f.before.value, f.before.revision, owner); winner = await f.platform.code.loadCheckpoint(f.appId, stateKey, owner); }
      return save(...args);
    };
    await assert.rejects(migrateInstalledInk(f.platform, f.appId, f.input, owner), { status: 409 });
    assert.deepEqual(await f.platform.code.loadCheckpoint(f.appId, stateKey, owner), winner);
    assert.equal(winner.value.digest, f.before.value.digest);
  }
});

test('app revision races abort before saving; queued ordinary execution observes the committed migrated state', async t => {
  const f = await fixture(t), compile = f.platform.code.compile.bind(f.platform.code); let raced = false;
  f.platform.code.compile = async source => {
    const result = await compile(source);
    if (source === newSource && !raced) { raced = true; const app = f.platform.app(f.appId); await f.world.update(app.id, { title: 'changed concurrently' }, { writer: 'os', expected: app.revision }); }
    return result;
  };
  await assert.rejects(migrateInstalledInk(f.platform, f.appId, f.input, owner), { code: 'selected-release-or-app-revision-changed' });
  assert.deepEqual(await f.platform.code.loadCheckpoint(f.appId, stateKey, owner), f.before);
  f.platform.code.compile = compile;
  let entered, unblock; const enteredPromise = new Promise(resolve => entered = resolve), block = new Promise(resolve => unblock = resolve); let once = false;
  f.platform.code.compile = async source => { const result = await compile(source); if (source === newSource && !once) { once = true; entered(); await block; } return result; };
  const migration = migrateInstalledInk(f.platform, f.appId, { ...f.input, expectedAppRevision: f.platform.app(f.appId).revision }, owner);
  await enteredPromise;
  const ordinary = runInstalledInk(f.platform, f.appId, { entry: 'current', backend: 'javascript' }, owner);
  unblock(); assert.equal((await migration).valueWire, max); assert.equal((await ordinary).valueWire, max);
});
