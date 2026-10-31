import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeInk } from '../server/native-ink.mjs';
import { compileInk } from '../server/ink-compiler.mjs';
import { Code } from '../server/code.mjs';

test('actual compiled Rust preserves browser values and portable state across targets', { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeInk(directory, { offline: process.env.INK_NATIVE_OFFLINE === '1' });
  assert.equal((await native.availability()).available, true);
  const source = 'module parity; record Payload{text:String,wide:u64,integer:Int,scalar:f32,real:f64,maybe:Option<u64>,} event sampled:Payload; state Total:u32=0; fn echo_payload(value:Payload)->Payload{return value;} change sample(value:Payload)->Payload emits(sampled){emit sampled(value);return value;} fn scale(xs:List<u32>,factor:u32)->List<u32>{return xs.map(fn(x)=>x*factor);} change add(n:u32)->u32 reads(Total) writes(Total){Total=Total+n;return Total;} query total()->u32 reads(Total){return Total;}';
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
  const code = new Code('.', join(directory, 'javascript'));
  for (const scalar of [1036831949, 2147483648, 2143289345]) {
    const input = '[{"text":"exact transport","wide":18446744073709551615,"integer":{"Int":"-123456789012345678901234567890"},"scalar":{"F32Bits":' + scalar + '},"real":{"F64Bits":"9221120237041090561"},"maybe":{"Some":18446744073709551615}}]';
    const pure = await native.run(build.id, { namespace: 'test-app', entry: 'echo_payload', input });
    assert.equal(pure.wire, (await code.run({ source, entry: 'echo_payload', input })).wire);
    const event = await native.run(build.id, { namespace: 'test-app', entry: 'sample', input });
    assert.equal(event.wire, (await code.run({ source, entry: 'sample', input, instance: 'event-' + scalar })).wire);
  }
  await appendFile(join(directory, build.id, process.platform === 'win32' ? 'program.exe' : 'program'), 'tamper');
  await assert.rejects(native.run(build.id, { namespace: 'test-app', entry: 'total' }), { code: 'INK_NATIVE_INTEGRITY' });
  assert.equal((await native.build(source, { namespace: 'test-app' })).cached, false);
  assert.equal((await native.run(build.id, { namespace: 'test-app', entry: 'total' })).output.result, 0);
});
