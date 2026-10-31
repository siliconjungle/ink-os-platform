import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ManagedNative, managedNativeFromEnvironment } from '../server/managed-native.mjs';
import { NativeInk } from '../server/native-ink.mjs';
import { NativeJobs } from '../server/native-jobs.mjs';

const appId = 'a'.repeat(32), releaseId = 'b'.repeat(32), core = 'c'.repeat(64), compatibilityKey = 'd'.repeat(64);
const release = { supported: true, identity: 'e'.repeat(64), target: 'aarch64-apple-darwin', version: '1.96.0' };
async function fixture(t, { status = { available: false, installable: true }, failure, gate } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ink-native-managed-'));
  const directory = join(root, 'data'), cargo = join(root, 'private/bin/cargo'), rustc = join(root, 'private/bin/rustc');
  let queue, ensureCalls = 0, executeCalls = 0, inspections = 0;
  const observations = [];
  const environment = { CARGO_HOME: join(root, 'private/cargo-home'), CC: join(root, 'apple/clang'), SDKROOT: join(root, 'apple/MacOSX.sdk'), CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER: join(root, 'apple/clang'), AWS_SECRET_ACCESS_KEY: 'must-not-forward', INK_OS_MANAGED_NATIVE_MODULE: '/app-controlled/never-forward.mjs' };
  const managed = new ManagedNative({ modulePath: join(root, 'owner-installer.mjs'), directory: join(root, 'cache'), freeBytes: async () => 200 * 1024 ** 3, load: async () => ({
    nativeToolchainPlan: () => ({ ...release }),
    NativeToolchain: class {
      reserveBytes = 2 * 1024 ** 3; estimatedBytes = 5 * 1024 ** 3;
      async inspect() { inspections++; return status; }
      async ensure() {
        ensureCalls++;
        const persisted = JSON.parse(await readFile(join(directory, 'native-jobs.json'), 'utf8'));
        assert.equal(persisted.jobs.length, 1); assert.equal(persisted.jobs[0].status, 'running'); assert.equal(persisted.jobs[0].phase, 'toolchain');
        observations.push('durable-job-before-ensure');
        await gate;
        if (failure) throw failure;
        return { cargo, rustc, runtimeEnvironment: environment };
      }
    },
  }) });
  const execute = async (command, args, options) => {
    executeCalls++; observations.push('cargo');
    assert.equal(command, cargo); assert.equal(options.env.RUSTC, rustc);
    for (const name of ['CARGO_HOME', 'CC', 'SDKROOT', 'CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER']) assert.equal(options.env[name], environment[name]);
    assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(options.env.INK_OS_MANAGED_NATIVE_MODULE, undefined);
    assert.equal(options.env.CARGO_INCREMENTAL, '0'); assert.equal(options.env.CARGO_PROFILE_RELEASE_DEBUG, '0');
    assert.deepEqual(args.slice(0, 3), ['build', '--locked', '--release']);
    const program = join(options.env.CARGO_TARGET_DIR, 'release', process.platform === 'win32' ? 'ink-native-app.exe' : 'ink-native-app');
    await mkdir(dirname(program), { recursive: true }); await writeFile(program, 'fixture executable bytes');
    return { stdout: '', stderr: '' };
  };
  const native = new NativeInk(join(directory, 'native'), { managed, execute });
  native.compatibility = async () => ({ compatibilityKey, artifact: { rust: 'fn fixture() {}', manifest: { core_sha256: core } }, info: { sha256: core }, lock: Buffer.from('fixture lock'), host: { platform: process.platform, arch: process.arch } });
  queue = await new NativeJobs(directory, { native, source: async () => 'fixture source' }).open();
  t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, native, managed, queue, observations, status, ensureCalls: () => ensureCalls, executeCalls: () => executeCalls, inspections: () => inspections };
}

test('managed status and deterministic planning inspect without installing or executing developer tools', async t => {
  const f = await fixture(t);
  assert.equal(f.ensureCalls(), 0); assert.equal(f.executeCalls(), 0);
  const status = await f.queue.status(); assert.equal(status.available, false); assert.equal(status.installable, true); assert.equal(status.buildAvailable, true);
  const before = await f.native.plan('fixture source', appId);
  f.status.available = true; f.status.installable = false;
  const after = await f.native.plan('fixture source', appId);
  assert.equal(before.id, after.id); assert.deepEqual(before.toolchain, { managed: true, version: '1.96.0', target: release.target, identity: release.identity });
  assert.equal(f.ensureCalls(), 0); assert.equal(f.executeCalls(), 0); assert.equal(f.inspections(), 1);
  assert.equal((await readdir(f.root)).includes('cache'), false);
});

