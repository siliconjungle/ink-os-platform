import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClient } from '../sdk/src/server.js';
import { PublicationGit } from '../server/project-publisher.mjs';

const owner = process.env.INK_OS_VERIFY_GITHUB_OWNER;
const repository = process.env.INK_OS_VERIFY_GITHUB_REPOSITORY;
const token = process.env.INK_OS_VERIFY_GITHUB_TOKEN;
const branch = process.env.INK_OS_VERIFY_GITHUB_BRANCH || 'main';
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner || '') || !/^ink-os-proof-[a-z0-9-]+$/.test(repository || '') || !token) throw Error('Provide explicit INK_OS_VERIFY_GITHUB_OWNER, INK_OS_VERIFY_GITHUB_REPOSITORY (new ink-os-proof-* name), and INK_OS_VERIFY_GITHUB_TOKEN. This check creates and retains a private proof repository.');
if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,100}$/.test(branch) || branch.split('/').some(part => !part)) throw Error('Use a valid proof branch.');
const directory = await mkdtemp(join(tmpdir(), 'ink-github-proof-'));
const data = join(directory, 'data');
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|INK_OS_GIT_ROOT)$/.test(name)));
Object.assign(env, { PORT: String(port), INK_OS_DEFAULT_APPS:'0',INK_OS_DATA_DIR: data, INK_OS_CONFIG: join(data, 'client.json'), NODE_ENV: 'production', INK_OS_NATIVE: '0' });
const url = 'http://127.0.0.1:' + port;
let child, output = '';
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
}
async function start() {
  output = ''; child = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Proof host failed to start.');
    try { if ((await fetch(url + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Proof host did not become ready.');
}
async function cli(args, stdin) {
  const process = spawn(globalThis.process.execPath, ['cli/bin/ink-os.mjs', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', bytes => stdout += bytes); process.stderr.on('data', bytes => stderr += bytes);
  process.stdin.end(stdin);
  const [code] = await once(process, 'exit');
  if (code !== 0) throw Error(stderr.replaceAll(token, '[redacted]'));
  return JSON.parse(stdout);
}
const source = [{ path: 'main.ink', base64: Buffer.from('module source; fn answer()->u32{return 42;}\n').toString('base64') }, { path: 'assets/bytes.bin', base64: Buffer.from([0, 255, 10]).toString('base64') }, { path: 'tools/render', base64: Buffer.from('#!/bin/sh\n').toString('base64'), mode: '100755' }];
try {
  await start();
  const config = JSON.parse(await readFile(env.INK_OS_CONFIG, 'utf8')), sdk = createClient({ url, token: config.token });
  assert.deepEqual(await sdk.apps.list(), []);
  const settings = join(directory, 'settings.json');
  await writeFile(settings, JSON.stringify({ branch, source: { provider: 'github', github: { owner, repository, visibility: 'private' } } }));
  const project = await cli(['projects', 'create', '--title', 'GitHub source proof', '--file', settings]);
  await sdk.projects.snapshot(project.id, { files: source });
  const credentials = await cli(['projects', 'credentials', project.id, '--stdin'], token + '\n');
  assert.equal(credentials.matchesProject, true);
  const first = await cli(['projects', 'publish', project.id, '--create']);
  assert.equal(first.repository, 'https://github.com/' + owner.toLowerCase() + '/' + repository);
  assert.equal(first.parent, null);
  await stop(); await start();
  assert.deepEqual(await sdk.projects.publish(project.id), first);
  const changed = source.map(file => file.path === 'main.ink' ? { ...file, base64: Buffer.from('module source; fn answer()->u32{return 43;}\n').toString('base64') } : file);
  await sdk.projects.snapshot(project.id, { files: changed });
  const second = await sdk.projects.publish(project.id);
  assert.equal(second.parent, first.remoteCommit);
  const inspect = join(directory, 'inspect'), git = new PublicationGit();
  await git.run(directory, ['init', '--bare', '--template=', inspect]);
  await git.run(inspect, ['fetch', '--no-tags', 'https://github.com/' + owner + '/' + repository + '.git', 'refs/heads/' + branch], { token });
  assert.equal(await git.run(inspect, ['rev-parse', 'FETCH_HEAD^{tree}']), second.tree);
  assert.equal(await git.run(inspect, ['rev-list', '--count', 'FETCH_HEAD']), '2');
  assert.match(await git.run(inspect, ['ls-tree', 'FETCH_HEAD', 'tools/render']), /^100755 blob /);
  const bytes = await git.run(inspect, ['show', 'FETCH_HEAD:assets/bytes.bin'], { encoding: 'buffer' });
  assert.deepEqual(bytes, Buffer.from([0, 255, 10]));
  const copy = await sdk.projects.duplicate(project.id);
  assert.equal(copy.source.provider, 'local');
  assert.equal((await sdk.projects.credentials.status(copy.id)).configured, false);
  const reconciledFiles = [...changed, { path: 'remote-note.txt', base64: Buffer.from('Remote user work\n').toString('base64') }].map(file => ({ ...file, mode: file.mode || '100644' }));
  const remoteTree = await git.tree(inspect, reconciledFiles);
  const conflict = await git.run(inspect, ['commit-tree', remoteTree, '-p', second.remoteCommit, '-m', 'Remote edit conflict proof'], { env: { GIT_AUTHOR_NAME: 'Ink OS', GIT_AUTHOR_EMAIL: 'ink-os@localhost', GIT_COMMITTER_NAME: 'Ink OS', GIT_COMMITTER_EMAIL: 'ink-os@localhost' } });
  await git.run(inspect, ['push', '--force-with-lease=refs/heads/' + branch + ':' + second.remoteCommit, 'https://github.com/' + owner + '/' + repository + '.git', conflict + ':refs/heads/' + branch], { token });
  await assert.rejects(sdk.projects.publish(project.id), { status: 409 });
  assert.equal(await git.head(inspect, owner + '/' + repository, branch, token), conflict);
  await sdk.projects.snapshot(project.id, { files: reconciledFiles });
  const reconciliation = await cli(['projects', 'publish', project.id, '--expected-remote', conflict]);
  assert.equal(reconciliation.parent, conflict);
  assert.equal(reconciliation.tree, remoteTree);
  assert.equal(await git.head(inspect, owner + '/' + repository, branch, token), reconciliation.remoteCommit);
  assert.deepEqual(await sdk.apps.list(), []);
  const cipher = await readFile(join(data, 'project-credentials.json'), 'utf8');
  assert.ok(!cipher.includes(token));
  await sdk.projects.credentials.remove(project.id);
  assert.equal((await sdk.projects.credentials.status(project.id)).configured, false);
  const proof = { format: 'ink-os-github-publication-proof-v1', repository: first.repository, repositoryId: first.repositoryId, visibility: 'private', branch, first, second, conflictCommit: conflict, reconciliation, observed: ['Fresh host contained zero apps before and after source operations.', 'CLI stored a private project token and explicitly published a private GitHub branch.', 'Restart preserved credentials and returned the same publication receipt without another commit.', 'SDK published the next committed snapshot with exact tree identity and executable mode.', 'Fresh remote fetch found exact binary bytes, the expected tree and exactly two publication commits before the conflict check.', 'Source duplication defaulted to independent local Git without credentials.', 'A real remote file addition caused HTTP 409 and remained the branch head.', 'After importing the remote file, CLI publication acknowledged its exact base and preserved both the file tree and remote history.', 'Credential ciphertext omitted the token and explicit removal succeeded.'], limits: ['Single GitHub personal-owner/private-repository roundtrip; organization/public creation has not been validated against GitHub.', 'Lost-response recovery and concurrent push races use real local Git remotes in automated tests.', 'Automatic fetching/merging of external GitHub changes is not implemented.'] };
  const outputPath = resolve(process.env.INK_OS_VERIFY_GITHUB_OUTPUT || 'evidence/github-project.json');
  await writeFile(outputPath, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ proof: outputPath, repository: first.repository, verified: true }));
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
