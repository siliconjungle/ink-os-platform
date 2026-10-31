import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimePool } from '../server/runtime-pool.mjs';

const oldImage = 'registry.invalid/runtime@sha256:' + '1'.repeat(64), newImage = 'registry.invalid/runtime@sha256:' + '2'.repeat(64), customImage = 'registry.invalid/custom@sha256:' + '3'.repeat(64);
const id = n => n.toString(16).padStart(32, '0');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function fixture(t, count = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-pool-maintenance-')), states = new Map(), calls = [], hooks = {};
  const provider = {
    runtimeImage: oldImage,
    async poolStopped(slot) { calls.push(['stopped', slot.id]); if (hooks.stopped) return hooks.stopped(slot); return !states.has(slot.id) || states.get(slot.id).stopped; },
    async poolStatus(slot) { calls.push(['status', slot.id]); if (hooks.status) return hooks.status(slot); const state = states.get(slot.id); return { appId: slot.appId, releaseId: slot.releaseId, leaseId: slot.leaseId, ...state }; },
    async drainPoolSlot(slot, key, input) { calls.push(['drain', slot.id]); if (hooks.drain) return hooks.drain(slot, key, input); const state = states.get(slot.id), idle = !state.activeRequests && !state.resources && (!state.startPinned || input.allowIdle); if (idle) state.draining = true; return { idle, appId: slot.appId, releaseId: slot.releaseId, leaseId: slot.leaseId, ...state }; },
    async stopPoolSlot(slot) { calls.push(['stop', slot.id]); if (hooks.stop) return hooks.stop(slot); const state = states.get(slot.id); assert.ok(state.draining); assert.equal(state.activeRequests, 0); assert.equal(state.resources, 0); state.stopped = true; return true; },
    async removeStopped(slot) { calls.push(['remove', slot.id]); if (hooks.remove) return hooks.remove(slot); assert.equal(states.get(slot.id)?.stopped ?? true, true); states.delete(slot.id); return { removed: [slot.deployment.machineId] }; },
    async poolInvoke(slot) { calls.push(['invoke', slot.id]); if (hooks.invoke) return hooks.invoke(slot); return { ok: true }; },
    async assignPoolSlot({ slot }) { calls.push(['assign', slot.id]); states.set(slot.id, { stopped: false, activeRequests: 0, resources: 0, startPinned: false, draining: false }); return { app: 'fixture-p-' + slot.id.slice(0, 12), machineId: 'abcde123456789', runtimeImage: oldImage }; }
  };
  const runtime = { prepare: async () => {}, leaseToken: (app, release, lease) => 'fixture:' + app + ':' + release + ':' + lease }, environment = { values: () => ({}) };
  const pool = await new RuntimePool({ directory, provider, runtime, environment, origin: 'https://host.invalid' }).open({ sweep: false });
  t.after(async () => { await pool.close(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < count; i++) { const slot = { id: id(i + 1), kind: 'module', status: 'ready', appId: id(100 + i), releaseId: id(200 + i), leaseId: id(300 + i), holds: [], allowIdle: false, lastUsedAt: 1, startedAt: 1 }; slot.deployment = { app: 'fixture-p-' + slot.id.slice(0, 12), machineId: (i + 1).toString(16).padStart(14, '0'), runtimeImage: oldImage, leaseId: slot.leaseId, appId: slot.appId, releaseId: slot.releaseId }; pool.slots.push(slot); states.set(slot.id, { stopped: false, activeRequests: 0, resources: 0, startPinned: false, draining: false }); pool.verified.set(slot.id, slot.leaseId); }
  await pool.save();
  const quiesce = options => pool.maintenanceQuiesce({ retireRuntimeImage: false, fromRuntimeImage: oldImage, targetRuntimeImage: newImage, ...options });
  return { pool, states, calls, hooks, provider, runtime, environment, directory, quiesce };
}

test('all idle workers stop before old default retirement; custom images and unassigned stopped slots remain honest', async t => {
  const f = await fixture(t, 3), custom = f.pool.slots[1], idle = f.pool.slots[2]; custom.deployment.runtimeImage = customImage; f.states.get(idle.id).stopped = true; Object.assign(idle, { status: 'idle', appId: null, releaseId: null, leaseId: null });
  const result = await f.quiesce({ retireRuntimeImage: true }); assert.equal(result.admissionClosed, true); for (const key of ['active', 'held', 'uncertain', 'pending', 'requests', 'admissions', 'oldRuntimeSlotsRemaining']) assert.equal(result[key], 0, key); assert.deepEqual(result.retired, [id(1), id(3)]); assert.deepEqual(result.customRuntimeSlots, [custom.id]);
  assert.equal(f.pool.slots.length, 1); assert.equal(custom.deployment.runtimeImage, customImage); assert.equal(custom.status, 'idle');
  const firstRemove = f.calls.findIndex(([kind]) => kind === 'remove'), stops = f.calls.map(([kind], n) => kind === 'stop' ? n : -1).filter(n => n >= 0); assert.ok(stops.every(n => n < firstRemove));
  const saved = JSON.parse(await readFile(join(f.directory, 'runtime-pool.json'))); assert.equal(saved.retirements.length, 2); assert.ok(saved.retirements.every(row => row.state === 'removed')); assert.ok(saved.retirements.every(row => row.authority.deployment.leaseId));
  await assert.rejects(f.pool.ensure(id(50), id(51), {}), { status: 503 }); await assert.rejects(f.pool.invoke(id(50), id(51), {}, {}), { status: 503 }); await assert.rejects(f.pool.hold('expired', 'new work'), { status: 503 });
  assert.deepEqual(f.pool.releaseMaintenance(), { admissionClosed: false }); assert.ok(await f.pool.ensure(id(50), id(51), {}));
});

test('preflight preserves active, held, pinned, unavailable and malformed worker status without draining anything', async t => {
  for (const reason of ['active', 'resources', 'held', 'held-stopped', 'pinned', 'unavailable', 'malformed', 'pending', 'requests']) {
    const f = await fixture(t, 2), slot = f.pool.slots[0], state = f.states.get(slot.id);
    if (reason === 'active') state.activeRequests = 1; if (reason === 'resources') state.resources = 1; if (reason.startsWith('held')) slot.holds.push({ id: 'fixture', label: 'work' }); if (reason === 'held-stopped') state.stopped = true; if (reason === 'pinned') state.startPinned = true;
    if (reason === 'unavailable') f.hooks.status = async () => { throw Error('unavailable'); }; if (reason === 'malformed') f.hooks.status = async () => ({ appId: slot.appId, releaseId: slot.releaseId, leaseId: slot.leaseId });
    if (reason === 'pending') f.pool.pending.set('fixture', Promise.resolve()); if (reason === 'requests') f.pool.requests.set(slot.leaseId, 1);
    const result = await f.quiesce({ retireRuntimeImage: true }); assert.equal(result.admissionClosed, false, reason); assert.ok(result.active || result.held || result.uncertain, reason); assert.equal(f.calls.filter(([kind]) => ['drain', 'stop', 'remove'].includes(kind)).length, 0, reason);
    f.pool.pending.clear(); f.pool.requests.clear();
  }
});

test('preparing does not deny continuations or releaseHold/allowIdle cleanup; their queued admissions defeat closure', async t => {
  const f = await fixture(t), slot = f.pool.slots[0], entered = deferred(), proceed = deferred(); f.states.get(slot.id).startPinned = true;
  f.hooks.status = async current => { entered.resolve(); await proceed.promise; return { appId: current.appId, releaseId: current.releaseId, leaseId: current.leaseId, ...f.states.get(current.id) }; };
  const inspecting = f.quiesce(); await entered.promise; assert.equal(f.pool.admissionClosed, false);
  const hold = await f.pool.hold(slot.leaseId, 'continuing work'); assert.ok(hold.id); await f.pool.releaseHold(slot.leaseId, hold.id); await f.pool.allowIdle(slot.leaseId); assert.deepEqual(await f.pool.invoke(slot.appId, slot.releaseId, {}, {}), { ok: true });
  const continuing = await f.pool.hold(slot.leaseId, 'still finishing'); proceed.resolve(); const first = await inspecting; assert.equal(first.admissionClosed, false); assert.equal(first.held, 1); assert.equal(f.calls.filter(([kind]) => kind === 'stop').length, 0); await f.pool.releaseHold(slot.leaseId, continuing.id);
  f.hooks.status = null; const second = await f.quiesce(); assert.equal(second.admissionClosed, true); assert.equal(second.uncertain, 0);
});

test('an admitted request and an ensure still pending across queued admission cannot slip into a closed pool', async t => {
  const f = await fixture(t), slot = f.pool.slots[0], entered = deferred(), proceed = deferred(); f.hooks.invoke = async () => { entered.resolve(); await proceed.promise; return { ok: true }; };
  const request = f.pool.invoke(slot.appId, slot.releaseId, {}, {}); await entered.promise; const busy = await f.quiesce(); assert.equal(busy.admissionClosed, false); assert.ok(busy.requests > 0); assert.equal(f.calls.filter(([kind]) => kind === 'stop').length, 0); proceed.resolve(); await request;
  const g = await fixture(t, 0), prepare = deferred(), prepared = deferred(); g.runtime.prepare = async () => { prepared.resolve(); await prepare.promise; };
  const ensuring = g.pool.ensure(id(80), id(81), {}); await prepared.promise; const pending = await g.quiesce(); assert.equal(pending.admissionClosed, false); assert.ok(pending.pending > 0 || pending.admissions > 0); assert.equal(g.calls.filter(([kind]) => kind === 'stop').length, 0); prepare.resolve(); await ensuring;
});

test('a final drain busy race reopens admission immediately and keeps the background worker responsive', async t => {
  const f = await fixture(t), slot = f.pool.slots[0]; f.hooks.drain = async current => { f.states.get(current.id).resources = 1; return { idle: false, appId: current.appId, releaseId: current.releaseId, leaseId: current.leaseId, ...f.states.get(current.id) }; };
  const result = await f.quiesce({ retireRuntimeImage: true }); assert.equal(result.admissionClosed, false); assert.equal(result.active, 1); assert.equal(result.retired.length, 0); assert.equal(slot.status, 'ready'); assert.equal(f.calls.filter(([kind]) => ['stop', 'remove'].includes(kind)).length, 0); assert.deepEqual(await f.pool.invoke(slot.appId, slot.releaseId, {}, {}), { ok: true });
});

test('inside-queue admission checks reject ensure/invoke/hold after the barrier closes', async t => {
  for (const action of ['ensure', 'invoke', 'hold']) {
    const f = await fixture(t), slot = f.pool.slots[0];
    if (action === 'ensure') { f.pool.slots = []; f.pool.verified.clear(); }
    const queued = deferred(), unblock = deferred(); const originalChange = f.pool.change.bind(f.pool); let first = true;
    f.pool.change = run => originalChange(async () => { if (first) { first = false; queued.resolve(); await unblock.promise; } return run(); });
    const task = action === 'ensure' ? f.pool.ensure(id(90), id(91), {}) : action === 'invoke' ? f.pool.invoke(slot.appId, slot.releaseId, {}, {}) : f.pool.hold(slot.leaseId, 'queued work');
    await queued.promise; f.pool.admissionClosed = true; unblock.resolve(); await assert.rejects(task, { status: 503 }); assert.equal(f.calls.filter(([kind]) => ['assign', 'invoke'].includes(kind)).length, 0); assert.equal(f.pool.admissions.size, 0);
  }
});

test('unconfirmed stop, unavailable removal and legacy authority failures preserve metadata and reopen admission', async t => {
  const f = await fixture(t), original = f.pool.slots[0].deployment; f.hooks.stop = async () => false;
  const stopped = await f.quiesce({ retireRuntimeImage: true }); assert.equal(stopped.admissionClosed, false); assert.ok(stopped.uncertain); assert.equal(f.pool.slots[0].deployment, original); assert.equal(f.calls.filter(([kind]) => kind === 'remove').length, 0);
  const g = await fixture(t); g.hooks.remove = async () => { throw Object.assign(Error('missing authority'), { code: 'LEGACY_POOL_RETIREMENT_AUTHORITY_MISSING' }); };
  const failed = await g.quiesce({ retireRuntimeImage: true }); assert.equal(failed.admissionClosed, false); assert.equal(failed.oldRuntimeSlotsRemaining, 1); assert.ok(failed.diagnostics.some(row => row.reason === 'legacy-retirement-authority-missing')); assert.equal(g.pool.retirements[0].state, 'blocked-legacy-authority'); assert.ok(g.pool.slots[0].deployment);
  const bootstrap = await g.quiesce({ retireRuntimeImage: false }); assert.equal(bootstrap.admissionClosed, true); assert.equal(bootstrap.uncertain, 0); assert.equal(bootstrap.oldRuntimeSlotsRemaining, 1);
});

test('lost removal response persists exact intent and restart retries only saved stopped identity', async t => {
  const f = await fixture(t); let once = true;
  f.hooks.remove = async slot => { f.states.delete(slot.id); if (once) { once = false; throw Error('response lost after deletion'); } return { removed: [], alreadyAbsent: [slot.deployment.machineId] }; };
  const first = await f.quiesce({ retireRuntimeImage: true }); assert.equal(first.admissionClosed, false); assert.equal(first.uncertain, 1); assert.equal(f.pool.retirements[0].state, 'intent');
  const reopened = await new RuntimePool({ directory: f.directory, provider: f.provider, runtime: f.runtime, environment: f.environment, origin: 'https://host.invalid' }).open({ sweep: false }); t.after(() => reopened.close());
  const second = await reopened.maintenanceQuiesce({ retireRuntimeImage: true, fromRuntimeImage: oldImage, targetRuntimeImage: newImage }); assert.equal(second.admissionClosed, true); assert.equal(second.oldRuntimeSlotsRemaining, 0); assert.equal(reopened.slots.length, 0); assert.equal(reopened.retirements[0].state, 'removed');
});

test('persistence failure never publishes a successful barrier or discards deployment authority', async t => {
  const f = await fixture(t), slot = f.pool.slots[0]; f.pool.save = async () => { throw Error('fixture disk failure'); };
  const result = await f.quiesce({ retireRuntimeImage: true }); assert.equal(result.admissionClosed, false); assert.ok(result.uncertain); assert.equal(slot.status, 'uncertain'); assert.ok(slot.deployment); assert.equal(f.calls.filter(([kind]) => ['stop', 'remove'].includes(kind)).length, 0);
});

test('an existing continuation can reclaim idle capacity during preflight instead of failing solely because maintenance is preparing', async t => {
  const f = await fixture(t), entered = deferred(), proceed = deferred(); f.pool.maxLeases = 1; f.pool.maxMachines = 1; let first = true;
  f.hooks.status = async slot => { if (first) { first = false; entered.resolve(); await proceed.promise; } return { appId: slot.appId, releaseId: slot.releaseId, leaseId: slot.leaseId, ...f.states.get(slot.id) }; };
  const inspecting = f.quiesce(); await entered.promise;
  const next = await f.pool.ensure(id(700), id(701), {}); assert.equal(next.appId, id(700)); assert.ok(f.calls.some(([kind]) => kind === 'stop')); assert.ok(f.calls.some(([kind]) => kind === 'assign'));
  proceed.resolve(); const result = await inspecting; assert.equal(result.admissionClosed, false); assert.ok(result.uncertain); assert.equal(f.pool.pending.size, 0);
});

test('already queued release retirement can finish during preflight and defeats the inspected slot baseline', async t => {
  const f = await fixture(t), slot = f.pool.slots[0], entered = deferred(), proceed = deferred(); let first = true;
  f.hooks.status = async current => { if (first) { first = false; entered.resolve(); await proceed.promise; } return { appId: current.appId, releaseId: current.releaseId, leaseId: current.leaseId, ...f.states.get(current.id) }; };
  const inspecting = f.quiesce(); await entered.promise; await f.pool.retireRelease(slot.appId, slot.releaseId); proceed.resolve();
  const result = await inspecting; assert.equal(result.admissionClosed, false); assert.ok(result.uncertain); assert.equal(f.pool.retiring.size, 0); assert.equal(slot.deployment, undefined);
});

test('malformed, mismatched or newly active drain proofs never authorize a stop', async t => {
  for (const change of [status => status.leaseId = id(999), status => status.activeRequests = 1, status => status.resources = 1, status => status.draining = false, status => delete status.startPinned]) {
    const f = await fixture(t), slot = f.pool.slots[0]; f.hooks.drain = async current => { const status = { idle: true, appId: current.appId, releaseId: current.releaseId, leaseId: current.leaseId, ...f.states.get(current.id), draining: true }; change(status); return status; };
    const result = await f.quiesce({ retireRuntimeImage: true }); assert.equal(result.admissionClosed, false); assert.ok(result.uncertain); assert.equal(f.calls.filter(([kind]) => ['stop', 'remove'].includes(kind)).length, 0); assert.ok(slot.deployment); assert.ok(slot.leaseId);
  }
});

test('explicit saved-authority adoption can supersede a proven pre-mutation legacy refusal without changing ambiguous intents', async t => {
  const f = await fixture(t); f.hooks.remove = async () => { throw Object.assign(Error('legacy'), { code: 'LEGACY_POOL_RETIREMENT_AUTHORITY_MISSING' }); };
  await f.quiesce({ retireRuntimeImage: true }); assert.equal(f.pool.retirements[0].state, 'blocked-legacy-authority');
  // This represents an explicit separately authenticated adoption of saved
  // metadata, never inferred by maintenance from live machine environment.
  f.pool.slots[0].deployment.runtimeMachineVersion = 'adopted-v1'; f.hooks.remove = null;
  const result = await f.quiesce({ retireRuntimeImage: true }); assert.equal(result.admissionClosed, true); assert.equal(result.oldRuntimeSlotsRemaining, 0); assert.equal(f.pool.retirements.length, 2); assert.equal(f.pool.retirements[0].state, 'blocked-legacy-authority'); assert.equal(f.pool.retirements[1].state, 'removed');
  const g = await fixture(t); g.hooks.remove = async () => { throw Error('uncertain response'); }; await g.quiesce({ retireRuntimeImage: true }); g.pool.slots[0].deployment.runtimeMachineVersion = 'different-authority';
  const blocked = await g.quiesce({ retireRuntimeImage: true }); assert.equal(blocked.admissionClosed, false); assert.ok(blocked.diagnostics.some(row => row.reason === 'retirement-authority-changed')); assert.equal(g.pool.retirements.length, 1);
});
