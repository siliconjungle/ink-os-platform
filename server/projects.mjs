import { mkdir, readFile, writeFile, rename, realpath, lstat, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

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
  constructor(directory, { git = 'git' } = {}) {
    this.directory = directory;
    this.catalogPath = join(directory, 'projects.json');
    this.root = join(directory, 'projects');
    this.gitExecutable = git;
    this.records = {};
    this.tail = Promise.resolve();
  }
  async open() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.root);
    try { this.records = JSON.parse(await readFile(this.catalogPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  async git(directory, args) {
    return (await execute(this.gitExecutable, ['-C', directory, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    })).stdout.trim();
  }
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
    const project = { id, title: input.title.trim(), directory, ...settings, createdAt: new Date().toISOString() };
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
    if (state.changes) fail(409, 'Commit or discard project edits before duplicating.');
    const copy = await this.create({ title: input.title || original.title + ' copy', source: { provider: 'local' }, target: input.target || original.target });
    await this.git(copy.directory, ['fetch', '--no-tags', original.directory, state.commit]);
    await this.git(copy.directory, ['checkout', '-B', original.branch, 'FETCH_HEAD']);
    this.records[copy.id] = { ...copy, branch: original.branch, forkedFrom: id, sourceCommit: state.commit };
    await this.persist();
    return this.records[copy.id];
  }
}
