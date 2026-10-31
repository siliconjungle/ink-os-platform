import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../server/projects.mjs';
import { ProjectSourceSync } from '../server/project-source-sync.mjs';
import { ProjectPublisher, PublicationGit } from '../server/project-publisher.mjs';
import { projectRoute } from '../server/project-router.mjs';
import { createProjects } from '../sdk/src/projects.js';
import { projectCLI } from '../cli/bin/projects.mjs';

const token = 'explicit_project_pull_' + 't'.repeat(30);
const source = { provider: 'github', github: { owner: 'example-team', repository: 'palette', visibility: 'private' } };
const file = (path, bytes, mode = '100644') => ({ path, mode, base64: Buffer.from(bytes).toString('base64') });
const initialFiles = [file('.gitattributes', '* text eol=lf\n'), file('main.ink', 'module palette;\r\n'), file('assets/bytes.bin', [0, 255, 13, 10]), file('tools/run', '#!/bin/sh\n', '100755')];

async function fixture(t, { empty = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-project-pull-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, 'remote.git'), git = new PublicationGit({ remoteFor: () => remote });
  await git.run(directory, ['init', '--bare', '--template=', remote]);
  const state = { repositoryId: 42, fetches: [], onRead: null };
  const author = { GIT_AUTHOR_NAME: 'Remote source', GIT_AUTHOR_EMAIL: 'source@example.invalid', GIT_COMMITTER_NAME: 'Remote source', GIT_COMMITTER_EMAIL: 'source@example.invalid' };
  const head = () => git.run(remote, ['rev-parse', '--verify', 'refs/heads/main']).catch(() => null);
  async function advance(files, { parent, message = 'Remote source change' } = {}) {
    const previous = await head(), tree = await git.tree(remote, files), base = parent === undefined ? previous : parent;
    const commit = await git.run(remote, ['commit-tree', tree, ...(base ? ['-p', base] : []), '-m', message], { env: author });
    await git.run(remote, ['update-ref', 'refs/heads/main', commit]);
    return { commit, tree };
  }
  if (!empty) await advance(initialFiles);
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    const path = new URL(url).pathname; state.fetches.push(path);
    if (state.onRead) await state.onRead(path);
    if (path === '/repos/example-team/palette') return Response.json({ id: state.repositoryId, full_name: 'example-team/palette', private: true, permissions: { push: true } });
    const prefix = '/repos/example-team/palette';
    if (path === prefix + '/git/ref/heads/main') return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: await head() } });
    if (path.startsWith(prefix + '/git/commits/')) {
      const sha = path.split('/').at(-1), tree = await git.run(remote, ['rev-parse', sha + '^{tree}']), parents = (await git.run(remote, ['show', '-s', '--format=%P', sha])).split(' ').filter(Boolean);
      return Response.json({ sha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })) });
    }
    if (path.startsWith(prefix + '/git/trees/')) {
      const sha = path.split('/').at(-1), listing = (await git.run(remote, ['ls-tree', '-rtzl', sha])).split('\0').filter(Boolean);
      return Response.json({ sha, truncated: false, tree: listing.map(item => {
        const tab = item.indexOf('\t'), [mode, type, sha, size] = item.slice(0, tab).trim().split(/\s+/);
        return { path: item.slice(tab + 1), mode, type, sha, ...(type === 'blob' ? { size: Number(size) } : {}) };
      }) });
    }
    if (path.startsWith(prefix + '/git/blobs/')) {
      const sha = path.split('/').at(-1), bytes = await git.run(remote, ['cat-file', 'blob', sha], { encoding: 'buffer' });
      return Response.json({ sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
    }
    if (path.startsWith(prefix + '/compare/')) {
      const [base, current] = path.split('/').at(-1).split('...');
      const merge = await git.run(remote, ['merge-base', base, current]).catch(() => null);
      if (!merge) return Response.json({}, { status: 404 });
      const [behind, ahead] = (await git.run(remote, ['rev-list', '--left-right', '--count', `${base}...${current}`])).split(/\s+/).map(Number);
      return Response.json({ base_commit: { sha: base }, merge_base_commit: { sha: merge }, status: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical', ahead_by: ahead, behind_by: behind, commits: [{ sha: current }] });
    }
    throw Error('Unexpected source fixture URL');
  };
  const key = randomBytes(32).toString('base64'), reader = new ProjectSourceSync({ fetch: fetcher });
  const publisher = new ProjectPublisher(directory, { git, fetch: fetcher });
  const projects = await new Projects(directory, { publisher, sourceSync: reader, environmentKey: key }).open();
  const project = await projects.create({ title: 'Pulled source', source });
  await projects.setCredentials(project.id, token);
  return { directory, remote, git, state, advance, head, projects, project, key, fetcher, reader };
}

test('initial managed pull preserves exact tree, bytes/modes and independent identities with protected durable receipt', async t => {
  const f = await fixture(t), { projects, project } = f;
  const snapshot = await projects.readRemote(project.id), plan = await projects.sourcePlan(project.id);
  assert.equal(plan.action, 'import'); assert.equal(plan.canPull, true);
  assert.ok(!JSON.stringify(plan).includes('base64')); assert.equal(plan.snapshot, undefined); assert.equal(plan.files, undefined);
  assert.equal((await projects.status(project.id)).commit, null);
  const pulled = await projects.pull(project.id, { expectedRemote: snapshot.originCommit });
  assert.equal(pulled.sourceImport.remoteCommit, snapshot.originCommit); assert.notEqual(pulled.sourceImport.sourceCommit, snapshot.originCommit);
  assert.equal(pulled.sourceImport.tree, snapshot.tree); assert.equal(pulled.sourceImport.repositoryId, 42);
  assert.equal(pulled.sourceImport.branch, 'main'); assert.equal(pulled.sourceImport.verified, true);
  assert.deepEqual(await projects.files(project.id), snapshot.files);
  assert.deepEqual(await readFile(join(project.directory, 'assets/bytes.bin')), Buffer.from([0, 255, 13, 10]));
  assert.equal(await readFile(join(project.directory, 'main.ink'), 'utf8'), 'module palette;\r\n');
  assert.match(await projects.git(project.directory, ['ls-tree', 'HEAD', 'tools/run']), /^100755 /);
  if (process.platform !== 'win32') assert.ok((await stat(join(project.directory, 'tools/run'))).mode & 0o111);
  await projects.update(project.id, { sourceImport: { remoteCommit: '0'.repeat(40) }, originCommit: '0'.repeat(40) });
  assert.deepEqual(projects.get(project.id).sourceImport, pulled.sourceImport);
  const restarted = await new Projects(f.directory, { environmentKey: f.key, publisher: new ProjectPublisher(f.directory, { git: f.git, fetch: f.fetcher }), sourceSync: f.reader }).open();
  assert.deepEqual(restarted.get(project.id).sourceImport, pulled.sourceImport);
  assert.equal((await restarted.sourcePlan(project.id)).action, 'none');
  assert.ok(!(await readFile(join(f.directory, 'projects.json'), 'utf8')).includes(token));
});

test('later pull requires verified baseline plus remote ancestry, and chooses later publication over import', async t => {
  const f = await fixture(t), { projects, project } = f;
  const first = await projects.pull(project.id), changed = [...initialFiles, file('next.txt', 'remote next\r\n')];
  const remote = await f.advance(changed);
  const plan = await projects.sourcePlan(project.id);
  assert.equal(plan.identity.base.sourceCommit, first.sourceImport.sourceCommit); assert.equal(plan.identity.ancestry.status, 'ahead');
  const second = await projects.pull(project.id);
  assert.equal(second.sourceImport.remoteCommit, remote.commit); assert.equal(second.sourceImport.baseRemoteCommit, first.sourceImport.remoteCommit);
  assert.equal(await projects.git(project.directory, ['rev-parse', 'HEAD^']), first.sourceImport.sourceCommit);
  const published = await projects.publish(project.id);
  assert.equal(published.parent, remote.commit); assert.equal(projects.sourceBaseline(projects.get(project.id)).remoteCommit, published.remoteCommit);
  await f.advance([...changed, file('third.txt', 'remote third')]);
  const third = await projects.sourcePlan(project.id);
  assert.equal(third.identity.base.remoteCommit, published.remoteCommit); assert.equal(third.canPull, true);
  const thirdPull = await projects.pull(project.id);
  assert.equal(thirdPull.sourceImport.baseRemoteCommit, published.remoteCommit);
  assert.equal(projects.sourceBaseline(projects.get(project.id)).remoteCommit, thirdPull.sourceImport.remoteCommit);
  assert.equal((await projects.sourcePlan(project.id)).action, 'none');
  await projects.update(project.id, { branch: 'different' });
  assert.equal(projects.sourceBaseline(projects.get(project.id)), null);
  await projects.update(project.id, { branch: 'main', source: { ...source, github: { ...source.github, repository: 'different' } } });
  assert.equal(projects.sourceBaseline(projects.get(project.id)), null);
});

test('pull then local committed edit publishes from imported remote CAS and rejects unseen remote edits', async t => {
  const f = await fixture(t), { projects, project } = f;
  const first = await projects.pull(project.id);
  const edited = await projects.snapshot({ files: [...initialFiles, file('local.txt', 'local edit')] }, project.id);
  const published = await projects.publish(project.id);
  assert.equal(published.sourceCommit, edited.commit); assert.equal(published.parent, first.sourceImport.remoteCommit);
  const remote = await f.advance([...initialFiles, file('outside.txt', 'new remote edit')]);
  await projects.snapshot({ files: [...initialFiles, file('another-local.txt', 'new local edit')] }, project.id);
  await assert.rejects(projects.publish(project.id), { status: 409 });
  assert.equal(await f.head(), remote.commit);
});

test('publication baseline permits a remote advance without pretending source and remote commits are equal', async t => {
  const f = await fixture(t, { empty: true }), { projects, project } = f;
  const local = await projects.snapshot({ files: initialFiles }, project.id), publication = await projects.publish(project.id);
  assert.notEqual(local.commit, publication.remoteCommit);
  const remote = await f.advance([...initialFiles, file('remote.txt', 'after publication')]);
  const plan = await projects.sourcePlan(project.id);
  assert.equal(plan.identity.base.sourceCommit, local.commit); assert.equal(plan.identity.base.remoteCommit, publication.remoteCommit);
  assert.equal(plan.canPull, true);
  assert.equal((await projects.pull(project.id)).sourceImport.remoteCommit, remote.commit);
});

test('tracked edits, untracked files and ignored generated files prevent pull without changing them', async t => {
  const f = await fixture(t), { projects, project } = f;
  const first = await projects.pull(project.id); await f.advance([...initialFiles, file('remote.txt', 'remote next')]);
  const scenarios = [
    { path: 'main.ink', bytes: 'local tracked edits', restore: () => writeFile(join(project.directory, 'main.ink'), 'module palette;\r\n') },
    { path: 'untracked.txt', bytes: 'local untracked', restore: () => rm(join(project.directory, 'untracked.txt')) },
    { path: 'generated.out', bytes: 'ignored local bytes', prepare: () => writeFile(join(project.directory, '.git/info/exclude'), 'generated.out\n'), restore: () => rm(join(project.directory, 'generated.out')) },
  ];
  for (const scenario of scenarios) {
    await scenario.prepare?.(); await writeFile(join(project.directory, scenario.path), scenario.bytes);
    assert.ok((await projects.sourcePlan(project.id)).conflicts.includes('local-source-dirty'));
    await assert.rejects(projects.pull(project.id), { status: 409 });
    assert.equal(await readFile(join(project.directory, scenario.path), 'utf8'), scenario.bytes);
    assert.equal((await projects.status(project.id)).commit, first.sourceImport.sourceCommit);
    await scenario.restore();
  }
});

test('external, committed without baseline, locally advanced, diverged and replaced repositories are preserved', async t => {
  const f = await fixture(t), { projects, project } = f;
  const outside = join(f.directory, 'outside'); await mkdir(outside);
  const external = await projects.create({ title: 'External', directory: outside, source }); await projects.setCredentials(external.id, token);
  await assert.rejects(projects.pull(external.id), { status: 409 });
  const snapshot = await projects.snapshot({ files: initialFiles, originCommit: await f.head() }, project.id);
  assert.ok((await projects.sourcePlan(project.id)).conflicts.includes('explicit-source-baseline-required'));
  await assert.rejects(projects.pull(project.id), { status: 409 });
  assert.equal((await projects.status(project.id)).commit, snapshot.commit);
  const clean = await projects.create({ title: 'Clean managed', source }); await projects.setCredentials(clean.id, token);
  const imported = await projects.pull(clean.id);
  await projects.snapshot({ files: [...initialFiles, file('local.txt', 'advance')] }, clean.id);
  assert.ok((await projects.sourcePlan(clean.id)).conflicts.includes('local-source-history-advanced'));
  await assert.rejects(projects.pull(clean.id), { status: 409 });
  const other = await projects.create({ title: 'Diverged remote', source }); await projects.setCredentials(other.id, token); await projects.pull(other.id);
  await f.advance([...initialFiles, file('unrelated.txt', 'rewritten history')], { parent: null });
  assert.ok((await projects.sourcePlan(other.id)).conflicts.includes('remote-source-history-diverged'));
  await assert.rejects(projects.pull(other.id), { status: 409 });
  f.state.repositoryId = 43;
  await assert.rejects(projects.readRemote(other.id), { status: 409 });
  await assert.rejects(projects.publish(other.id), { status: 409 });
  assert.equal(projects.get(other.id).sourceImport.remoteCommit, imported.sourceImport.remoteCommit);
});

test('local changes during remote reads, before import and before checkout are rechecked before replacement', async t => {
  for (const phase of ['remote-read', 'before-import', 'before-checkout']) {
    const f = await fixture(t), { projects, project } = f;
    await projects.pull(project.id); await f.advance([...initialFiles, file('next.txt', 'remote')]);
    const local = join(project.directory, 'racing-local.txt');
    if (phase === 'remote-read') {
      let injected = false;
      f.state.onRead = async path => { if (!injected && path.includes('/git/blobs/')) { injected = true; await writeFile(local, 'retain raced edit'); } };
    } else if (phase === 'before-import') {
      const importSnapshot = projects.importSnapshot.bind(projects);
      projects.importSnapshot = async (...args) => { await writeFile(local, 'retain raced edit'); return importSnapshot(...args); };
    } else {
      const gitRaw = projects.gitRaw.bind(projects);
      projects.gitRaw = async (directory, args, options) => {
        const value = await gitRaw(directory, args, options);
        if (args.includes('commit-tree')) await writeFile(local, 'retain raced edit');
        return value;
      };
    }
    await assert.rejects(projects.pull(project.id), { status: 409 });
    assert.equal(await readFile(local, 'utf8'), 'retain raced edit');
    await assert.rejects(readFile(join(project.directory, 'next.txt')), { code: 'ENOENT' });
  }
});

test('lost earlier publication recovery advances only an implicit CAS, never an explicit caller expectation', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, { empty: true }), { projects, project } = f;
    await projects.snapshot({ files: initialFiles }, project.id);
    const published = await projects.publish(project.id);
    await projects.snapshot({ files: [...initialFiles, file('first.txt', 'first edit')] }, project.id);
    const run = f.git.run.bind(f.git); let lost = false;
    f.git.run = async (...args) => {
      const value = await run(...args);
      if (args[1][0] === 'push' && !lost) { lost = true; throw Object.assign(Error('Lost completed push response'), { status: 502 }); }
      return value;
    };
    await assert.rejects(projects.publish(project.id), { status: 502 });
    const pending = projects.publication(project.id).pending;
    const desired = await projects.snapshot({ files: [...initialFiles, file('second.txt', 'second edit')] }, project.id);
    if (explicit) {
      await assert.rejects(projects.publish(project.id, { expectedRemote: published.remoteCommit }), { status: 409 });
      assert.equal(await f.head(), pending.remoteCommit);
    } else {
      const receipt = await projects.publish(project.id);
      assert.equal(receipt.sourceCommit, desired.commit); assert.equal(receipt.parent, pending.remoteCommit);
      assert.equal(await f.head(), receipt.remoteCommit);
    }
  }
});

