import { mkdir, readFile, writeFile, rename, realpath, lstat, access, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { sourceFiles } from '../shared/source-files.mjs';
import { gitRuntime } from './git-runtime.mjs';

const execute = promisify(execFile);
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export const validProjectId = id => /^[a-f0-9]{32}$/.test(id || '');

export function projectSettings(input = {}) {
  const source = input.source || { provider: 'local' };
  if (!['local', 'github'].includes(source.provider)) fail(400, 'Source provider must be local or github.');
  const remote = source.remote;
  if (remote && !/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(remote)) fail(400, 'Use an HTTPS or SSH Git remote.');
  if (remote && /^https?:\/\/[^/]*@/.test(remote)) fail(400, 'Credentials belong in a credential provider, not a Git remote.');
  const github = source.github || {};
  if (source.provider === 'github' && (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(github.owner || '') || !/^[a-zA-Z0-9_.-]{1,100}$/.test(github.repository || ''))) fail(400, 'Provide a GitHub owner and repository for this project.');
  if (github.visibility && !['private', 'public'].includes(github.visibility)) fail(400, 'Visibility must be private or public.');
  const branch = input.branch || 'main';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,100}$/.test(branch) || branch.includes('..')) fail(400, 'Invalid Git branch.');
  return {
    branch,
    source: {
      provider: source.provider,
      ...(remote ? { remote } : {}),
      ...(source.provider === 'github' ? { github: { owner: github.owner, repository: github.repository, visibility: github.visibility || 'private' } } : {}),
    },
    target: input.target || 'local',
  };
}

