import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gitRuntime } from './git-runtime.mjs';
import { githubDestination } from './project-credentials.mjs';

const execute = promisify(execFile);
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const sha = value => /^[a-f0-9]{40}$/.test(value || '');

// A scratch repository receives validated bytes only. Source config, hooks,
// author identities and unrelated local history never enter publication.
export class PublicationGit {
  constructor({ executable = gitRuntime().executable, remoteFor = destination => 'https://github.com/' + destination + '.git' } = {}) {
    this.executable = executable;
    this.remoteFor = remoteFor;
  }
  async run(directory, args, { token, input, env = {}, encoding = 'utf8' } = {}) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/.test(name)));
    const invocation = execute(this.executable, ['-C', directory, '-c', 'credential.helper=', '-c', 'core.hooksPath=' + join(directory, 'no-hooks'), '-c', 'http.followRedirects=false', ...args], {
      maxBuffer: 26 * 1024 * 1024, timeout: 120000, encoding,
      env: {
        ...base, ...gitRuntime().environment, GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0',
        ...(token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64') } : {}),
        ...env,
      },
    });
    if (input !== undefined) { invocation.child.stdin.on('error', () => {}); invocation.child.stdin.end(input); }
    try { const output = (await invocation).stdout; return Buffer.isBuffer(output) ? output : output.trim(); }
    catch { fail(502, 'Git publication failed. Check repository access and retry; a remote change will be reconciled before another push.'); }
  }
  async head(directory, destination, branch, token) {
    const ref = 'refs/heads/' + branch;
    const output = await this.run(directory, ['ls-remote', '--refs', this.remoteFor(destination), ref], { token });
    if (!output) return null;
    const lines = output.split('\n');
    const [commit, name] = lines[0].split('\t');
    if (lines.length !== 1 || !sha(commit) || name !== ref) fail(502, 'Invalid remote branch response.');
    return commit;
  }
  async tree(directory, files) {
    await this.run(directory, ['read-tree', '--empty']);
    for (const file of files) {
      const hash = await this.run(directory, ['hash-object', '-w', '--stdin'], { input: Buffer.from(file.base64, 'base64') });
      await this.run(directory, ['update-index', '--add', '--cacheinfo', file.mode, hash, file.path]);
    }
    return this.run(directory, ['write-tree']);
  }
}

