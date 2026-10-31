import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { NativeJobs } from '../server/native-jobs.mjs';

const appId = 'a'.repeat(32), releaseId = 'b'.repeat(32), compatibilityKey = 'c'.repeat(64), artifactId = 'd'.repeat(64), sourceIdentity = 'e'.repeat(64);

test('queue recovery blocks only workers whose checked identity can still govern this execution root', async t => {
  const cases = [
    { state: 'same-process', blocksCurrentRoot: true, expected: 'recovering' },
    { state: 'unverified', blocksCurrentRoot: true, expected: 'recovering' },
    { state: 'unverified', expected: 'recovering' },
    { state: 'unverified', blocksCurrentRoot: false, expected: 'interrupted' },
    { state: 'gone', expected: 'interrupted' },
    { state: 'different-process', blocksCurrentRoot: false, expected: 'interrupted' },
    { state: 'foreign-scope', blocksCurrentRoot: false, expected: 'succeeded', artifact: true },
  ];
  for (const scenario of cases) {
    const directory = await mkdtemp(join(tmpdir(), 'ink-native-receipt-recovery-'));
    let observation = scenario, queue;
    t.after(async () => { observation = { state: 'gone' }; await queue?.close(); await rm(directory, { recursive: true, force: true }); });
    const receipt = { format: 'opaque-fixture-receipt', pid: 1234 };
    const job = { id: '1'.repeat(32), appId, releaseId, compatibilityKey, artifactId, status: 'running', pid: 1234, processReceipt: receipt };
    await writeFile(join(directory, 'native-jobs.json'), JSON.stringify({ version: 1, jobs: [job] }));
    queue = await new NativeJobs(directory, { native: { record: async () => { if (scenario.artifact) return { sourceIdentity }; throw Object.assign(Error('No artifact'), { code: 'ENOENT' }); } },
      source: async () => 'fixture', checkProcess: async (value, options) => { assert.deepEqual(value, receipt); assert.equal(options.directory, directory); assert.equal(options.pid, 1234); return observation; },
    }).open();
    await queue.pump();
    assert.equal(queue.get(appId, job.id).status, scenario.expected); assert.equal(queue.get(appId, job.id).workerState, scenario.state);
    assert.equal(queue.get(appId, job.id).processReceipt, undefined);
    observation = { state: 'gone' }; await queue.close();
  }
});

test('actual child receipt is durable while compiling and remains absent from public job payloads', { skip: !['darwin', 'linux'].includes(process.platform), timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-native-receipt-capture-'));
  let child, queue, captured;
  const ready = new Promise(resolve => { captured = resolve; });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.stdin.end(); await once(child, 'exit'); }
    await queue?.close(); await rm(directory, { recursive: true, force: true });
  });
  const native = {
    compatibility: async () => ({ compatibilityKey, artifact: { manifest: { core_sha256: sourceIdentity } } }),
    plan: async () => ({ compatibilityKey, id: artifactId, artifact: { manifest: { core_sha256: sourceIdentity } } }),
    build: async (_source, { onProcess }) => {
      child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.once("end",()=>process.exit(0));'], { stdio: ['pipe', 'ignore', 'ignore'] });
      await once(child, 'spawn'); const exited = once(child, 'exit');
      try { await onProcess({ pid: child.pid, artifactId, child }); }
      finally { captured(); }
      await exited; return { id: artifactId, sourceIdentity, cached: false };
    },
  };
  queue = await new NativeJobs(directory, { native, source: async () => 'fixture' }).open();
  const job = await queue.enqueue(appId, releaseId); await ready;
  const privateJob = JSON.parse(await readFile(join(directory, 'native-jobs.json'), 'utf8')).jobs[0];
  assert.equal(privateJob.status, 'running'); assert.equal(privateJob.pid, child.pid); assert.equal(privateJob.processReceiptState, 'captured');
  assert.equal(privateJob.processReceipt.format, 'ink-os-process-receipt-v1'); assert.match(privateJob.processReceipt.startHash, /^[a-f0-9]{64}$/);
  assert.equal(privateJob.child, undefined); assert.equal(privateJob.spawnargs, undefined); assert.equal(privateJob.env, undefined);
  const visible = queue.get(appId, job.id);
  assert.equal(visible.pid, undefined); assert.equal(visible.processReceipt, undefined); assert.equal(visible.processReceiptState, undefined);
  assert.ok(!JSON.stringify(visible).includes(privateJob.processReceipt.startHash));
  child.stdin.end(); await queue.pump(); assert.equal(queue.get(appId, job.id).status, 'succeeded');
});
