import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Projects } from '../server/projects.mjs';
import { checkoutProject, prepareProjectSnapshot } from '../cli/bin/project-checkout.mjs';

const target = { origin: 'https://example.invalid', instanceId: '1'.repeat(32) };
const file = (path, bytes, mode = '100644') => ({ path, mode, base64: Buffer.from(bytes).toString('base64') });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ink-project-checkout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = await new Projects(join(root, 'data')).open();
  const request = async path => {
    const [id, action] = path.slice('projects/'.length).split('/');
    return action === 'status' ? projects.status(id) : projects.files(id, new URL('https://example.invalid/' + path).searchParams.get('commit'));
  };
  return { root, projects, request };
}

test('source CAS admits one actual queued writer and preserves the winning tree on stale/no-op/malformed requests', async t => {
  const { projects } = await fixture(t);
  const original = await projects.snapshot({ title: 'Source', files: [file('one.txt', 'original')], originCommit: 'a'.repeat(40) });
  const results = await Promise.allSettled(['first', 'second'].map(text => projects.snapshot({ files: [file('one.txt', text)], originCommit: (text === 'first' ? 'b' : 'c').repeat(40), expectedCommit: original.commit }, original.id)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1);
  const current = await projects.status(original.id), files = await projects.files(original.id);
  assert.equal(Buffer.from(files[0].base64, 'base64').toString(), 'first');
  const catalog = await readFile(projects.catalogPath), objects = await projects.git(current.project.directory, ['count-objects', '-v']);
  await assert.rejects(projects.snapshot({ files, expectedCommit: original.commit, originCommit: 'd'.repeat(40) }, original.id), { status: 409 });
  assert.deepEqual(await readFile(projects.catalogPath), catalog);
  assert.equal(await projects.git(current.project.directory, ['count-objects', '-v']), objects);
  for (const expectedCommit of ['', false, 0, 'short', {}, undefined]) await assert.rejects(projects.snapshot({ files, expectedCommit }, original.id), { status: 400 });
  const count = projects.list().length;
  await assert.rejects(projects.snapshot({ title: 'Do not create', files, expectedCommit: original.commit }), { status: 409 });
  assert.equal(projects.list().length, count);
  // Existing callers remain compatible, while explicit null only matches an unborn project.
  assert.equal((await projects.snapshot({ files }, original.id)).commit, current.commit);
  await assert.rejects(projects.snapshot({ files, expectedCommit: null }, original.id), { status: 409 });
  const empty = await projects.create({ title: 'Unborn' });
  assert.match((await projects.snapshot({ files, expectedCommit: null }, empty.id)).commit, /^[a-f0-9]{40}$/);
});

test('checkout preserves exact bytes/tree/modes and privately binds an independent local history to the verified project', async t => {
  const { root, projects, request } = await fixture(t);
  const files = [file('app.mjs', 'export const crlf = true;\r\n'), file('assets/binary.bin', [0, 255, 13, 10]), file('run.sh', '#!/bin/sh\necho fixture\n', '100755'), file('.gitattributes', '* text eol=lf\n'), file('.gitignore', 'ignored.txt\n'), file('ignored.txt', 'tracked despite source ignore')];
  const project = await projects.snapshot({ title: 'Exact checkout', files, originCommit: 'a'.repeat(40) });
  const directory = join(root, 'checkout'), result = await checkoutProject({ projectId: project.id, directory, request, target });
  assert.equal(result.commit, project.commit); assert.notEqual(result.localCommit, project.commit);
  assert.equal(result.tree, (await projects.status(project.id)).tree);
  const local = new Projects(directory); local.records.local = { directory };
  assert.deepEqual(await local.files('local'), await projects.files(project.id));
  assert.equal(await local.git(directory, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(await local.git(directory, ['remote']), '');
  assert.deepEqual(await readFile(join(directory, 'assets/binary.bin')), Buffer.from([0, 255, 13, 10]));
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'run.sh'))).mode & 0o777, 0o755);
  const metadata = join(directory, '.git', 'ink-os-project.json'), saved = JSON.parse(await readFile(metadata));
  assert.deepEqual(saved, { format: 'ink-os-project-checkout-v1', ...target, projectId: project.id, baseCommit: project.commit, localCommit: result.localCommit, tree: result.tree });
  if (process.platform !== 'win32') assert.equal((await stat(metadata)).mode & 0o777, 0o600);
  await writeFile(join(directory, 'app.mjs'), 'export const changed = true;\r\n');
  await local.git(directory, ['add', 'app.mjs']); await local.git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Edit fetched source']);
  const commit = await local.git(directory, ['rev-parse', 'HEAD']), tree = await local.git(directory, ['rev-parse', 'HEAD^{tree}']), snapshot = { commit, tree, files: await local.files('local') };
  const update = await prepareProjectSnapshot({ directory, snapshot, projectId: project.id, request, target });
  assert.equal(update.expectedCommit, project.commit);
  const imported = await projects.snapshot({ ...snapshot, originCommit: commit, expectedCommit: update.expectedCommit }, project.id);
  await update.complete(imported);
  assert.deepEqual(await projects.files(project.id), snapshot.files);
  assert.equal(JSON.parse(await readFile(metadata)).baseCommit, imported.commit);
  await assert.rejects(prepareProjectSnapshot({ directory, snapshot, projectId: project.id, request, target: { ...target, instanceId: '2'.repeat(32) } }), /different host or project/);
  await assert.rejects(prepareProjectSnapshot({ directory, snapshot, projectId: 'f'.repeat(32), request, target }), /different host or project/);
  const changed = await projects.snapshot({ files: [file('other.txt', 'another conversation')], expectedCommit: imported.commit }, project.id);
  await assert.rejects(prepareProjectSnapshot({ directory, snapshot, projectId: project.id, request, target }), /changed since this checkout/);
  assert.equal((await projects.status(project.id)).commit, changed.commit);
});

