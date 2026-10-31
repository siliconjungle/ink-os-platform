import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeInstance } from '../server/instance.mjs';
import { World } from '../server/world.mjs';
import { Storage } from '../server/storage.mjs';
import { Platform } from '../server/platform.mjs';
import { Collaboration } from '../server/collaboration.mjs';
import { Projects } from '../server/projects.mjs';
import { LocalProvider } from '../infra/local-provider.mjs';
import { createMaintenanceHostAdapter } from '../server/maintenance-host.mjs';
import { maintenanceActivityFields } from '../server/maintenance.mjs';
import { restoreBackup } from '../server/backup-store.mjs';
import { SnapshotGate, createLiveBackup } from '../sdk/src/backup.js';

const password = 'disposable snapshot integration password';
const owner = { owner: true, accountId: 'owner', namespace: 'os' };
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
const idle = () => Object.fromEntries(maintenanceActivityFields.map(key => [key, 0]));
const idlePool = () => ({ admissionClosed: true, active: 0, held: 0, uncertain: 0, oldRuntimeSlotsRemaining: 0, incompatibleRuntimeOverrides: 0, retired: [], customRuntimeImages: [] });
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-live-snapshot-'))), directory = join(root, 'source');
  await writeFile(join(root, 'storage-retention.json'), JSON.stringify({ keep: { source: 'Active generated live-backup fixture; exact reproduction is retained in the test source.' }, safe_to_remove: {} }));
  const identity = await initializeInstance({ directory });
  const world = await new World(directory).open(), storage = await new Storage(directory, { env: {} }).open();
  const provider = new LocalProvider();
  const platform = await new Platform({ root: directory, directory, world, storage, provider, origin: 'http://127.0.0.1', adminToken: identity.adminToken, environmentKey: identity.environmentKey }).open();
  platform.collaboration = new Collaboration({ directory, world, storage }); await platform.collaboration.recover();
  platform.projects = await new Projects(directory, { environmentKey: identity.environmentKey }).open();
  let gate; const other = { closed: false }, requests = new Set(), responses = new Set();
  const adapter = createMaintenanceHostAdapter({ platform, requests, responses, externalClosed: () => !!gate?.closed || other.closed });
  gate = new SnapshotGate({ directory, adapter, otherClosed: () => other.closed, pollMs: 2 });
  const releases = []; t.after(async () => {
    for (const release of releases) await release();
    await provider.close(); await platform.collaboration.close(); await world.tail;
    await writeFile(join(root, 'storage-retention.json'), JSON.stringify({ keep: {}, safe_to_remove: { source: 'Completed generated fixture; owned servers and journals closed.', restored: 'Completed generated restore readback; journal handles closed.', 'live.inkbackup': 'Completed encrypted fixture archive; test source reproduces its generated inputs.', 'failed.inkbackup': 'Failed archive must not have been published.', outside: 'Generated symlink-rejection fixture.' } }));
    await rm(root, { recursive: true });
  });
  return { root, directory, identity, world, storage, provider, platform, adapter, gate, other, releases };
}

