import test from 'node:test';
import assert from 'node:assert/strict';
import { poolMethods } from '../infra/fly-pool.mjs';

const id = n => n.toString(16).padStart(32, '0'), runtimeImage = 'registry.invalid/runtime@sha256:' + 'a'.repeat(64), backendImage = 'registry.invalid/backend@sha256:' + 'b'.repeat(64);
function fixture(kind = 'module') {
  const calls = [], machines = new Map(), leases = new Map(), provider = { prefix: 'fixture', runtimeImage, ...poolMethods }, slot = { id: id(1), kind, status: 'idle', appId: null, releaseId: null, leaseId: null }, names = provider.poolNames(slot), authority = { leaseId: id(2), appId: id(3), releaseId: id(4) };
  slot.deployment = { app: names.app, machineId: 'abcde123456789', runtimeImage, ...authority, ...(kind === 'oci' ? { backendApp: names.backendApp, backendMachineId: 'abcdef12345678', backendImage } : {}) };
  const machine = (machineId, image) => ({ id: machineId, name: 'runtime', version: 'v1', instance_id: 'v1', state: 'stopped', config: { image, persist_rootfs: 'never', metadata: { ink_pool_slot: slot.id, ink_pool_lease: authority.leaseId }, env: { INK_OS_APP_ID: authority.appId, INK_OS_RELEASE_ID: authority.releaseId, INK_OS_LEASE_ID: authority.leaseId, PRIVATE_FIXTURE_ENV: 'never-return-in-proof' }, mounts: [], files: [] } });
  machines.set(names.app, [machine(slot.deployment.machineId, runtimeImage)]); machines.set(names.backendApp, kind === 'oci' ? [machine(slot.deployment.backendMachineId, backendImage)] : []);
  let hook = async () => undefined;
  provider.api = async (path, body, method = 'POST', options = {}) => {
    calls.push({ path, body, method, options }); assert.equal(options.sensitive, true);
    const intercepted = await hook(path, body, method, options); if (intercepted !== undefined) return intercepted;
    const match = /^\/apps\/([a-z0-9-]+)\/machines(?:\/([a-f0-9]+))?(\/lease)?$/.exec(path); assert.ok(match, 'Only exact Machine/lease endpoints may be called');
    const [, app, machineId, leaseRoute] = match, rows = machines.get(app); if (!rows) throw Object.assign(Error('missing'), { flyStatus: 404 });
    if (!machineId) { assert.equal(method, 'GET'); return structuredClone(rows); }
    const current = rows.find(machine => machine.id === machineId); if (!current) throw Object.assign(Error('missing'), { flyStatus: 404 });
    if (leaseRoute && method === 'POST') { assert.equal(body.ttl, 120); const nonce = 'fixture-nonce-' + machineId; leases.set(machineId, nonce); return { data: { nonce, version: current.version } }; }
    assert.equal(options.lease, leases.get(machineId), 'Mutation and version GET must carry the exact lease nonce');
    if (leaseRoute) { assert.equal(method, 'DELETE'); leases.delete(machineId); return {}; }
    if (method === 'GET') return structuredClone(current);
    assert.equal(method, 'DELETE'); assert.equal(current.state, 'stopped'); machines.set(app, rows.filter(machine => machine.id !== machineId)); return { ok: true };
  };
  return { slot, provider, names, machines, leases, calls, authority, hook: fn => { hook = fn; }, remove: () => provider.removeStopped(slot) };
}
const deletes = f => f.calls.filter(call => call.method === 'DELETE' && !call.path.endsWith('/lease'));

for (const kind of ['module', 'oci']) test('exact stopped owned ' + kind + ' machines retire under leases; app shells and credentials stay untouched', async () => {
  const f = fixture(kind), result = await f.remove(); assert.equal(result.removed.length, kind === 'oci' ? 2 : 1); assert.equal(deletes(f).length, result.removed.length); assert.equal(f.machines.get(f.names.app).length, 0); assert.equal(f.machines.get(f.names.backendApp).length, 0);
  assert.deepEqual(result.retainedAppShells, [f.names.app, f.names.backendApp]); assert.ok(!JSON.stringify(result).includes('never-return-in-proof')); assert.ok(!JSON.stringify(result).includes('nonce'));
  assert.ok(f.calls.every(call => !call.path.includes('force=') && !call.path.includes('/stop') && !call.path.includes('/secrets') && !call.path.includes('/volumes')));
  const firstDelete = f.calls.findIndex(call => call.method === 'DELETE' && !call.path.endsWith('/lease')), grants = f.calls.map((call, index) => call.method === 'POST' ? index : -1).filter(index => index >= 0); assert.ok(grants.every(index => index < firstDelete));
  const replay = await f.remove(); assert.equal(replay.removed.length, 0); assert.equal(replay.alreadyAbsent.length, kind === 'oci' ? 2 : 1);
});

