import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { APIKeys } from '../server/api-keys.mjs';
import { createClient } from '../sdk/src/server.js';

const preservedId = 'abcdef0123456789abcdef01';
const scopes = ['world:read', 'apps:read', 'keys:manage'];

test('explicit member identity creates no key and rejects invalid inputs without changing durable state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-account-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = await new APIKeys(directory).open();
  const result = await keys.createAccount({ id: preservedId, name: 'Preserved member', scopes, issueKey: false });
  assert.deepEqual(Object.keys(result), ['account']);
  assert.equal(result.account.id, preservedId);
  assert.equal(result.account.name, 'Preserved member');
  assert.equal(result.account.role, 'member');
  assert.deepEqual(result.account.scopes, scopes);
  assert.deepEqual(keys.keys, []);
  assert.equal(keys.authenticate('ink_os_' + preservedId), null);
  const path = join(directory, 'account-keys.json'), before = await readFile(path, 'utf8');
  const invalid = [null, [], 'member',
    ...['owner', 'admin', '', 'A'.repeat(24), 'a'.repeat(23), 'a'.repeat(25), 'g'.repeat(24), 123, null].map(id => ({ id })),
    ...['false', 0, 1, null, {}].map(issueKey => ({ issueKey })),
    { scopes: ['accounts:manage'] }, { scopes: ['world:read', 'accounts:manage'] },
    { name: '' }, { expiresInDays: 0 },
  ];
  for (const input of invalid) {
    const request = input && typeof input === 'object' && !Array.isArray(input) ? { name: 'Rejected', scopes, ...input } : input;
    await assert.rejects(keys.createAccount(request), { status: 400 });
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(keys.listAccounts(), [keys.account('owner'), result.account]);
    assert.deepEqual(keys.keys, []);
  }
  await keys.updateAccount(preservedId, { disabled: true });
  const disabled = await readFile(path, 'utf8');
  await assert.rejects(keys.createAccount({ id: preservedId, name: 'Replacement', issueKey: false }), { status: 409 });
  assert.equal(await readFile(path, 'utf8'), disabled);
  const reopened = await new APIKeys(directory).open();
  assert.deepEqual(reopened.account(preservedId), keys.account(preservedId));
  assert.deepEqual(reopened.keys, []);
});

test('concurrent explicit-ID creation has one winner; defaults still issue a usable member key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-account-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = await new APIKeys(directory).open();
  const outcomes = await Promise.allSettled(['First member', 'Second member'].map(name => keys.createAccount({ id: preservedId, name, scopes, issueKey: false })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
  assert.equal(keys.listAccounts().length, 2);
  assert.equal(keys.keys.length, 0);
  const generated = await keys.createAccount({ name: 'Default member' });
  assert.match(generated.account.id, /^[a-f0-9]{24}$/);
  assert.match(generated.key.token, /^ink_os_/);
  assert.equal(generated.key.accountId, generated.account.id);
  assert.equal(keys.authenticate(generated.key.token).accountId, generated.account.id);
  assert.equal(keys.authenticate(generated.key.token).admin, false);
  assert.equal(generated.account.scopes.includes('accounts:manage'), false);
  const explicit = await keys.createAccount({ id: '1234567890abcdef12345678', name: 'Explicit key', scopes, issueKey: true, role: 'admin' });
  assert.equal(explicit.account.role, 'member');
  assert.equal(keys.authenticate(explicit.key.token).admin, false);
  const reopened = await new APIKeys(directory).open();
  assert.equal(reopened.authenticate(generated.key.token).accountId, generated.account.id);
  assert.equal(reopened.authenticate(explicit.key.token).accountId, explicit.account.id);
});

test('actual owner API preserves a keyless identity over restart and retains account-management authorization', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-account-api-')), data = join(directory, 'data');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
  Object.assign(env, { PORT: String(port), INK_OS_DEFAULT_APPS: '0', INK_OS_DATA_DIR: data, INK_OS_CONFIG: join(data, 'client.json'), NODE_ENV: 'production', INK_OS_NATIVE: '0' });
  const url = 'http://127.0.0.1:' + port;
  let child, output = '';
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(output);
      try { if ((await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(output || 'Server did not become healthy');
  };
  await start();
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG, 'utf8')), sdk = createClient({ url, token: config.token });
  const create = body => sdk.request('accounts', { method: 'POST', body });
  const result = await create({ id: preservedId, name: 'Preserved member', scopes, issueKey: false });
  assert.deepEqual(Object.keys(result), ['account']);
  assert.deepEqual(await sdk.request('keys?account=' + preservedId), []);
  assert.deepEqual(await sdk.account.keys.list(), []);
  const path = join(data, 'account-keys.json'), before = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(before).keys, []);
  for (const [body, status] of [
    [{ id: preservedId, name: 'Collision', issueKey: false }, 409],
    [{ id: 'owner', name: 'Owner', issueKey: false }, 400],
    [{ id: 'A'.repeat(24), name: 'Invalid', issueKey: false }, 400],
    [{ name: 'Invalid flag', issueKey: 'false' }, 400],
    [{ name: 'Admin permission', scopes: ['accounts:manage'], issueKey: false }, 400],
  ]) {
    await assert.rejects(create(body), { status });
    assert.equal(await readFile(path, 'utf8'), before);
  }
  await stop(); await start();
  assert.deepEqual((await sdk.request('accounts')).find(account => account.id === preservedId), result.account);
  assert.deepEqual(await sdk.request('keys?account=' + preservedId), []);
  assert.equal(await readFile(path, 'utf8'), before);
  const anonymous = await fetch(url + '/api/v1/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Anonymous' }) });
  assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
  const keyless = createClient({ url, token: 'ink_os_' + preservedId });
  await assert.rejects(keyless.account.me(), { status: 401 });
  const normal = await create({ name: 'Default HTTP member' });
  assert.match(normal.key.token, /^ink_os_/);
  const member = createClient({ url, token: normal.key.token });
  assert.equal((await member.account.me()).accountId, normal.account.id);
  const beforeDenied = await readFile(path, 'utf8');
  await assert.rejects(member.request('accounts', { method: 'POST', body: { id: '1'.repeat(24), name: 'Forbidden', issueKey: false } }), { status: 403 });
  assert.equal(await readFile(path, 'utf8'), beforeDenied);
  const limited = await sdk.account.keys.create({ name: 'Read only owner', scopes: ['apps:read'] });
  const limitedSDK = createClient({ url, token: limited.token }), beforeLimited = await readFile(path, 'utf8');
  await assert.rejects(limitedSDK.request('accounts', { method: 'POST', body: { name: 'Forbidden', issueKey: false } }), { status: 403 });
  assert.equal(await readFile(path, 'utf8'), beforeLimited);
  // Ordinary explicit key issuance remains separate from identity provisioning.
  const issued = await sdk.request('keys?account=' + preservedId, { method: 'POST', body: { name: 'Later sign-in', scopes } });
  const preserved = createClient({ url, token: issued.token });
  assert.equal((await preserved.account.me()).accountId, preservedId);
  await stop(); await start();
  assert.equal((await preserved.account.me()).accountId, preservedId);
  assert.equal((await member.account.me()).accountId, normal.account.id);
});
