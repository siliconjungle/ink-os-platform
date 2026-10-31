import { mkdir, writeFile, rename, realpath, lstat, rm, chmod, link, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Projects } from '../../server/projects.mjs';
import { sourceFiles } from '../../shared/source-files.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const filename = 'ink-os-project.json';
const format = 'ink-os-project-checkout-v1';
function targetBinding(target) {
  let url; try { url = new URL(target?.origin); } catch { throw Error('Verify the project host identity before checking out or deploying source.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== target.origin || target.instanceId !== null && !id(target.instanceId)) throw Error('Invalid verified project host binding.');
  return { origin: url.origin, instanceId: target.instanceId };
}
function binding(value) {
  const keys = ['format', 'origin', 'instanceId', 'projectId', 'baseCommit', 'localCommit', 'tree'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.format !== format || !id(value.projectId) || !sha(value.baseCommit) || !sha(value.localCommit) || !sha(value.tree)) throw Error('Invalid private project checkout binding.');
  targetBinding(value);
  return value;
}
async function privateGit(directory) {
  const root = await realpath(directory), git = join(root, '.git'), info = await lstat(git);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Use a standalone Git checkout with its own real .git directory.');
  return { root, git, projects: new Projects(root) };
}
async function readBinding(git) {
  const path = join(git, filename);
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw Error('Project checkout metadata must be a private regular file, not a symlink.');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > 8192 || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Project checkout metadata must be an owned private regular file.');
      const raw = await handle.readFile('utf8');
      return { raw, value: binding(JSON.parse(raw)) };
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return { raw: null, value: null }; throw error; }
}
async function writeBinding(git, value, expectedRaw) {
  binding(value);
  if ((await readBinding(git)).raw !== expectedRaw) throw Error('Private checkout metadata changed; its previous binding was preserved.');
  const path = join(git, filename), temporary = join(git, '.' + filename + '-' + randomBytes(12).toString('hex'));
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    if ((await readBinding(git)).raw !== expectedRaw) throw Error('Private checkout metadata changed; its previous binding was preserved.');
    if (expectedRaw === null) {
      // Exclusive creation never replaces an existing binding, including a raced symlink.
      await link(temporary, path);
    } else await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(git, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}
async function ancestor(projects, directory, base, head) {
  try { await projects.git(directory, ['merge-base', '--is-ancestor', base, head]); return true; } catch { return false; }
}
function statusValue(status, projectId) {
  if (!status || status.project?.id !== projectId || status.project.managed !== true || status.commit !== null && !sha(status.commit) || status.tree !== null && !sha(status.tree) || (status.commit === null) !== (status.tree === null) || typeof status.changes !== 'string') throw Error('The selected managed project status is invalid.');
  if (status.changes) throw Error('The managed project has uncommitted changes; preserve and reconcile them first.');
  return status;
}

/** Prove a clean local checkout's base before sending a CAS snapshot. No source is rewritten. */
export async function prepareProjectSnapshot({ directory, snapshot, projectId, request, target }) {
  const host = targetBinding(target), local = await privateGit(directory), prior = await readBinding(local.git);
  if (!sha(snapshot?.commit) || !sha(snapshot.tree)) throw Error('Use an actual committed source snapshot.');
  if (await local.projects.git(local.root, ['rev-parse', 'HEAD']) !== snapshot.commit || await local.projects.git(local.root, ['rev-parse', 'HEAD^{tree}']) !== snapshot.tree || await local.projects.git(local.root, ['status', '--porcelain', '--untracked-files=all'])) throw Error('Commit source changes before deployment; the inspected checkout changed.');
  const saved = prior.value;
  if (saved && (saved.origin !== host.origin || saved.instanceId !== host.instanceId || saved.projectId !== projectId)) throw Error('This checkout belongs to a different host or project. Select its original project or create a separate checkout.');
  let expectedCommit = null;
  if (projectId !== undefined) {
    if (!id(projectId)) throw Error('Provide a project ID.');
    const state = statusValue(await request('projects/' + projectId + '/status'), projectId);
    expectedCommit = state.commit;
    if (saved) {
      if (saved.baseCommit !== state.commit) throw Error('Project source changed since this checkout. Check out its current source separately and reconcile your edits.');
      if (!await ancestor(local.projects, local.root, saved.localCommit, snapshot.commit) || await local.projects.git(local.root, ['rev-parse', saved.localCommit + '^{tree}']) !== saved.tree) throw Error('This checkout no longer contains its verified local source base.');
    } else if (state.commit !== null) {
      if (!sha(state.project.originCommit) || state.project.commit !== undefined && state.project.commit !== state.commit || !await ancestor(local.projects, local.root, state.project.originCommit, snapshot.commit) || await local.projects.git(local.root, ['rev-parse', state.project.originCommit + '^{tree}']) !== state.tree) throw Error('The local checkout does not contain the managed project’s current exact source base. Use projects checkout before editing this app.');
    }
  }
  return {
    expectedCommit,
    async complete(project) {
      if (!id(project?.id) || !sha(project.commit) || projectId !== undefined && project.id !== projectId) throw Error('The source import returned a different project binding.');
      await writeBinding(local.git, { format, ...host, projectId: project.id, baseCommit: project.commit, localCommit: snapshot.commit, tree: snapshot.tree }, prior.raw);
    },
  };
}

/** Export exact committed managed source into a NEW, private local Git repository. */
export async function checkoutProject({ projectId, directory, request, target }) {
  if (!id(projectId) || typeof directory !== 'string' || !directory) throw Error('Use projects checkout PROJECT_ID --directory NEW_DIRECTORY.');
  const host = targetBinding(target), requested = resolve(directory), parent = await realpath(dirname(requested)), destination = join(parent, basename(requested));
  // Reserve exclusively before any writes; even an existing empty directory is refused.
  await mkdir(destination, { mode: 0o700 });
  const owned = await lstat(destination);
  try {
    const state = statusValue(await request('projects/' + projectId + '/status'), projectId);
    if (!state.commit) throw Error('Commit project source before checking it out.');
    const files = sourceFiles(await request('projects/' + projectId + '/files?commit=' + state.commit));
    const projects = new Projects(destination);
    await projects.git(destination, ['init', '-b', 'main', '--template=']);
    await chmod(join(destination, '.git'), 0o700);
    await projects.git(destination, ['config', 'core.autocrlf', 'false']);
    await projects.git(destination, ['config', 'core.hooksPath', join(destination, '.git', 'no-hooks')]);
    await mkdir(join(destination, '.git', 'info'), { mode: 0o700 });
    await writeFile(join(destination, '.git', 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n', { mode: 0o600 });
    for (const file of files) {
      const path = join(destination, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.from(file.base64, 'base64'), { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
    }
    // Explicit plumbing ignores imported .gitignore, hooks and source attributes.
    for (const file of files) {
      const hash = (await projects.gitRaw(destination, ['hash-object', '-w', '--stdin'], { input: Buffer.from(file.base64, 'base64') })).trim();
      await projects.git(destination, ['update-index', '--add', '--cacheinfo', file.mode, hash, file.path]);
    }
    const tree = await projects.git(destination, ['write-tree']);
    if (tree !== state.tree) throw Error('Checked-out source does not match the managed project Git tree.');
    const localCommit = (await projects.gitRaw(destination, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'Check out managed Ink OS project'], { env: { GIT_AUTHOR_NAME: 'Ink OS', GIT_AUTHOR_EMAIL: 'ink-os@localhost', GIT_COMMITTER_NAME: 'Ink OS', GIT_COMMITTER_EMAIL: 'ink-os@localhost' } })).trim();
    await projects.git(destination, ['update-ref', 'refs/heads/main', localCommit]);
    if (await projects.git(destination, ['status', '--porcelain', '--untracked-files=all'])) throw Error('Checked-out source is not a clean exact working tree.');
    const current = statusValue(await request('projects/' + projectId + '/status'), projectId);
    if (current.commit !== state.commit || current.tree !== state.tree) throw Error('Project changed while checking out source. Try a new checkout.');
    await writeBinding(join(destination, '.git'), { format, ...host, projectId, baseCommit: state.commit, localCommit, tree }, null);
    return { projectId, directory: destination, commit: state.commit, localCommit, tree, files: files.length };
  } catch (error) {
    const current = await lstat(destination).catch(() => null);
    if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
