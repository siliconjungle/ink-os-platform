import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeInstance } from '../server/instance.mjs';
import { World } from '../server/world.mjs';
import { randomBytes } from 'node:crypto';

test('first boot is empty and credentials persist across restarts without entering the world', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-instance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await initializeInstance({ directory, port: 5001 });
  const second = await initializeInstance({ directory, port: 5002 });
  assert.equal(first.id, second.id);
  assert.equal(first.adminToken, second.adminToken);
  assert.equal(first.environmentKey, second.environmentKey);
  assert.equal((await stat(join(directory, 'instance.json'))).mode & 0o777, 0o600);
  const world = await new World(directory).open();
  assert.deepEqual(world.all(), []);
  await world.persist();
  assert.ok(!(await readFile(join(directory, 'world.json'), 'utf8')).includes(first.adminToken));
  assert.equal(JSON.parse(await readFile(second.clientPath)).url, 'http://127.0.0.1:5002');
});

test('declared cloud identity and keys persist exactly and mismatched configuration never rewrites them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-declared-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const declaration = { directory, id: randomBytes(16).toString('hex'), adminToken: randomBytes(32).toString('base64url'), environmentKey: randomBytes(32).toString('base64') };
  const first = await initializeInstance(declaration);
  const identity = await readFile(join(directory, 'instance.json'), 'utf8');
  assert.equal(first.id, declaration.id);
  assert.equal(first.adminToken, declaration.adminToken);
  assert.equal(first.environmentKey, declaration.environmentKey);
  assert.equal(JSON.parse(await readFile(first.clientPath)).token, declaration.adminToken);
  for (const changed of [{ id: 'f'.repeat(32) }, { adminToken: 'other'.repeat(10) }, { environmentKey: randomBytes(32).toString('base64') }]) {
    await assert.rejects(initializeInstance({ ...declaration, ...changed }), /differ from persisted/);
    assert.equal(await readFile(join(directory, 'instance.json'), 'utf8'), identity);
  }
  await assert.rejects(initializeInstance({ directory, id: 'invalid' }), /Declared instance/);
});