test('live encrypted capture drains an admitted local app request, blocks new direct app work, and restores its causal state and exact Git source', { timeout: 20000 }, async t => {
  const f = await fixture(t), { platform, provider, gate, world } = f;
  const project = await platform.projects.snapshot({ title: 'Snapshot source', files: [{ path: 'main.ink', mode: '100644', base64: Buffer.from('module snapshot;\n').toString('base64') }] });
  const app = await platform.createApp({ slug: 'snapshot-fixture', projectId: project.id, title: 'Snapshot fixture' });
  const release = await platform.createRelease(app.id, { entry: 'index.html', files: [{ path: 'index.html', base64: Buffer.from('<p>snapshot</p>').toString('base64') }] });
  await platform.publish(app.id, release.id);
  const meta = JSON.parse(world.get(release.id).body), key = platform.runtimeKey(app.id, release.id, meta);
  const started = deferred(), held = deferred(), flushed = deferred(), allowRead = deferred();
  f.releases.push(held.resolve, allowRead.resolve);
  const originalFlush = f.adapter.flush;
  f.adapter.flush = async () => { await originalFlush(); flushed.resolve(); await allowRead.promise; };
  let saved;
  provider.invokeBackend = async () => {
    started.resolve(); await held.promise;
    saved = await platform.collaboration.state(owner, 'admitted', 'os', { count: 7 }, 0, true);
    await world.create({ namespace: 'os', kind: 'note', title: 'Admitted write', body: 'preserved before snapshot' }, { writer: 'os' });
    return { status: 200, body: { saved: true }, headers: {} };
  };
  const accepted = fetch(meta.deployment.url + '/_ink/invoke', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/admitted', method: 'POST' }) });
  await started.promise;
  const archive = join(f.root, 'live.inkbackup');
  const backup = createLiveBackup({ gate, archive, password, timeoutMs: 10000 }); backup.catch(() => {});
  assert.deepEqual(gate.inspect(), { closed: true, phase: 'draining' });
  await assert.rejects(gate.acquireSnapshot(), { status: 409 });
  const refused = await fetch(meta.deployment.url + '/_ink/health'); assert.equal(refused.status, 503); await refused.text();
  assert.equal(provider.servers.size, 1); assert.equal(provider.requests.size, 1);
  held.resolve(); assert.equal((await accepted).status, 200); await flushed.promise;
  assert.equal(gate.closed, true); assert.equal(provider.snapshotAdmissionClosed(), true);
  const doc = await platform.collaboration.document('os', 'state', 'state');
  const checkpoint = await readFile(join(doc.dir, 'checkpoint.json'));
  allowRead.resolve(); const result = await backup;
  assert.equal(result.consistency, 'quiesced'); assert.equal(result.coverage.remoteAssets, false);
  assert.deepEqual(gate.inspect(), { closed: false, phase: 'idle' });
  const resumed = await fetch(meta.deployment.url + '/_ink/health'); assert.equal(resumed.status, 200); await resumed.text();
  assert.equal(provider.servers.size, 1);
  await platform.collaboration.state(owner, 'admitted', 'os', { count: 99 }, saved.revision, true);
  const target = join(f.root, 'restored'); await restoreBackup({ archive, directory: target, password });
  const restoredWorld = await new World(target).open();
  assert.equal(restoredWorld.all().find(row=>row.title==='Admitted write').body, 'preserved before snapshot');
  const restoredCollaboration = new Collaboration({ directory: target, world: restoredWorld, storage: await new Storage(target, { env: {} }).open() });
  f.releases.push(() => restoredCollaboration.close()); await restoredCollaboration.recover();
  assert.deepEqual((await restoredCollaboration.state(owner, 'admitted', 'os')).value, { count: 7 });
  const restoredDoc = await restoredCollaboration.document('os', 'state', 'state');
  assert.deepEqual(await readFile(join(restoredDoc.dir, 'checkpoint.json')), checkpoint);
  assert.deepEqual(await readFile(join(target, 'instance.json')), await readFile(join(f.directory, 'instance.json')));
  assert.deepEqual(await readFile(join(target, 'projects', project.id, 'main.ink')), await readFile(join(project.directory, 'main.ink')));
  assert.deepEqual(await readFile(join(target, 'projects', project.id, '.git', 'HEAD')), await readFile(join(project.directory, '.git', 'HEAD')));
});

test('a held runtime prevents capture; cancellation reopens admission without stopping its work', async () => {
  const controller = new AbortController(), observed = deferred(); let closed = false, resumed = 0, continuing = 0;
  const adapter = { closeAdmission: () => { closed = true; }, resumeAdmission: () => { closed = false; resumed++; }, continueDraining: () => { continuing++; observed.resolve(); }, activity: async () => idle(), quiesceSnapshot: async () => ({ ...idlePool(), held: 1 }), flush: async () => assert.fail('Held work cannot be captured') };
  const gate = new SnapshotGate({ directory: '/unused-fixture', adapter, otherClosed: () => false, pollMs: 2 });
  const pending = gate.acquireSnapshot({ signal: controller.signal }); await observed.promise;
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(closed, false); assert.equal(resumed, 1); assert.ok(continuing >= 1); assert.equal(gate.closed, false);
});

test('a projection race re-enters draining and stale release handles cannot reopen a later snapshot', async () => {
  let flushes = 0, resumes = 0, continuing = 0;
  const adapter = { closeAdmission: () => {}, resumeAdmission: () => { resumes++; }, continueDraining: () => { continuing++; }, activity: async () => idle(), quiesceSnapshot: async () => idlePool(), flush: async () => { if (++flushes === 1) throw Object.assign(Error('Projection changed'), { code: 'MAINTENANCE_ACTIVITY_CHANGED' }); } };
  const gate = new SnapshotGate({ directory: '/unused-fixture', adapter, otherClosed: () => false, pollMs: 1 });
  const first = await gate.acquireSnapshot(); assert.equal(continuing, 1); await first.release();
  const second = await gate.acquireSnapshot(); await first.release(); assert.equal(gate.closed, true); assert.equal(resumes, 1);
  await second.release(); assert.equal(gate.closed, false); assert.equal(resumes, 2);
});

test('archive read failures release the bound live gate and do not publish a partial backup', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'outside'), 'outside'); await symlink(join(f.root, 'outside'), join(f.directory, 'unsafe'));
  const archive = join(f.root, 'failed.inkbackup');
  await assert.rejects(createLiveBackup({ gate: f.gate, archive, password }), /symlinks/);
  assert.equal(f.gate.closed, false); await assert.rejects(lstat(archive), { code: 'ENOENT' });
});

