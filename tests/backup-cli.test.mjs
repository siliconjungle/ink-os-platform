import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { initializeInstance } from '../server/instance.mjs';
import { createStoppedBackup } from '../sdk/src/backup.js';

test('main CLI and local SDK back up and recover without server login or a readable connection config', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ink-backup-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = join(directory, 'original'), restored = join(directory, 'restored'), archive = join(directory, 'archive.inkbak');
  const instance = await initializeInstance({ directory: original });
  await writeFile(join(original, 'opaque.bin'), Buffer.from([0, 255, 10]));
  const badConfig = join(directory, 'bad-config.json'); await writeFile(badConfig, 'invalid');
  const password = randomBytes(32).toString('hex');
  async function cli(args) {
    const child = spawn(process.execPath, ['cli/bin/ink-os.mjs', 'backup', ...args, '--password-stdin'], { env: { ...process.env, INK_OS_CONFIG: badConfig }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.stdin.end(password + '\n');
    const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
    assert.ok(!stdout.includes(password)); return JSON.parse(stdout);
  }
  const saved = await cli(['create', '--offline', '--directory', original, '--output', archive]);
  assert.equal(saved.consistency, 'offline');
  const recovered = await cli(['restore', '--offline', '--directory', restored, '--input', archive]);
  assert.equal(recovered.format, 'ink-os-private-backup-v1');
  assert.equal(JSON.parse(await readFile(join(restored, 'instance.json'))).id, instance.id);
  assert.deepEqual(await readFile(join(restored, 'opaque.bin')), Buffer.from([0, 255, 10]));
  await createStoppedBackup({ directory: restored, archive: join(directory, 'sdk.inkbak'), password, offline: true });
});
