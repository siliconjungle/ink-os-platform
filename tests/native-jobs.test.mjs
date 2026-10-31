import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeJobs } from '../server/native-jobs.mjs';

test('queue recovery waits for a confirmed live compiler process before marking an unpublished build interrupted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-native-recovery-'));
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("data",()=>process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'] });
  await once(child, 'spawn');
  let queue, builds = 0;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.stdin.end('finish'); await once(child, 'exit'); }
    await queue?.close(); await rm(directory, { recursive: true, force: true });
  });
  const appId = 'a'.repeat(32), releaseId = 'b'.repeat(32), compatibilityKey = 'c'.repeat(64), artifactId = 'd'.repeat(64);
  const first = { id: '1'.repeat(32), appId, releaseId, compatibilityKey, artifactId, sourceIdentity: 'e'.repeat(64), status: 'running', pid: child.pid };
  const second = { ...first, id: '2'.repeat(32), status: 'queued', pid: null };
  await writeFile(join(directory, 'native-jobs.json'), JSON.stringify({ version: 1, jobs: [first, second] }));
  const native = {
    record: async () => { throw Object.assign(Error('Artifact not published.'), { code: 'ENOENT' }); },
    compatibility: async () => ({ compatibilityKey }),
    build: async () => { builds++; return { id: artifactId, sourceIdentity: 'e'.repeat(64), cached: false }; },
  };
  queue = await new NativeJobs(directory, { native, source: async () => 'source' }).open();
  await queue.pump();
  assert.equal(queue.get(appId, first.id).status, 'recovering');
  assert.equal(queue.get(appId, second.id).status, 'queued');
  assert.equal(builds, 0);
  child.stdin.end('finish'); await once(child, 'exit');
  await queue.pump();
  assert.equal(queue.get(appId, first.id).status, 'interrupted');
  assert.equal(queue.get(appId, second.id).status, 'succeeded');
  assert.equal(builds, 1);
});
