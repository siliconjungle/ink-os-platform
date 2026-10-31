import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../server/projects.mjs';
import { ProjectPublisher, PublicationGit } from '../server/project-publisher.mjs';
import { routeScope, authorizeRoute } from '../server/api-keys.mjs';

const file = (path, bytes, mode = '100644') => ({ path, base64: Buffer.from(bytes).toString('base64'), mode });
const source = repository => ({ provider: 'github', github: { owner: 'example-team', repository, visibility: 'private' } });
const token = 'test_credential_' + 'x'.repeat(30);

async function fixture(t, { missing = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-publication-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, 'remote');
  const git = new PublicationGit({ remoteFor: () => remote });
  await git.run(directory, ['init', '--bare', '--template=', remote]);
  let repository = missing ? null : { id: 42, full_name: 'example-team/palette', private: true, permissions: { push: true } };
  const calls = [];
  const fetcher = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    const path = new URL(url).pathname;
    if (path === '/user') return Response.json({ login: 'example-team' });
    if (path === '/user/repos' && init.method === 'POST') { repository = { id: 42, full_name: 'example-team/palette', private: true }; return Response.json(repository, { status: 201 }); }
    if (path === '/repos/example-team/palette') return repository ? Response.json(repository) : Response.json({}, { status: 404 });
    throw Error('Unexpected GitHub path');
  };
  const key = randomBytes(32).toString('base64');
  const publisher = new ProjectPublisher(directory, { git, fetch: fetcher });
  const projects = await new Projects(directory, { publisher, environmentKey: key }).open();
  const files = [file('main.ink', 'module palette;\r\n'), file('assets/bytes.bin', [0, 255, 10]), file('tools/render', '#!/bin/sh\n', '100755')];
  const project = await projects.snapshot({ title: 'Palette', files, settings: { source: source('palette') } });
  return { directory, remote, git, projects, project, files, key, calls, fetcher, setRepository: value => { repository = value; } };
}

test('private credentials survive restart encrypted, bind to a destination and never follow duplication', async t => {
  const { projects, project, directory, key, git, fetcher } = await fixture(t);
  assert.deepEqual(projects.credentialStatus(project.id), { configured: false });
  await projects.setCredentials(project.id, token);
  const saved = await readFile(join(directory, 'project-credentials.json'), 'utf8');
  assert.ok(!saved.includes(token));
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'project-credentials.json'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(projects.list()).includes(token));
  const copy = await projects.duplicate(project.id, { source: source('another-palette') });
  assert.equal(copy.source.github.repository, 'another-palette');
  assert.deepEqual(projects.credentialStatus(copy.id), { configured: false });
  const restarted = await new Projects(directory, { environmentKey: key, publisher: new ProjectPublisher(directory, { git, fetch: fetcher }) }).open();
  assert.equal(restarted.credentialStatus(project.id).matchesProject, true);
  await restarted.update(project.id, { source: source('another-palette') });
  assert.equal(restarted.credentialStatus(project.id).matchesProject, false);
  await assert.rejects(restarted.publish(project.id), { status: 409 });
  await restarted.removeCredentials(project.id);
  assert.deepEqual(restarted.credentialStatus(project.id), { configured: false });
  const wrongKey = await new Projects(directory, { environmentKey: randomBytes(32).toString('base64') }).open();
  await restarted.setCredentials(copy.id, token);
  await wrongKey.credentials.open();
  assert.throws(() => wrongKey.credentialStatus(copy.id), { status: 503 });
});

test('publication creates only on request and sends exact binary/executable source, with independent history and durable receipts', async t => {
  const { projects, project, remote, git, directory, key, fetcher, calls, files } = await fixture(t, { missing: true });
  await projects.setCredentials(project.id, token);
  await assert.rejects(projects.publish(project.id), { status: 404 });
  assert.equal(calls.some(call => call.method === 'POST'), false);
  const first = await projects.publish(project.id, { create: true });
  assert.equal(calls.find(call => call.method === 'POST').body.private, true);
  assert.notEqual(first.remoteCommit, first.sourceCommit);
  assert.equal(await git.run(remote, ['rev-parse', 'refs/heads/main']), first.remoteCommit);
  assert.equal(await git.run(remote, ['rev-parse', first.remoteCommit + '^{tree}']), first.tree);
  assert.equal(await git.run(remote, ['rev-list', '--count', 'refs/heads/main']), '1');
  assert.match(await git.run(remote, ['ls-tree', 'refs/heads/main', 'tools/render']), /^100755 blob /);
  const binary = await projects.gitRaw(remote, ['cat-file', 'blob', 'refs/heads/main:assets/bytes.bin'], { encoding: 'buffer' });
  assert.deepEqual(binary, Buffer.from([0, 255, 10]));
  assert.deepEqual(await projects.publish(project.id), first);
  const changed = await projects.snapshot({ files: [files[0], file('new.txt', 'new')] }, project.id);
  const second = await projects.publish(project.id);
  assert.equal(second.parent, first.remoteCommit);
  assert.equal(second.sourceCommit, changed.commit);
  assert.equal(await git.run(remote, ['rev-list', '--count', 'refs/heads/main']), '2');
  assert.equal(await git.run(remote, ['ls-tree', '--name-only', 'refs/heads/main']), 'main.ink\nnew.txt');
  const restarted = await new Projects(directory, { environmentKey: key, publisher: new ProjectPublisher(directory, { git, fetch: fetcher }) }).open();
  assert.deepEqual(await restarted.publish(project.id), second);
  assert.deepEqual(restarted.publication(project.id).publication, second);
  assert.ok(!(await readFile(join(directory, 'project-publications.json'), 'utf8')).includes(token));
});

