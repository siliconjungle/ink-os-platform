import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient } from '../sdk/src/server.js';

const owner = process.env.INK_OS_VERIFY_GITHUB_OWNER, repository = process.env.INK_OS_VERIFY_GITHUB_REPOSITORY, token = process.env.INK_OS_VERIFY_GITHUB_TOKEN;
const branch = process.env.INK_OS_VERIFY_GITHUB_BRANCH || 'main';
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner || '') || !/^ink-os-proof-[a-z0-9-]+$/.test(repository || '') || !token) throw Error('Provide explicit verification owner, existing private ink-os-proof-* repository and token. This check only reads GitHub.');
const directory = await mkdtemp(join(tmpdir(), 'ink-source-read-proof-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|INK_OS_GIT_ROOT)$/.test(name)));
Object.assign(env, { PORT: String(port), INK_OS_DATA_DIR: directory, INK_OS_CONFIG: join(directory, 'client.json'), INK_OS_NATIVE: '0' });
const url = 'http://127.0.0.1:' + port;
let child, output = '';
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
async function start() {
  output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Disposable source host failed to start.');
    try { const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Disposable source host startup timed out.');
}
async function cli(args) {
  const child = spawn(process.execPath, ['cli/bin/ink-os.mjs', 'projects', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const [code] = await once(child, 'exit'); if (code) throw Error(stderr.replaceAll(token, '[redacted]')); return JSON.parse(stdout);
}
try {
  await start();
  const connection = JSON.parse(await readFile(env.INK_OS_CONFIG)), sdk = createClient({ url, token: connection.token });
  assert.deepEqual(await sdk.apps.list(), []);
  const project = await sdk.projects.create({ title: 'Private source read proof', branch, source: { provider: 'github', github: { owner, repository, visibility: 'private' } } });
  await sdk.projects.credentials.set(project.id, token);
  const remote = await sdk.projects.readRemote(project.id), plan = await sdk.projects.sourcePlan(project.id);
  assert.equal(plan.canPull, true); assert.equal(plan.snapshot, undefined); assert.equal(plan.files, undefined);
  const imported = await cli(['pull', project.id, '--expected-remote', remote.originCommit]);
  assert.equal(imported.sourceImport.remoteCommit, remote.originCommit);
  assert.notEqual(imported.sourceImport.sourceCommit, remote.originCommit);
  assert.deepEqual(await sdk.projects.files(project.id), remote.files);
  assert.equal(remote.files.find(file => file.path === 'tools/render').mode, '100755');
  assert.deepEqual(Buffer.from(remote.files.find(file => file.path === 'assets/bytes.bin').base64, 'base64'), Buffer.from([0, 255, 10]));
  await stop(); await start();
  assert.equal((await sdk.projects.sourcePlan(project.id)).action, 'none');
  assert.equal((await sdk.projects.pull(project.id)).action, 'none');
  const sourceFile = join(imported.project.directory, 'main.ink'), original = await readFile(sourceFile);
  await writeFile(sourceFile, Buffer.concat([original, Buffer.from('// Uncommitted local work\n')]));
  assert.equal((await sdk.projects.sourcePlan(project.id)).canPull, false);
  await assert.rejects(sdk.projects.pull(project.id), { status: 409 });
  assert.ok((await readFile(sourceFile, 'utf8')).includes('Uncommitted local work'));
  assert.deepEqual(await sdk.apps.list(), []);
  await sdk.projects.credentials.remove(project.id);
  const proof = { format: 'ink-os-github-source-proof-v1', repository: remote.provenance.repository, repositoryId: remote.provenance.repositoryId, branch, remoteCommit: remote.originCommit, tree: remote.tree, fileCount: remote.files.length, binarySha256: createHash('sha256').update(Buffer.from(remote.files.find(file => file.path === 'assets/bytes.bin').base64, 'base64')).digest('hex'), observed: ['Fresh host contained zero apps before and after source operations.', 'Owner SDK read the private GitHub snapshot with explicit encrypted project credentials.', 'CLI imported the exact verified tree including binary bytes and executable mode.', 'Local and remote commit identities remained distinct.', 'Host restart preserved source provenance and repeated pull was a no-op.', 'Uncommitted local edits caused a conflict and remained intact.', 'GitHub was read only; project credential removal succeeded.'], limits: ['Single private repository read/import; remote mutation/reconciliation publication is covered by the separate publication proof.', 'Live service backup/restore and cloud setup are separate acceptance gates.'] };
  await writeFile('evidence/github-source.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ verified: true, repository: proof.repository, remoteCommit: proof.remoteCommit }));
} finally { await stop(); await rm(directory, { recursive: true, force: true }); }
