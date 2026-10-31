import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { NativeInk } from '../server/native-ink.mjs';
import { inkProgramIdentity } from '../server/ink-compiler.mjs';

const execute = promisify(execFile);
test('actual graph Rust and JavaScript share exact values/checkpoints while native cache and entry selection retain graph identity', { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-native-module-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const build = async (command, args, options) => {
    if (args[0] === 'build' && process.env.INK_TEST_SOURCE_PREPARE) {
      const workspace = dirname(args[args.indexOf('--manifest-path') + 1]);
      const result = await execute(process.env.INK_TEST_SOURCE_PREPARE, ['prepare-sources', workspace, ...(process.env.INK_NATIVE_OFFLINE === '1' ? ['--offline'] : [])], { env: options.env, maxBuffer: 1024 * 1024 });
      const prepared = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.equal(prepared.prepared_outside_measurement, true);
      args = [...args, ...prepared.direct_cargo_arguments];
    }
    return execute(command, args, options);
  };
  const native = new NativeInk(directory, { cargo: process.env.INK_NATIVE_CARGO || 'cargo', rustc: process.env.INK_NATIVE_RUSTC || 'rustc', offline: process.env.INK_NATIVE_OFFLINE === '1', execute: build });
  assert.equal((await native.availability()).available, true);
  const graph = { version: 1, root: 'main.ink', modules: [
    { path: 'main.ink', name: 'counter', source: 'module counter;state Total:u64=0;change add(n:u64)->u64 reads(Total) writes(Total){Total=Total+bump(n);return Total;}query total()->u64 reads(Total){return Total;}fn exact(n:u64)->u64{return unchanged(n);}fn root_secret()->u64{return 7;}', dependencies: ['lib/math.ink'], exports: ['add', 'total', 'exact'] },
    { path: 'lib/math.ink', name: 'math', source: 'module math;fn bump(n:u64)->u64{return n+1;}fn unchanged(n:u64)->u64{return n;}fn hidden()->u64{return 99;}', dependencies: [], exports: ['bump', 'unchanged'] },
  ] };
  const artifact = await native.compile(graph), identity = inkProgramIdentity(artifact);
  const first = await native.build(graph, { namespace: 'graph-proof' });
  assert.deepEqual(first.programIdentity, identity); assert.equal(first.cached, false);
  const record = JSON.parse(await readFile(join(directory, first.id, 'artifact.json'), 'utf8'));
  assert.deepEqual(record.programIdentity, identity); assert.equal(record.source.modules.length, 2);
  const two = await native.run(first.id, { namespace: 'graph-proof', entry: 'add', input: '[1]' });
  assert.equal(two.output.result, 2); assert.deepEqual(two.programIdentity, identity);
  const program = await import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));
  const js = program.createState(); await js.restore(new Uint8Array(Buffer.from(two.snapshot, 'base64')));
  assert.equal(js.invoke('total', []).result, 2n); assert.equal(js.invoke('add', [2n]).result, 5n);
  const nine = await native.run(first.id, { namespace: 'graph-proof', entry: 'add', input: '[3]', snapshot: Buffer.from(await js.checkpoint()).toString('base64') });
  assert.equal(nine.output.result, 9);
  await js.restore(new Uint8Array(Buffer.from(nine.snapshot, 'base64'))); assert.equal(js.invoke('total', []).result, 9n);
  const max = '18446744073709551615';
  assert.equal((await native.run(first.id, { namespace: 'graph-proof', entry: 'exact', input: '[' + max + ']' })).wire, max);
  assert.equal(program.callOwned('exact', [BigInt(max)]).toString(), max);
  for (const entry of ['hidden', 'bump', 'unchanged', 'root_secret']) await assert.rejects(native.run(first.id, { namespace: 'graph-proof', entry }), { status: 403 });
  const changed = structuredClone(graph); changed.modules[1].source += '\n// Exact dependency provenance changes independently of executable core.\n';
  const updated = await native.build(changed, { namespace: 'graph-proof' });
  assert.notEqual(updated.id, first.id); assert.notEqual(updated.programIdentity.identity, first.programIdentity.identity);
  assert.equal(updated.sourceIdentity, first.sourceIdentity);
  assert.equal((await native.build(graph, { namespace: 'graph-proof' })).cached, true);
  const cached = new NativeInk(directory, { cargo: 'unavailable-cargo', rustc: 'unavailable-rustc', execute: async () => { throw Error('The system Rust toolchain is unavailable.'); } });
  assert.equal((await cached.availability()).available, false);
  const restored = await cached.run(first.id, { namespace: 'graph-proof', entry: 'total', snapshot: nine.snapshot });
  assert.equal(restored.output.result, 9); assert.deepEqual(restored.programIdentity, identity);
});
