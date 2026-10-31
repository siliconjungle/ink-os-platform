import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { captureProcessReceipt, captureCurrentProcessReceipt, checkProcessReceipt, processReceiptContext } from '../server/process-receipt.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ink-process-receipt-'))), children = [];
  t.after(async () => { for (const child of children) await child.finish(); await rm(directory, { recursive: true, force: true }); });
  return { directory, children };
}
async function worker(children) {
  const secret = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['-e', "process.stdin.on('data',()=>process.stdout.write('pong\\n'));process.stdout.write('ready\\n');", secret], { env: { PROCESS_RECEIPT_PRIVATE_MARKER: secret }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let finished = false;
  child.finish = async () => { if (finished) return; finished = true; child.stdin.end(); const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null); };
  children.push(child);
  assert.match(String((await once(child.stdout, 'data'))[0]), /ready/);
  return { child, secret };
}
async function capture(t, child, directory) {
  const captured = await captureProcessReceipt({ pid: child.pid, directory, child });
  if (captured.state === 'unverified' && process.platform !== 'linux') { assert.equal(captured.preserveWorker, true); t.skip('Optional platform kernel probe unavailable: ' + captured.reason); return; }
  assert.equal(captured.state, 'captured', JSON.stringify(captured)); assert.equal(captured.verified, true);
  return captured.receipt;
}
async function alive(child) {
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  const pong = once(child.stdout, 'data'); child.stdin.write('ping\n'); assert.match(String((await pong)[0]), /pong/);
}

test('actual owned child kernel start receipt verifies while live and becomes gone after natural stdin EOF', async t => {
  const { directory, children } = await fixture(t), { child, secret } = await worker(children);
  const receipt = await capture(t, child, directory); if (!receipt) return;
  assert.equal((await checkProcessReceipt(receipt, { directory, pid: child.pid })).state, 'same-process');
  const serialized = JSON.stringify(receipt);
  for (const privateText of [directory, process.execPath, secret, 'PROCESS_RECEIPT_PRIVATE_MARKER', 'process.stdin']) assert.equal(serialized.includes(privateText), false);
  assert.deepEqual(Object.keys(receipt).sort(), ['format', 'hostHash', 'pid', 'platform', 'provider', 'scopeHash', 'startHash'].sort());
  await alive(child); await child.finish();
  const result = await checkProcessReceipt(JSON.parse(serialized), { directory }); assert.equal(result.state, 'gone'); assert.equal(result.verified, true);
});

test('current host operation identity is authoritative without weakening child ownership capture', async t => {
  const { directory } = await fixture(t), current = await captureCurrentProcessReceipt({ directory });
  if (current.state === 'unverified' && process.platform !== 'linux') { t.skip('Optional platform kernel probe unavailable'); return; }
  assert.equal(current.state, 'captured'); assert.equal(current.receipt.pid, process.pid);
  assert.equal((await checkProcessReceipt(current.receipt, { directory })).state, 'same-process');
  assert.equal((await captureProcessReceipt({ pid: process.pid, directory })).state, 'unverified');
  assert.equal(JSON.stringify(current.receipt).includes(directory), false);
});

test('a mismatched start receipt distinguishes a live unrelated PID without disturbing its worker', async t => {
  const { directory, children } = await fixture(t), { child } = await worker(children);
  const receipt = await capture(t, child, directory); if (!receipt) return;
  const mismatched = { ...receipt, startHash: randomBytes(32).toString('hex') };
  const result = await checkProcessReceipt(mismatched, { directory });
  assert.equal(result.state, 'different-process'); assert.equal(result.verified, true); assert.equal(result.blocksCurrentRoot, false); assert.equal(result.preserveWorker, true);
  await alive(child);
  assert.equal((await checkProcessReceipt(receipt, { directory })).state, 'same-process');
});

test('execution root relocation/replacement and foreign boot receipts cannot hold the new root behind an unrelated PID', async t => {
  const { directory, children } = await fixture(t), { child } = await worker(children);
  const root = join(directory, 'instance'); await mkdir(root);
  const receipt = await capture(t, child, root); if (!receipt) return;
  const moved = join(directory, 'relocated'); await rename(root, moved);
  assert.equal((await checkProcessReceipt(receipt, { directory: moved })).state, 'foreign-scope');
  await mkdir(root); const replacement = await checkProcessReceipt(receipt, { directory: root });
  assert.equal(replacement.state, 'foreign-scope'); assert.equal(replacement.reason, 'different-execution-root'); assert.equal(replacement.blocksCurrentRoot, false);
  const boot = await checkProcessReceipt({ ...receipt, hostHash: randomBytes(32).toString('hex') }, { directory: moved });
  assert.equal(boot.state, 'foreign-scope'); assert.equal(boot.reason, 'different-host-boot-or-pid-namespace');
  await alive(child);
});

test('opaque host/root identity survives a separate Node host-app restart on the same OS boot', async t => {
  const { directory } = await fixture(t), before = await processReceiptContext({ directory });
  if (!before.verified && process.platform !== 'linux') { t.skip('Platform context unavailable: ' + before.reason); return; }
  assert.equal(before.verified, true);
  const moduleURL = new URL('../server/process-receipt.mjs', import.meta.url).href;
  const source = `import {processReceiptContext} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(await processReceiptContext({directory:process.argv[1]})));`;
  const after = JSON.parse((await execute(process.execPath, ['--input-type=module', '-e', source, directory], { env: {}, maxBuffer: 4096, timeout: 5000 })).stdout);
  assert.deepEqual(after, before);
  assert.match(before.hostHash, /^[a-f0-9]{64}$/); assert.match(before.scopeHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(before).includes(directory), false);
});

test('legacy, invalid and inaccessible identities preserve ambiguous live workers without treating PID existence as proof', async t => {
  const { directory, children } = await fixture(t), { child } = await worker(children);
  const legacy = await checkProcessReceipt(undefined, { directory, pid: child.pid });
  assert.equal(legacy.state, 'unverified'); assert.equal(legacy.reason, 'numeric-pid-only'); assert.equal(legacy.preserveWorker, true);
  for (const receipt of [{ pid: child.pid }, { format: 'ink-os-process-receipt-v1', pid: child.pid, hostHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64), startHash: 'c'.repeat(64) }]) assert.equal((await checkProcessReceipt(receipt, { directory })).state, 'unverified');
  assert.equal((await checkProcessReceipt(undefined, { directory, pid: -1 })).state, 'unverified');
  const other = await worker(children);
  assert.equal((await captureProcessReceipt({ pid: child.pid, directory, child: other.child })).reason, 'child-handle-pid-mismatch');
  await alive(other.child);
  const receipt = await capture(t, child, directory); if (!receipt) return;
  assert.equal((await checkProcessReceipt(receipt, { directory: join(directory, 'absent') })).state, 'unverified');
  assert.equal((await checkProcessReceipt(receipt, { directory, pid: child.pid + 1 })).reason, 'receipt-pid-mismatch');
  assert.equal((await captureProcessReceipt({ pid: process.pid, directory })).state, 'unverified');
  await alive(child); await child.finish();
  assert.equal((await checkProcessReceipt(undefined, { directory, pid: child.pid })).state, 'gone');
});