test('new source operations reject untrusted adoption settings before reading any remote', async t => {
  const { projects, project, state } = await fixture(t);
  for (const input of [{ expectedRemote: 'short' }, { force: true }, { repositoryId: 42 }, { sourceImport: {} }]) {
    for (const name of ['readRemote', 'sourcePlan', 'pull']) await assert.rejects(projects[name](project.id, input), { status: 400 });
  }
  assert.equal(state.fetches.length, 0);
});

test('configuration, credential changes and pull share the project operation queue without reentrant deadlock', { timeout: 10000 }, async t => {
  const f = await fixture(t), { projects, project } = f;
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), paused = new Promise(resolve => { release = resolve; });
  const read = f.reader.read.bind(f.reader);
  projects.sourceSync = { read: async (...args) => { entered(); await paused; return read(...args); } };
  const pulling = projects.pull(project.id); await ready;
  let configured = false;
  const configuring = projects.update(project.id, { branch: 'other' }).then(() => { configured = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(configured, false);
  release(); await pulling; await configuring; assert.equal(projects.get(project.id).branch, 'other');
});

test('owner routes, SDK and CLI expose remote snapshot, file-free plan and pull with explicit expected remote', async () => {
  const id = 'a'.repeat(32), expectedRemote = 'b'.repeat(40), calls = [];
  const projects = Object.fromEntries(['readRemote', 'sourcePlan', 'pull'].map(name => [name, async (...args) => { calls.push([name, ...args]); return { operation: name }; }]));
  const platform = { projects, owner: principal => { if (!principal?.owner) throw Object.assign(Error('Owner required'), { status: 403 }); } };
  for (const [path, method, name] of [['read-remote', 'GET', 'readRemote'], ['source-plan', 'GET', 'sourcePlan'], ['pull', 'POST', 'pull']]) {
    let result;
    const request = { method }, url = new URL(`https://os.invalid/api/v1/projects/${id}/${path}?expectedRemote=${expectedRemote}`);
    await projectRoute(platform, request, {}, url, { owner: true }, { body: async () => ({ expectedRemote }), send: (_res, status, value) => { assert.equal(status, 200); result = value; } });
    assert.deepEqual(result, { operation: name }); assert.deepEqual(calls.at(-1), [name, id, { expectedRemote }]);
    await assert.rejects(projectRoute(platform, request, {}, url, null, { body: async () => ({}), send() {} }), { status: 403 });
  }
  const sdkCalls = [], sdk = createProjects((...args) => { sdkCalls.push(args); });
  sdk.readRemote(id, { expectedRemote }); sdk.sourcePlan(id, { expectedRemote }); sdk.pull(id, { expectedRemote });
  assert.equal(sdkCalls[0][0], `projects/${id}/read-remote?expectedRemote=${expectedRemote}`);
  assert.equal(sdkCalls[1][0], `projects/${id}/source-plan?expectedRemote=${expectedRemote}`);
  assert.deepEqual(sdkCalls[2], [`projects/${id}/pull`, { method: 'POST', body: { expectedRemote } }]);
  const cliCalls = [];
  for (const sub of ['read-remote', 'source-plan', 'pull']) await projectCLI({ sub, id, options: { 'expected-remote': expectedRemote }, request: (...args) => { cliCalls.push(args); return {}; }, print() {} });
  assert.equal(cliCalls[0][0], sdkCalls[0][0]); assert.equal(cliCalls[1][0], sdkCalls[1][0]);
  assert.deepEqual(cliCalls[2], [`projects/${id}/pull`, 'POST', { expectedRemote }]);
});