export class ProjectPublisher {
  constructor(directory, { fetch: fetcher = globalThis.fetch, git = new PublicationGit() } = {}) {
    this.path = join(directory, 'project-publications.json');
    this.scratch = join(directory, 'publication-work');
    this.fetch = fetcher;
    this.git = git;
    this.records = {};
    this.tail = Promise.resolve();
  }
  async open() {
    await mkdir(this.scratch, { recursive: true, mode: 0o700 });
    try { this.records = JSON.parse(await readFile(this.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  key(project) { return project.id + ':' + createHash('sha256').update(JSON.stringify([githubDestination(project), project.branch, project.source.github.visibility])).digest('hex'); }
  status(project) {
    if (project.source.provider !== 'github') return { provider: 'local', publication: null };
    const state = this.records[this.key(project)];
    return { provider: 'github', publication: state?.receipt || null, pending: state?.pending || null };
  }
  save(key, state) {
    const task = this.tail.then(async () => {
      const records = { ...this.records, [key]: state };
      await writeFile(this.path + '.next', JSON.stringify(records), { mode: 0o600, flush: true });
      await rename(this.path + '.next', this.path);
      this.records = records;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async api(token, path, { method = 'GET', body, allowMissing = false } = {}) {
    let response;
    try {
      response = await this.fetch('https://api.github.com/' + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { fail(502, 'GitHub could not be reached. Retry publication to reconcile any completed operation.'); }
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); fail(response.status === 401 || response.status === 403 ? 403 : 502, 'GitHub request failed (' + response.status + '). Check the project token permissions and repository access.'); }
    try { return await response.json(); } catch { fail(502, 'Invalid GitHub response.'); }
  }
  async repository(project, token, create) {
    const destination = githubDestination(project);
    let repository = await this.api(token, 'repos/' + destination, { allowMissing: true });
    if (!repository && create) {
      const identity = await this.api(token, 'user');
      const owner = project.source.github.owner;
      let path = 'user/repos';
      if (identity.login?.toLowerCase() !== owner.toLowerCase()) {
        const account = await this.api(token, 'users/' + encodeURIComponent(owner));
        if (account.type !== 'Organization') fail(409, 'Create a personal repository with a token belonging to its configured owner.');
        path = 'orgs/' + encodeURIComponent(owner) + '/repos';
      }
      await this.api(token, path, { method: 'POST', body: { name: project.source.github.repository, private: project.source.github.visibility === 'private', auto_init: false } });
      repository = await this.api(token, 'repos/' + destination);
    }
    if (!repository) fail(404, 'GitHub repository not found. Use publish with create to create it explicitly.');
    if (typeof repository.id !== 'number' || repository.full_name?.toLowerCase() !== destination || typeof repository.private !== 'boolean') fail(502, 'GitHub returned a different repository identity.');
    if (repository.private !== (project.source.github.visibility === 'private')) fail(409, 'Repository visibility differs from this project. Change the configuration explicitly; publication does not change visibility.');
    if (repository.archived || repository.disabled || repository.permissions?.push === false) fail(403, 'This GitHub repository is not writable.');
    return repository;
  }
  async publish(project, { commit, tree, files }, token, { create = false, expectedRemote } = {}) {
    const destination = githubDestination(project), key = this.key(project);
    const repository = await this.repository(project, token, create);
    const state = this.records[key] || {};
    if (state.repositoryId && state.repositoryId !== repository.id) fail(409, 'The GitHub repository identity changed. Register a new project before publishing to a replacement repository.');
    const directory = await mkdtemp(join(this.scratch, 'push-'));
    const finish = async pending => {
      const receipt = { ...pending, publishedAt: new Date().toISOString() };
      await this.save(key, { repositoryId: repository.id, receipt });
      return receipt;
    };
    try {
      await this.git.run(directory, ['init', '--bare', '--template=']);
      const remote = await this.git.head(directory, destination, project.branch, token);
      if (state.pending?.remoteCommit === remote) return await finish(state.pending);
      if (expectedRemote !== undefined && expectedRemote !== remote) fail(409, 'The remote branch differs from expectedRemote. Inspect its current revision before publishing.');
      if (state.receipt?.remoteCommit !== remote && remote !== null && expectedRemote !== remote) fail(409, 'The remote branch changed. Inspect and reconcile its changes, then publish with its exact expectedRemote revision.');
      if (state.receipt && remote === null) fail(409, 'The published remote branch was removed. Publication will not recreate it implicitly.');
      if (state.receipt?.remoteCommit === remote && state.receipt?.sourceCommit === commit && state.receipt.tree === tree) return state.receipt;
      if (remote) {
        await this.git.run(directory, ['fetch', '--no-tags', '--depth=1', this.git.remoteFor(destination), 'refs/heads/' + project.branch], { token });
        if (await this.git.run(directory, ['rev-parse', 'FETCH_HEAD']) !== remote) fail(409, 'The remote branch moved while preparing publication. Retry after reconciling its changes.');
      }
      if (await this.git.tree(directory, files) !== tree) fail(409, 'Publication bytes do not match the committed source tree.');
      const createdAt = state.pending?.sourceCommit === commit && state.pending?.parent === remote ? state.pending.createdAt : new Date().toISOString();
      const remoteCommit = await this.git.run(directory, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(remote ? ['-p', remote] : []), '-m', 'Publish Ink source\n\nSource-Commit: ' + commit], {
        env: { GIT_AUTHOR_NAME: 'Ink OS', GIT_AUTHOR_EMAIL: 'ink-os@localhost', GIT_COMMITTER_NAME: 'Ink OS', GIT_COMMITTER_EMAIL: 'ink-os@localhost', GIT_AUTHOR_DATE: createdAt, GIT_COMMITTER_DATE: createdAt },
      });
      if (!sha(remoteCommit)) fail(502, 'Invalid publication commit.');
      const pending = { repository: 'https://github.com/' + destination, repositoryId: repository.id, branch: project.branch, sourceCommit: commit, tree, remoteCommit, parent: remote, createdAt };
      await this.save(key, { ...state, repositoryId: repository.id, pending });
      // The explicit lease also covers an initially absent branch. The new
      // commit is always a child of the exact observed remote commit.
      await this.git.run(directory, ['push', '--porcelain', '--force-with-lease=refs/heads/' + project.branch + ':' + (remote || ''), this.git.remoteFor(destination), remoteCommit + ':refs/heads/' + project.branch], { token });
      return await finish(pending);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