test('running, foreign, extra, stateful and mismatched configurations are refused before any provider mutation', async () => {
  const changes = [f => f.machines.get(f.names.app)[0].state = 'started', f => f.machines.get(f.names.app)[0].config.metadata.ink_pool_slot = id(9), f => f.machines.get(f.names.app)[0].config.metadata.ink_pool_lease = id(9), f => f.machines.get(f.names.app)[0].config.env.INK_OS_APP_ID = id(9), f => f.machines.get(f.names.app)[0].config.env.INK_OS_RELEASE_ID = id(9), f => f.machines.get(f.names.app)[0].config.env.INK_OS_LEASE_ID = id(9), f => f.machines.get(f.names.app)[0].config.mounts = [{ volume: 'private' }], f => f.machines.get(f.names.app)[0].config.files = [{ guest_path: '/private' }], f => f.machines.get(f.names.app)[0].config.persist_rootfs = 'always', f => f.machines.get(f.names.app)[0].config.image = backendImage, f => f.machines.get(f.names.app).push({ id: 'ffffffffffffff' }), f => f.machines.get(f.names.backendApp).push({ id: 'ffffffffffffff' }), f => f.slot.deployment.app = 'foreign-app'];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.remove(), { status: 409 }); assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0); }
});

test('legacy idle assignment authority is not inferred from current machine environment', async () => {
  const f = fixture(); for (const key of ['leaseId', 'appId', 'releaseId']) delete f.slot.deployment[key];
  await assert.rejects(f.remove(), { code: 'LEGACY_POOL_RETIREMENT_AUTHORITY_MISSING' }); assert.equal(f.calls.length, 0); assert.equal(f.machines.get(f.names.app).length, 1);
  Object.assign(f.slot, f.authority); const result = await f.remove(); assert.equal(result.removed.length, 1);
});

test('lease conflict or version/ownership change after lease acquisition preserves all machines', async () => {
  const f = fixture('oci'); f.hook((path, body, method) => { if (method === 'POST' && path.includes(f.slot.deployment.backendMachineId)) throw Object.assign(Error('conflict'), { flyStatus: 409 }); });
  await assert.rejects(f.remove()); assert.equal(deletes(f).length, 0); assert.equal(f.machines.get(f.names.app).length, 1); assert.equal(f.leases.size, 0);
  for (const mode of ['version', 'lease']) {
    const g = fixture(); let changed = false;
    g.hook((path, body, method) => { if (method === 'GET' && path.endsWith('/' + g.slot.deployment.machineId) && !changed) { changed = true; if (mode === 'version') g.machines.get(g.names.app)[0].version = 'v2'; else g.machines.get(g.names.app)[0].config.metadata.ink_pool_lease = id(9); } });
    await assert.rejects(g.remove(), { status: 409 }); assert.equal(deletes(g).length, 0); assert.equal(g.machines.get(g.names.app).length, 1);
  }
});

test('unexpected inventory appearing after leases blocks deletion and never deletes another app resource', async () => {
  const f = fixture(); let lists = 0;
  f.hook((path, body, method) => { if (method === 'GET' && path === '/apps/' + f.names.app + '/machines' && ++lists === 2) f.machines.get(f.names.app).push({ id: 'ffffffffffffff' }); });
  await assert.rejects(f.remove(), { status: 409 }); assert.equal(deletes(f).length, 0); assert.equal(f.machines.get(f.names.app).length, 2);
});

test('lost delete response reconciles the exact missing machine and confirms empty inventories', async () => {
  const f = fixture(); let lost = false;
  f.hook((path, body, method) => { if (method === 'DELETE' && !path.endsWith('/lease') && !lost) { lost = true; f.machines.set(f.names.app, []); throw Object.assign(Error('response lost'), { flyStatus: 503 }); } });
  const result = await f.remove(); assert.equal(result.removed.length, 1); assert.equal(deletes(f).length, 1);
});

test('future assignment retains lease/app/release/image/version authority for idle retirement', async () => {
  const slot = { id: id(1), kind: 'oci', leaseId: id(2) }, provider = { prefix: 'fixture', runtimeImage, ...poolMethods }, appId = id(3), releaseId = id(4);
  Object.assign(provider, { poolMachines: async () => [], ensureApp: async () => {}, publicAddress: async () => {}, privatePoolAddress: async () => {}, syncEnvironment: async () => 0, resetPoolMachine: async app => ({ id: app.endsWith('-srv') ? 'abcdef12345678' : 'abcde123456789', version: 'v1' }), poolStatus: async () => ({ appId, releaseId, leaseId: slot.leaseId, draining: false }) });
  const deployment = await provider.assignPoolSlot({ slot, appId, releaseId, meta: { backend: { image: backendImage, port: 8080 } }, key: 'fixture', origin: 'https://host.invalid', environment: {} });
  assert.equal(deployment.leaseId, slot.leaseId); assert.equal(deployment.appId, appId); assert.equal(deployment.releaseId, releaseId); assert.equal(deployment.backendImage, backendImage); assert.equal(deployment.runtimeMachineVersion, 'v1'); assert.equal(deployment.backendMachineVersion, 'v1');
});
