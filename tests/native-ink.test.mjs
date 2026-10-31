import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeInk } from '../server/native-ink.mjs';
import { compileInk } from '../server/ink-compiler.mjs';

test('actual compiled Rust preserves browser values and portable state across targets', { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeInk(directory, { offline: process.env.INK_NATIVE_OFFLINE === '1' });
  assert.equal((await native.availability()).available, true);
  const source = 'module parity; state Total:u32=0; fn scale(xs:List<u32>,factor:u32)->List<u32>{return xs.map(fn(x)=>x*factor);} change add(n:u32)->u32 reads(Total) writes(Total){Total=Total+n;return Total;} query total()->u32 reads(Total){return Total;}';
  const build = await native.build(source, { namespace: 'test-app' });
  const artifact = await compileInk(source), program = await import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));
  const values = [[1, 3, 7, 0xffffffff], 3];
  const result = await native.run(build.id, { namespace: 'test-app', entry: 'scale', args: values });
  assert.deepEqual(result.output, program.callOwned('scale', values));
  const mutation = await native.run(build.id, { namespace: 'test-app', entry: 'add', args: [9] });
  const state = program.createState();
  await state.restore(new Uint8Array(Buffer.from(mutation.snapshot, 'base64')));
  assert.equal(state.invoke('total', []).result, 9);
  state.invoke('add', [5]);
  const restored = await native.run(build.id, { namespace: 'test-app', entry: 'total', args: [], snapshot: Buffer.from(await state.checkpoint()).toString('base64') });
  assert.equal(restored.output.result, 14);
  assert.equal((await native.build(source, { namespace: 'test-app' })).cached, true);
  await assert.rejects(native.run(build.id, { namespace: 'another-app', entry: 'total', args: [] }), { status: 403 });
});