test('checkout refuses existing paths and bad source responses without overwriting or publishing partial source', async t => {
  const { root, projects, request } = await fixture(t), project = await projects.snapshot({ title: 'Source', files: [file('one.txt', 'original')] });
  const directory = join(root, 'existing'); await mkdir(directory); await writeFile(join(directory, 'keep'), 'private work');
  await assert.rejects(checkoutProject({ projectId: project.id, directory, request, target }), { code: 'EEXIST' });
  assert.equal(await readFile(join(directory, 'keep'), 'utf8'), 'private work');
  await symlink(directory, join(root, 'alias'));
  await assert.rejects(checkoutProject({ projectId: project.id, directory: join(root, 'alias'), request, target }), { code: 'EEXIST' });
  const bad = join(root, 'bad');
  await assert.rejects(checkoutProject({ projectId: project.id, directory: bad, target, request: path => path.includes('/files?') ? [file('one.txt', 'tampered')] : request(path) }), /does not match/);
  await assert.rejects(access(bad), { code: 'ENOENT' });
  await assert.rejects(checkoutProject({ projectId: project.id, directory: bad, target, request: path => path.includes('/files?') ? [file('../escape', '')] : request(path) }), /Unsafe source/);
  await assert.rejects(access(bad), { code: 'ENOENT' });
  assert.deepEqual(await projects.files(project.id), [file('one.txt', 'original')]);
});

test('raw Git updates require actual current origin ancestry and cannot overwrite a changed private binding', async t => {
  const { root, projects, request } = await fixture(t), directory = join(root, 'raw'); await mkdir(directory);
  const local = new Projects(directory); await local.git(directory, ['init', '-b', 'main']);
  const commit = async text => {
    await writeFile(join(directory, 'one.txt'), text); await local.git(directory, ['add', 'one.txt']);
    await local.git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', text]);
    local.records.local = { directory };
    return { commit: await local.git(directory, ['rev-parse', 'HEAD']), tree: await local.git(directory, ['rev-parse', 'HEAD^{tree}']), files: await local.files('local') };
  };
  const base = await commit('original'), project = await projects.snapshot({ title: 'Raw source', files: base.files, tree: base.tree, originCommit: base.commit });
  const cleaned = await projects.snapshot({ title: 'Cleaned portable source', files: [file('one.txt', 'approved cleaned bytes')], originCommit: base.commit });
  await assert.rejects(prepareProjectSnapshot({ directory, snapshot: base, projectId: cleaned.id, request, target }), /current exact source base/);
  const snapshot = await commit('descendant'), prepared = await prepareProjectSnapshot({ directory, snapshot, projectId: project.id, request, target });
  assert.equal(prepared.expectedCommit, project.commit);
  const remote = await projects.snapshot({ files: snapshot.files, originCommit: snapshot.commit, expectedCommit: prepared.expectedCommit }, project.id);
  await prepared.complete(remote);
  // Rewinding local HEAD loses the actual verified local base; no stale fallback is allowed.
  await local.git(directory, ['reset', '--hard', base.commit]);
  await assert.rejects(prepareProjectSnapshot({ directory, snapshot: base, projectId: project.id, request, target }), /verified local source base/);
  await rm(join(directory, '.git/ink-os-project.json'));
  await assert.rejects(prepareProjectSnapshot({ directory, snapshot: base, projectId: project.id, request, target }), /does not contain/);
  await local.git(directory, ['reset', '--hard', snapshot.commit]);
  const advance = await prepareProjectSnapshot({ directory, snapshot, projectId: project.id, request, target });
  const foreign = JSON.stringify({ format: 'ink-os-project-checkout-v1', ...target, origin: 'https://other.invalid', projectId: project.id, baseCommit: remote.commit, localCommit: snapshot.commit, tree: snapshot.tree }) + '\n';
  await writeFile(join(directory, '.git/ink-os-project.json'), foreign, { mode: 0o600 });
  await assert.rejects(advance.complete(remote), /metadata changed/);
  assert.equal(await readFile(join(directory, '.git/ink-os-project.json'), 'utf8'), foreign);
});
