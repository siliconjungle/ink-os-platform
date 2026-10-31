import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Projects, projectSettings } from '../server/projects.mjs';

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
