import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Projects, projectSettings } from '../server/projects.mjs';
import { sourceFiles } from '../shared/source-files.mjs';

test('a local project duplicates committed source into an independent repository without a remote', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = await new Projects(directory).open();
  const original = await projects.create({ title: 'Original' });
  await writeFile(join(original.directory, 'main.ink'), 'module example; fn answer()->u32{return 42;}');
  await projects.git(original.directory, ['add', 'main.ink']);
  await projects.git(original.directory, ['-c', 'user.name=Ink OS', '-c', 'user.email=ink-os@localhost', 'commit', '-m', 'Initial source']);
  const copy = await projects.duplicate(original.id);
  assert.notEqual(copy.directory, original.directory);
  assert.equal((await projects.status(copy.id)).commit, (await projects.status(original.id)).commit);
  assert.equal(await projects.git(copy.directory, ['remote']), '');
  await writeFile(join(copy.directory, 'main.ink'), 'module example; fn answer()->u32{return 43;}');
  assert.equal((await projects.status(original.id)).changes, '');
  assert.notEqual((await projects.status(copy.id)).changes, '');
  assert.equal((await new Projects(directory).open()).list().length, 2);
});

test('project paths enforce real filesystem boundaries, including symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = await new Projects(directory).open(), project = await projects.create({ title: 'Boundary' });
  const outside = join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(project.directory, 'escape'));
  await assert.rejects(projects.path(project.id, 'escape'), { status: 403 });
  await assert.rejects(projects.path(project.id, '../../outside'), { status: 403 });
  assert.equal(await projects.path(project.id), project.directory);
});

test('GitHub owner and visibility are project-specific, and remote URLs exclude credentials', () => {
  const settings = projectSettings({ source: { provider: 'github', github: { owner: 'example-team', repository: 'drawing', visibility: 'public' } } });
  assert.equal(settings.source.github.visibility, 'public');
  assert.equal(projectSettings().source.provider, 'local');
  assert.throws(() => projectSettings({ source: { provider: 'local', remote: 'https://credential@example.com/repo.git' } }), { status: 400 });
});

test('source imports preserve exact Git bytes, executable modes and history without running source hooks or attributes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = await new Projects(directory).open();
  const file = (path, bytes, mode = '100644') => ({ path, base64: Buffer.from(bytes).toString('base64'), mode });
  const files = [file('main.ink', 'module app;\r\n'), file('assets/pixels.bin', [0, 255, 10]), file('scripts/tool', '#!/bin/sh\n', '100755'), file('.gitattributes', '* text eol=lf\n')];
  const project = await projects.snapshot({ title: 'Imported source', files, originCommit: 'a'.repeat(40) });
  assert.deepEqual(await projects.files(project.id), sourceFiles(files));
  assert.deepEqual(await readFile(join(project.directory, 'assets/pixels.bin')), Buffer.from([0, 255, 10]));
  const repeated = await projects.snapshot({ files, originCommit: 'a'.repeat(40) }, project.id);
  assert.equal(repeated.commit, project.commit);
  await assert.rejects(projects.snapshot({ files: [file('bad.ink', '')], tree: '0'.repeat(40) }, project.id), { status: 400 });
  assert.deepEqual(await projects.files(project.id), sourceFiles(files));
  await writeFile(join(project.directory, 'uncommitted.txt'), 'user work');
  await assert.rejects(projects.snapshot({ files }, project.id), { status: 409 });
  const copy = await projects.duplicate(project.id, { commit: project.commit });
  assert.deepEqual(await projects.files(copy.id), sourceFiles(files));
  assert.equal(await readFile(join(project.directory, 'uncommitted.txt'), 'utf8'), 'user work');
  const count = projects.list().length;
  await assert.rejects(projects.snapshot({ title: 'Bad import', files, tree: '0'.repeat(40) }), { status: 400 });
  assert.equal(projects.list().length, count);
});

test('source snapshots reject credentials, traversal, filesystem aliases and ambiguous trees', () => {
  const file = path => ({ path, base64: '' });
  for (const path of ['.', '../secret', 'a/../secret', '.git/config', 'a/.Git/hooks/commit', '.env', '.ENV.local', 'a/.npmrc', 'C:/secret', 'a\\secret', 'a\tfile']) assert.throws(() => sourceFiles([file(path)]), { status: 400 });
  assert.throws(() => sourceFiles([file('One.ink'), file('one.ink')]), { status: 400 });
  assert.throws(() => sourceFiles([file('one'), file('one/main.ink')]), { status: 400 });
  assert.doesNotThrow(() => sourceFiles([file('.env.example')]));
});
