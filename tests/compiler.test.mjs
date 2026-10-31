import test from 'node:test';
import assert from 'node:assert/strict';
import { compileInk, compilerInfo, compilerRequest } from '../server/ink-compiler.mjs';

test('the distributed compiler emits JavaScript and Rust for real Ink source', async () => {
  const artifact = await compileInk('module app; fn transform(xs:List<u32>,factor:u32)->List<u32>{return xs.map(fn(x)=>x*factor);}');
  const program = await import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));
  assert.deepEqual(program.callOwned('transform', [[1, 3, 7], 4]), [4, 12, 28]);
  assert.ok(artifact.rust.includes('transform'));
  const prepared = await compilerRequest({ op: 'prepare', core: artifact.core, identity: artifact.manifest.core_sha256, entry: 'transform', input: '[[1,3,7],4]' });
  assert.deepEqual(JSON.parse(prepared.input), [[1, 3, 7], 4]);
  assert.match((await compilerInfo()).sha256, /^[a-f0-9]{64}$/);
});

test('the same compiler supports binary64 and rejects ill-typed programs', async () => {
  const artifact = await compileInk('module precise; fn scale(x:f64)->f64{return x*1.0000000000000002f64;}');
  const program = await import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));
  const result = program.callOwned('scale', [1]);
  assert.deepEqual(result, { F64Bits: '4607182418800017409' });
  const bytes = new ArrayBuffer(8), view = new DataView(bytes); view.setBigUint64(0, BigInt(result.F64Bits));
  assert.equal(view.getFloat64(0), 1.0000000000000002);
  await assert.rejects(compileInk('module broken; fn value()->u32{return true;}'));
});