test('instance mismatch, missing passwords, external gate conflicts and pre-cancellation leave admission untouched', async t => {
  const f = await fixture(t), archive = join(f.root, 'never.inkbackup');
  assert.throws(() => createLiveBackup({ gate: f.gate, directory: f.root, archive, password }), /same instance/);
  assert.throws(() => createLiveBackup({ gate: f.gate, archive }), /password/);
  f.other.closed = true; await assert.rejects(f.gate.acquireSnapshot(), { status: 409 }); f.other.closed = false;
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.gate.acquireSnapshot({ signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.gate.inspect(), { closed: false, phase: 'idle' });
});

test('a failed admission resume stays closed and can be retried by its original snapshot owner', async t => {
  const f = await fixture(t), original = f.adapter.resumeAdmission; let fail = true;
  f.adapter.resumeAdmission = () => { if (fail) throw Error('Fixture resume failed'); return original(); };
  const snapshot = await f.gate.acquireSnapshot(); await assert.rejects(snapshot.release(), /resume failed/);
  assert.equal(f.gate.closed, true); await assert.rejects(f.gate.acquireSnapshot(), { status: 409 });
  fail = false; await snapshot.release(); assert.equal(f.gate.closed, false);
});

test('a competing runtime inspection is observed without reopening or seizing its admission transaction',async()=>{
  let probes=0,resumes=0;
  const adapter={closeAdmission:()=>{},resumeAdmission:()=>{resumes++;},continueDraining:()=>assert.fail('A competing inspection does not grant this caller a pool gate'),activity:async()=>idle(),quiesceSnapshot:async()=>{if(++probes===1)throw Object.assign(Error('Other inspection owns the pool'),{status:409});return idlePool();},flush:async()=>{}};
  const gate=new SnapshotGate({directory:'/unused-fixture',adapter,otherClosed:()=>false,pollMs:1}),snapshot=await gate.acquireSnapshot();assert.equal(probes,2);assert.equal(resumes,0);assert.equal(gate.closed,true);await snapshot.release();assert.equal(resumes,1);
});