export class Projects {
  constructor(directory, { git = gitRuntime().executable } = {}) {
    this.directory = directory;
    this.catalogPath = join(directory, 'projects.json');
    this.root = join(directory, 'projects');
    this.gitExecutable = git;
    this.records = {};
    this.tail = Promise.resolve();
    this.operations = new Map();
  }
  async open() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.root);
    try { this.records = JSON.parse(await readFile(this.catalogPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  async gitRaw(directory, args, options = {}) {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const { input, ...settings } = options;
    const invocation = execute(this.gitExecutable, ['-C', directory, ...args], {
      maxBuffer: 26 * 1024 * 1024,
      ...settings,
      env: { ...environment, ...gitRuntime().environment, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', ...options.env },
    });
    if (input !== undefined) { invocation.child.stdin.on('error', () => {}); invocation.child.stdin.end(input); }
    return (await invocation).stdout;
  }
  async git(directory, args) { return (await this.gitRaw(directory, args)).trim(); }
  async persist() {
    const task = this.tail.then(async () => {
      await writeFile(this.catalogPath + '.next', JSON.stringify(this.records), { mode: 0o600, flush: true });
      await rename(this.catalogPath + '.next', this.catalogPath);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  list() { return Object.values(this.records); }
  get(id) { const project = this.records[id]; if (!project) fail(404, 'Project not found.'); return project; }
  async create(input = {}) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120) fail(400, 'Provide a project title of 1–120 characters.');
    const settings = projectSettings(input);
    const id = randomBytes(16).toString('hex');
    const directory = input.directory ? await realpath(resolve(input.directory)) : join(this.root, id);
    if (input.directory) {
      if (!(await lstat(directory)).isDirectory()) fail(400, 'Project location must be a directory.');
    } else await mkdir(directory, { mode: 0o700 });
    let existing = true;
    try { await access(join(directory, '.git')); } catch { existing = false; }
    if (!existing) await this.git(directory, ['init', '-b', settings.branch]);
    if (settings.source.remote) {
      const current = await this.git(directory, ['remote', 'get-url', 'origin']).catch(() => '');
      if (current && current !== settings.source.remote) fail(409, 'Existing origin differs; change it explicitly before registering.');
      if (!current) await this.git(directory, ['remote', 'add', 'origin', settings.source.remote]);
    }
    const project = { id, title: input.title.trim(), directory, managed: !input.directory, ...settings, createdAt: new Date().toISOString() };
    this.records[id] = project;
    await this.persist();
    return project;
  }
  async update(id, input) {
    const current = this.get(id);
    const settings = projectSettings({ ...current, ...input, source: input.source || current.source });
    this.records[id] = { ...current, ...settings };
    await this.persist();
    return this.records[id];
  }
  snapshot(input = {}, id) {
    const operation = (this.operations.get(id || 'new') || Promise.resolve()).catch(() => {}).then(() => this.importSnapshot(input, id));
    this.operations.set(id || 'new', operation);
    operation.finally(() => { if (this.operations.get(id || 'new') === operation) this.operations.delete(id || 'new'); }).catch(() => {});
    return operation;
  }
  async importSnapshot(input, id) {
    const files = sourceFiles(input.files);
    if (input.originCommit && !/^[a-f0-9]{40}$/.test(input.originCommit)) fail(400, 'Use a full original commit SHA.');
    const project = id ? this.get(id) : await this.create({ ...(input.settings || {}), directory: undefined, title: input.title || 'Source project' });
    if (!project.managed) fail(409, 'Snapshot import cannot overwrite an external working repository.');
    const settings = input.settings ? projectSettings({ ...project, ...input.settings, source: input.settings.source || project.source }) : {};
    const state = await this.status(project.id);
    const clean = async () => {
      if (await this.git(project.directory, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'])) fail(409, 'The managed project has edits or generated files. Commit or move them before importing another snapshot.');
    };
    await clean();
    await this.git(project.directory, ['config', 'core.autocrlf', 'false']);
    await this.git(project.directory, ['config', 'core.hooksPath', join(this.root, '.hooks')]);
    await mkdir(join(this.root, '.hooks'), { recursive: true });
    await mkdir(join(project.directory, '.git', 'info'), { recursive: true });
    await writeFile(join(project.directory, '.git', 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
    const index = join(project.directory, '.git', 'import-' + randomBytes(12).toString('hex'));
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'Ink OS', GIT_AUTHOR_EMAIL: 'ink-os@localhost', GIT_COMMITTER_NAME: 'Ink OS', GIT_COMMITTER_EMAIL: 'ink-os@localhost' };
    let changed = false;
    try {
      await this.gitRaw(project.directory, ['read-tree', '--empty'], { env });
      for (const file of files) {
        const bytes = Buffer.from(file.base64, 'base64');
        const hash = (await this.gitRaw(project.directory, ['hash-object', '-w', '--stdin'], { input: bytes })).trim();
        await this.gitRaw(project.directory, ['update-index', '--add', '--cacheinfo', file.mode, hash, file.path], { env });
      }
      const tree = (await this.gitRaw(project.directory, ['write-tree'], { env })).trim();
      if (input.tree && input.tree !== tree) fail(400, 'Imported source does not match the declared Git tree.');
      const priorTree = state.commit && await this.git(project.directory, ['rev-parse', state.commit + '^{tree}']);
      if (tree !== priorTree) {
        const commit = (await this.gitRaw(project.directory, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(state.commit ? ['-p', state.commit] : []), '-m', 'Import source snapshot'], { env })).trim();
        await clean();
        if ((await this.status(project.id)).commit !== state.commit) fail(409, 'Project changed during source import.');
        changed = true;
        await this.git(project.directory, ['reset', '--hard', commit]);
      }
    } catch (error) {
      if (changed && state.commit) await this.git(project.directory, ['reset', '--hard', state.commit]);
      if (!id) { delete this.records[project.id]; await this.persist(); await rm(project.directory, { recursive: true, force: true }); }
      throw error;
    } finally { await rm(index, { force: true }); }
    const commit = await this.git(project.directory, ['rev-parse', 'HEAD']);
    const { originCommit: unused, ...record } = project;
    this.records[project.id] = { ...record, ...settings, commit, ...(input.originCommit ? { originCommit: input.originCommit } : {}), updatedAt: new Date().toISOString() };
    await this.persist();
    return this.records[project.id];
  }
  async files(id, commit) {
    const project = this.get(id), revision = commit || (await this.status(id)).commit;
    if (!/^[a-f0-9]{40}$/.test(revision || '')) fail(409, 'Commit project source first.');
    await this.git(project.directory, ['merge-base', '--is-ancestor', revision, 'HEAD']).catch(() => fail(404, 'Source commit is not in this project history.'));
    const index = (await this.gitRaw(project.directory, ['ls-tree', '-rzl', revision])).split('\0').filter(Boolean);
    if (index.length > 5000) fail(413, 'Source contains more than 5000 files.');
    const files = [];
    let total = 0;
    for (const item of index) {
      const tab = item.indexOf('\t'), path = item.slice(tab + 1), [mode, kind, hash, size] = item.slice(0, tab).split(/\s+/);
      if (kind !== 'blob' || !['100644', '100755'].includes(mode)) fail(400, 'Resolve source symlinks and submodules before building.');
      total += Number(size);
      if (total > 24 * 1024 * 1024) fail(413, 'Source snapshot exceeds 24 MiB.');
      const bytes = await this.gitRaw(project.directory, ['cat-file', 'blob', hash], { encoding: 'buffer' });
      files.push({ path, mode, base64: bytes.toString('base64') });
    }
    return sourceFiles(files);
  }
  async path(id, path = '.') {
    const project = this.get(id), root = await realpath(project.directory);
    if (typeof path !== 'string' || isAbsolute(path)) fail(400, 'Use a path relative to the project.');
    const full = await realpath(resolve(root, path));
    const inside = relative(root, full);
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) fail(403, 'Path escapes the project.');
    return full;
  }
  async status(id) {
    const project = this.get(id);
    return {
      project,
      commit: await this.git(project.directory, ['rev-parse', 'HEAD']).catch(() => null),
      changes: await this.git(project.directory, ['status', '--porcelain']),
      remotes: await this.git(project.directory, ['remote', '-v']),
    };
  }
  async duplicate(id, input = {}) {
    const original = this.get(id), state = await this.status(id);
    if (!state.commit) fail(409, 'Commit the project before duplicating it.');
    if (state.changes && !input.commit) fail(409, 'Commit or discard project edits before duplicating.');
    const revision = input.commit || state.commit;
    await this.files(id, revision);
    const copy = await this.create({ title: input.title || original.title + ' copy', source: { provider: 'local' }, target: input.target || original.target });
    await this.git(copy.directory, ['fetch', '--no-tags', original.directory, revision]);
    await this.git(copy.directory, ['checkout', '-B', original.branch, 'FETCH_HEAD']);
    this.records[copy.id] = { ...copy, branch: original.branch, forkedFrom: id, sourceCommit: revision };
    await this.persist();
    return this.records[copy.id];
  }
}