test('explicit builds durably queue before bootstrap and forward only the private toolchain build environment', async t => {
  let unblock; const gate = new Promise(resolve => { unblock = resolve; }); t.after(() => unblock());
  const f = await fixture(t, { gate });
  const first = await f.queue.enqueue(appId, releaseId), second = await f.queue.enqueue(appId, releaseId);
  assert.equal(first.id, second.id);
  unblock(); await f.queue.pump();
  assert.equal(f.queue.get(appId, first.id).status, 'succeeded'); assert.equal(f.queue.get(appId, first.id).phase, 'ready');
  assert.equal(f.ensureCalls(), 1); assert.equal(f.executeCalls(), 1);
  assert.deepEqual(f.observations, ['durable-job-before-ensure', 'cargo']);
  const cached = await f.native.build('fixture source', { namespace: appId });
  assert.equal(cached.cached, true); assert.equal(cached.id, first.artifactId);
  assert.equal(f.ensureCalls(), 1); assert.equal(f.executeCalls(), 1);
  f.managed.inspect = async () => ({ available: false, installable: false, reason: 'Toolchain removed.' });
  f.managed.ensure = async () => assert.fail('cached artifacts must not bootstrap');
  assert.equal((await f.queue.status()).available, false);
  assert.equal(await f.queue.readyFor(appId, 'fixture source'), first.artifactId);
  assert.equal((await f.queue.enqueue(appId, releaseId)).id, first.id);
});

test('bootstrap failures become durable actionable failed jobs and leave ordinary status usable', async t => {
  const failure = Object.assign(Error('/private/owner/cache must not escape'), { code: 'INK_TOOLCHAIN_DISK_RESERVE' });
  const f = await fixture(t, { failure });
  const job = await f.queue.enqueue(appId, releaseId); await f.queue.pump();
  const result = f.queue.get(appId, job.id);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'INK_TOOLCHAIN_DISK_RESERVE'); assert.match(result.error, /free space/);
  assert.ok(!result.error.includes('/private/owner')); assert.equal(f.executeCalls(), 0);
  assert.equal((await f.queue.status()).available, false); assert.equal(f.ensureCalls(), 1);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'native-jobs.json'), 'utf8')).jobs[0].status, 'failed');
});

test('accepted managed jobs never silently switch their pinned installer identity before downloading', async t => {
  const f = await fixture(t), plan = f.managed.plan.bind(f.managed); let calls = 0;
  f.managed.plan = async () => ({ ...await plan(), identity: ++calls === 1 ? release.identity : 'f'.repeat(64) });
  const job = await f.queue.enqueue(appId, releaseId); await f.queue.pump();
  assert.equal(f.queue.get(appId, job.id).status, 'failed');
  assert.equal(f.queue.get(appId, job.id).errorCode, 'INK_NATIVE_TOOLCHAIN_CHANGED');
  assert.equal(f.ensureCalls(), 0); assert.equal(f.executeCalls(), 0);
});

test('unsupported targets, missing Apple SDK, low disk and invalid owner configuration remain nonfatal read-only diagnostics', async () => {
  const unsupported = new ManagedNative({ modulePath: '/owner/installer.mjs', directory: '/owner/cache', load: async () => ({ nativeToolchainPlan: () => ({ supported: false, reason: 'Managed target unsupported; use JavaScript.' }), NativeToolchain: class {} }) });
  assert.equal((await unsupported.inspect()).code, 'INK_TOOLCHAIN_UNSUPPORTED');
  await assert.rejects(unsupported.plan(), { code: 'INK_TOOLCHAIN_UNSUPPORTED', status: 503 });
  const missing = new ManagedNative({ modulePath: '/owner/installer.mjs', directory: '/owner/cache', load: async () => ({ nativeToolchainPlan: () => release, NativeToolchain: class { async inspect() { return { available: false, code: 'INK_TOOLCHAIN_APPLE_SDK' }; } } }) });
  assert.equal((await missing.inspect()).code, 'INK_TOOLCHAIN_APPLE_SDK');
  const lowDisk = new ManagedNative({ modulePath: '/owner/installer.mjs', directory: '/owner/cache', freeBytes: async () => 1, load: async () => ({ nativeToolchainPlan: () => release, NativeToolchain: class { reserveBytes = 2; estimatedBytes = 5; async inspect() { return { available: false, installable: true }; } } }) });
  assert.equal((await lowDisk.inspect()).code, 'INK_TOOLCHAIN_DISK_RESERVE');
  assert.equal((await new ManagedNative({ modulePath: './app-supplied.mjs', directory: '/owner/cache', load: () => assert.fail('must not load relative modules') }).inspect()).code, 'INK_MANAGED_NATIVE_CONFIG');
  assert.equal(managedNativeFromEnvironment({}), null);
  assert.equal((await managedNativeFromEnvironment({ INK_OS_MANAGED_NATIVE_MODULE: '/missing-owner-module.mjs' }).inspect()).code, 'INK_MANAGED_NATIVE_CONFIG');
});

test('absent managed owner configuration preserves system compiler selection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ink-native-system-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const native = new NativeInk(root, { cargo: 'owner-cargo', rustc: 'owner-rustc', execute: async (command, args) => { calls.push([command, args]); return { stdout: command + ' fixture version' }; } });
  const status = await native.availability(); assert.equal(status.available, true); assert.equal(status.managed, undefined);
  assert.deepEqual(calls, [['owner-rustc', ['-vV']], ['owner-cargo', ['--version']]]);
});