test('a push accepted before a lost response is reconciled on restart without a duplicate commit', async t => {
  const { projects, project, remote, git, directory, key, fetcher } = await fixture(t);
  await projects.setCredentials(project.id, token);
  const run = git.run.bind(git);
  let lost = false;
  git.run = async (directory, args, options) => {
    const result = await run(directory, args, options);
    if (args[0] === 'push' && !lost) { lost = true; throw Object.assign(Error('Response lost'), { status: 502 }); }
    return result;
  };
  await assert.rejects(projects.publish(project.id), { status: 502 });
  const pending = projects.publication(project.id).pending;
  assert.equal(pending.remoteCommit, await run(remote, ['rev-parse', 'refs/heads/main']));
  const restarted = await new Projects(directory, { environmentKey: key, publisher: new ProjectPublisher(directory, { git, fetch: fetcher }) }).open();
  const recovered = await restarted.publish(project.id);
  assert.equal(recovered.remoteCommit, pending.remoteCommit);
  assert.equal(restarted.publication(project.id).pending, null);
  assert.equal(await run(remote, ['rev-list', '--count', 'refs/heads/main']), '1');
});

test('remote edits, deletion, visibility mismatch, replacement repositories and push races never get overwritten', async t => {
  const { projects, project, remote, git, files, setRepository } = await fixture(t);
  await projects.setCredentials(project.id, token);
  const first = await projects.publish(project.id);
  await projects.snapshot({ files: [...files, file('new.txt', 'new')] }, project.id);
  const run = git.run.bind(git);
  const unrelated = await run(remote, ['commit-tree', first.tree, '-p', first.remoteCommit, '-m', 'Remote user edit'], { env: { GIT_AUTHOR_NAME: 'User', GIT_AUTHOR_EMAIL: 'user@example.invalid', GIT_COMMITTER_NAME: 'User', GIT_COMMITTER_EMAIL: 'user@example.invalid' } });
  let raced = false;
  git.run = async (directory, args, options) => {
    if (args[0] === 'push' && !raced) { raced = true; await run(remote, ['update-ref', 'refs/heads/main', unrelated, first.remoteCommit]); }
    return run(directory, args, options);
  };
  await assert.rejects(projects.publish(project.id), { status: 502 });
  assert.equal(await run(remote, ['rev-parse', 'refs/heads/main']), unrelated);
  await assert.rejects(projects.publish(project.id), { status: 409 });
  await assert.rejects(projects.publish(project.id, { expectedRemote: first.remoteCommit }), { status: 409 });
  const reconciled = await projects.publish(project.id, { expectedRemote: unrelated });
  assert.equal(reconciled.parent, unrelated);
  assert.equal(await run(remote, ['rev-parse', 'refs/heads/main^']), unrelated);
  await run(remote, ['update-ref', '-d', 'refs/heads/main']);
  await assert.rejects(projects.publish(project.id), { status: 409 });
  setRepository({ id: 42, full_name: 'example-team/palette', private: false });
  await assert.rejects(projects.publish(project.id), { status: 409 });
  setRepository({ id: 43, full_name: 'example-team/palette', private: true });
  await assert.rejects(projects.publish(project.id), { status: 409 });
});

test('credential access requires its own scope and committed credentials are rejected before network publication', async t => {
  assert.equal(routeScope('/projects/' + 'a'.repeat(32) + '/credentials', 'GET'), 'apps:credentials');
  assert.throws(() => authorizeRoute({ keyId: 'key', scopes: ['computer', 'apps:deploy', 'apps:read'] }, '/projects/' + 'a'.repeat(32) + '/credentials', 'PUT'), { status: 403 });
  const { projects, project, calls } = await fixture(t);
  await projects.setCredentials(project.id, token);
  await projects.snapshot({ files: [file('main.ink', '// ' + token)] }, project.id);
  await assert.rejects(projects.publish(project.id), { status: 400 });
  assert.equal(calls.length, 0);
});

test('organization creation uses explicit project visibility and rejects personal-owner mismatches', async () => {
  for (const visibility of ['private', 'public']) {
    const calls = [];
    let created = false;
    const publisher = new ProjectPublisher('unused', { fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === '/repos/example-team/palette') return created ? Response.json({ id: 42, full_name: 'example-team/palette', private: visibility === 'private' }) : Response.json({}, { status: 404 });
      if (path === '/user') return Response.json({ login: 'individual' });
      if (path === '/users/example-team') return Response.json({ type: 'Organization' });
      assert.equal(path, '/orgs/example-team/repos');
      assert.deepEqual(JSON.parse(init.body), { name: 'palette', private: visibility === 'private', auto_init: false });
      created = true;
      return Response.json({}, { status: 201 });
    } });
    const project = { source: { ...source('palette'), github: { ...source('palette').github, visibility } } };
    assert.equal((await publisher.repository(project, token, true)).private, visibility === 'private');
    assert.ok(calls.includes('/orgs/example-team/repos'));
  }
  const publisher = new ProjectPublisher('unused', { fetch: async url => {
    const path = new URL(url).pathname;
    if (path.startsWith('/repos/')) return Response.json({}, { status: 404 });
    if (path === '/user') return Response.json({ login: 'individual' });
    return Response.json({ type: 'User' });
  } });
  await assert.rejects(publisher.repository({ source: source('palette') }, token, true), { status: 409 });
});
