import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, copyFile, rename } from 'node:fs/promises';
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
  const residentCode=new Code('.',join(directory,'resident'));t.after(()=>residentCode.close());
  residentCode.nativeJobs={native,readyFor:async()=>build.id};
  const run=(entry,input,backend='native',requestId)=>residentCode.run({source,namespace:'test-app',stateKey:'native-state',entry,input,backend,requestId});
  assert.equal((await run('add','[3]','native','once')).output.result,3);
  assert.equal((await run('add','[3]','native','once')).output.result,3);
  assert.equal((await run('total','[]')).output.result,3);
  assert.equal(residentCode.residents.starts,1);
  assert.equal((await run('add','[4]','javascript')).output.result,7);
  assert.equal((await run('total','[]')).output.result,7,'native reloads committed JavaScript journal');
  await assert.rejects(run('add','[true]'));assert.equal((await run('total','[]')).output.result,7);
  await assert.rejects(run('add','[1.0]'));assert.equal((await run('total','[]')).output.result,7);
  const eventInput='[{"text":"resident","wide":18446744073709551615,"integer":{"Int":"-7"},"scalar":{"F32Bits":2147483648},"real":{"F64Bits":"9221120237041090561"},"maybe":{"None":null}}]';
  const eventReply=await run('sample',eventInput);assert.equal(eventReply.output.events.length,1);
  // Opposite target must deterministically replay exact events and wide values.
  assert.equal((await run('total','[]','javascript')).output.result,7);
  await residentCode.residents.close();
  const {InkResidents}=await import('../server/ink-residents.mjs');residentCode.residents=new InkResidents();
  assert.equal((await run('sample',eventInput,'native','event')).output.events.length,1);
  const largeEvent=eventInput.replace('"resident"','"'+'x'.repeat(512*1024)+'"');
  await run('sample',largeEvent,'native','large-event');
  await run('add','[0]'); // Compact the large tail through native checkpoint framing.
  const portable=await residentCode.loadCheckpoint('test-app','native-state');assert.ok(portable.value.snapshot);
  assert.ok(Buffer.byteLength(portable.value.snapshot,'base64')>512*1024);
  const executable=join(directory,build.id,process.platform==='win32'?'program.exe':'program');
  // Linux prevents in-place writes to a running executable. Replace its path
  // with a corrupt copy while the resident retains the original inode.
  await copyFile(executable,executable+'.corrupt');await appendFile(executable+'.corrupt','tamper');await rename(executable+'.corrupt',executable);
  await assert.rejects(native.run(build.id, { namespace: 'test-app', entry: 'total' }), { code: 'INK_NATIVE_INTEGRITY' });
  assert.equal((await native.build(source, { namespace: 'test-app' })).cached, false);
  assert.equal((await native.run(build.id, { namespace: 'test-app', entry: 'total' })).output.result, 0);
});

test('native commits report the rows they change, so keyed readers stay current', { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-native-paths-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeInk(directory, { offline: process.env.INK_NATIVE_OFFLINE === '1' });
  const source = 'module rows; record Row{id:u64,open:Bool,} state Rows:Table<u64,Row>=Table.empty(); state Notes:u64=0; change put(row:Row)->Result<Unit,String> reads(Rows) writes(Rows){Rows.put(row.id,row);return Ok(());} change note(x:u64)->Result<Unit,String> reads(Notes) writes(Notes){Notes=x;return Ok(());} query open()->List<Row> reads(Rows){return Rows.values().filter(fn(r)=>r.open);}';
  const build = await native.build(source, { namespace: 'test-app' });
  const code = new Code('.', join(directory, 'resident'));
  t.after(() => code.close());
  code.nativeJobs = { native, readyFor: async () => build.id };
  const hints = [];
  code.commitListeners.add((commit) => hints.push(commit.roots));
  const run = (entry, input) => code.run({ source, namespace: 'test-app', stateKey: 'rows', entry, input, backend: 'native' });
  await run('put', '[{"id":5,"open":true}]');
  await run('put', '[{"id":5,"open":true}]');
  await run('put', '[{"id":7,"open":false}]');
  await run('note', '[3]');
  const compiled = await code.compile(source);
  if (!compiled.artifact.rust.includes('pub fn take_changes(')) {
    // An older compiler: every commit lists every path of its write roots.
    assert.deepEqual(hints[1], hints[0]);
    return;
  }
  const view = compiled.artifact.manifest.state.filters.map((f) => f.path);
  assert.deepEqual(hints[0], ['Rows', ...view, 'Rows[5]'].sort(), 'the written key and the root\'s views');
  assert.deepEqual(hints[1], [], 'an identical rewrite changes nothing');
  assert.deepEqual(hints[2], ['Rows', ...view, 'Rows[7]'].sort());
  assert.ok(hints[3].includes('Notes') && !hints[3].some((p) => p.startsWith('Rows')), 'a note changes no row');
});
