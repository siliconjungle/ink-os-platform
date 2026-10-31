import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code } from '../server/code.mjs';

test('bundled Ink execution preserves changes across engine restarts and isolates instances', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-code-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = 'module count; state Total:u32=0; change add(n:u32)->u32 reads(Total) writes(Total){Total=Total+n;return Total;} query total()->u32 reads(Total){return Total;}';
  const first = new Code('.', directory);
  assert.equal((await first.run({ source, entry: 'add', args: [8], instance: 'one' })).output.result, 8);
  const second = new Code('.', directory);
  assert.equal((await second.run({ source, entry: 'total', args: [], instance: 'one' })).output.result, 8);
  assert.equal((await second.run({ source, entry: 'total', args: [], instance: 'two' })).output.result, 0);
  await assert.rejects(second.run({ source, entry: 'add', args: [true], instance: 'one' }));
  assert.equal((await second.run({ source, entry: 'total', args: [], instance: 'one' })).output.result, 8);
});

test('exact integer input and output survive the host transport', async () => {
  const code = new Code('.');
  const result = await code.run({ source: 'module exact; fn same(x:u64)->u64{return x;}', entry: 'same', input: '[18446744073709551615]' });
  assert.equal(result.wire, '18446744073709551615');
  assert.equal(result.output, '18446744073709551615');
});
