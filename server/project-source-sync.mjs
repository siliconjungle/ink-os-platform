import { createHash } from 'node:crypto';
import { sourceFiles } from '../shared/source-files.mjs';

// Official REST contracts inspected 2026-10-31. Requests are read-only and never use Git/gh configuration.
export const SOURCE_SYNC_API_VERSION = '2026-03-10';
export const SOURCE_SYNC_API_SOURCES = Object.freeze([
  'https://docs.github.com/en/rest/repos/repos#get-a-repository',
  'https://docs.github.com/en/rest/git/refs#get-a-reference',
  'https://docs.github.com/en/rest/git/commits#get-a-commit-object',
  'https://docs.github.com/en/rest/git/trees#get-a-tree',
  'https://docs.github.com/en/rest/git/blobs#get-a-blob',
  'https://docs.github.com/en/rest/commits/commits#compare-two-commits',
]);
const MAX = Object.freeze({ files: 5000, bytes: 24 * 1024 * 1024, entries: 10000, requests: 5010, networkBytes: 64 * 1024 * 1024, timeoutMs: 120000 });
const SHA = /^[a-f0-9]{40}$/;
const isSha = value => typeof value === 'string' && SHA.test(value);
const fail = (status, code) => { throw Object.assign(Error(`Project source sync: ${code}.`), { status, code }); };
const gitHash = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const canonicalRepository = destination => `https://github.com/${destination}`;

function destinationFor(project) {
  const source = project?.source, github = source?.github, branch = project?.branch;
  if (source?.provider !== 'github' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(github?.owner || '') || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(github?.repository || '') || !['private', 'public'].includes(github?.visibility || 'private')) fail(400, 'configured-github-destination-required');
  if (typeof branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,100}$/.test(branch) || branch.split('/').some(part => !part)) fail(400, 'invalid-project-branch');
  if (source.remote && source.remote !== `https://github.com/${github.owner}/${github.repository}.git`) fail(400, 'configured-github-remote-mismatch');
  return `${github.owner}/${github.repository}`.toLowerCase();
}

/** Reconstruct the exact Git tree from regular source files without writing Git objects/indexes.
 *  Directory ordering uses Git's byte ordering with a trailing slash, never locale sorting.
 */
export function sourceTreeIdentity(input, { maxBytes = MAX.bytes } = {}) {
  const files = sourceFiles(input, { maxBytes }), root = new Map(), trees = new Map();
  for (const file of files) {
    if (Buffer.from(file.path, 'utf8').toString('utf8') !== file.path) fail(400, 'non-utf8-source-path');
    const parts = file.path.split('/'); let directory = root;
    if (parts.length > 64 || Buffer.byteLength(file.path) > 4096) fail(413, 'source-path-depth-or-length-limit-exceeded');
    for (const part of parts.slice(0, -1)) {
      if (!directory.has(part)) directory.set(part, new Map());
      directory = directory.get(part);
      if (!(directory instanceof Map)) fail(400, 'source-path-directory-conflict');
    }
    directory.set(parts.at(-1), { mode: file.mode, sha: gitHash('blob', Buffer.from(file.base64, 'base64')) });
  }
  function hashTree(directory, path = '') {
    const entries = [...directory].map(([name, value]) => ({ name, value, sort: Buffer.from(name + (value instanceof Map ? '/' : ''), 'utf8') })).sort((a, b) => Buffer.compare(a.sort, b.sort));
    const chunks = entries.flatMap(({ name, value }) => {
      const subtree = value instanceof Map, sha = subtree ? hashTree(value, path ? `${path}/${name}` : name) : value.sha;
      return [Buffer.from(`${subtree ? '40000' : value.mode} ${name}\0`, 'utf8'), Buffer.from(sha, 'hex')];
    });
    const sha = gitHash('tree', Buffer.concat(chunks)); trees.set(path, sha); return sha;
  }
  return { tree: hashTree(root), trees, files };
}

function checkedProvenance(project, snapshot) {
  const destination = destinationFor(project), remote = snapshot?.provenance;
  if (!remote || remote.provider !== 'github' || remote.repository !== canonicalRepository(destination) || !Number.isSafeInteger(remote.repositoryId) || remote.repositoryId <= 0 || remote.branch !== project.branch || !isSha(remote.remoteCommit) || !isSha(remote.tree) || snapshot.tree !== remote.tree || snapshot.originCommit !== remote.remoteCommit) fail(400, 'invalid-remote-snapshot-provenance');
  if (sourceTreeIdentity(snapshot.files).tree !== remote.tree) fail(400, 'remote-snapshot-tree-mismatch');
  return { provider: 'github', repository: remote.repository, repositoryId: remote.repositoryId, branch: remote.branch, remoteCommit: remote.remoteCommit, tree: remote.tree };
}

/** Pure planning: local sourceCommit and remoteCommit are independent histories.
 *  base is a publication/import receipt: {repository,repositoryId,branch,sourceCommit,remoteCommit,tree}.
 *  local is a freshly inspected {commit,tree,changes} from the managed project; include ignored/untracked
 *  changes when deciding whether import is safe. The caller must recheck these identities before mutation.
 *  No baseline means initial import is allowed only into an unborn clean local repository.
 */
export function planSourcePull({ project, local, base = null, remote }) {
  const target = checkedProvenance(project, remote), conflicts = [];
  if (!local || typeof local.changes !== 'string' || !((local.commit === null && local.tree === null) || (isSha(local.commit) && isSha(local.tree)))) fail(400, 'explicit-local-source-state-required');
  const identity = { local: { commit: local.commit, tree: local.tree, dirty: local.changes.length > 0 }, base: null, remote: target };
  if (local.changes.length) conflicts.push('local-source-dirty');
  if (base) {
    if (base.repository !== target.repository || base.repositoryId !== target.repositoryId || base.branch !== target.branch || !isSha(base.sourceCommit) || !isSha(base.remoteCommit) || !isSha(base.tree)) fail(409, 'source-baseline-destination-or-identity-mismatch');
    identity.base = { repository: base.repository, repositoryId: base.repositoryId, branch: base.branch, sourceCommit: base.sourceCommit, remoteCommit: base.remoteCommit, tree: base.tree };
    if (local.commit !== base.sourceCommit) conflicts.push('local-source-history-advanced');
    if (local.tree !== base.tree) conflicts.push('local-source-tree-diverged');
    if (target.remoteCommit === base.remoteCommit && target.tree !== base.tree) conflicts.push('remote-baseline-tree-mismatch');
    if (target.remoteCommit !== base.remoteCommit) {
      const relation = remote.provenance.ancestry;
      identity.ancestry = relation ? { status: relation.status, baseRemoteCommit: relation.baseRemoteCommit, remoteCommit: relation.remoteCommit, mergeBaseCommit: relation.mergeBaseCommit, aheadBy: relation.aheadBy, behindBy: relation.behindBy } : null;
      if (!relation || relation.baseRemoteCommit !== base.remoteCommit || relation.remoteCommit !== target.remoteCommit) conflicts.push('remote-source-ancestry-unverified');
      else if (relation.status !== 'ahead' || relation.mergeBaseCommit !== base.remoteCommit || !Number.isSafeInteger(relation.aheadBy) || relation.aheadBy <= 0 || relation.behindBy !== 0) conflicts.push('remote-source-history-diverged');
    }
  } else if (local.commit !== null) conflicts.push('explicit-source-baseline-required');
  const canPull = conflicts.length === 0;
  return { provider: 'github', action: !canPull ? 'reconcile' : base?.remoteCommit === target.remoteCommit ? 'none' : 'import', canPull, conflicts, identity,
    preconditions: { localCommit: local.commit, localTree: local.tree, clean: true, repositoryId: target.repositoryId, branch: target.branch, remoteCommit: target.remoteCommit },
    ...(canPull ? { target: { tree: target.tree, originCommit: target.remoteCommit } } : {}),
  };
}

export class ProjectSourceSync {
  #fetch;
  #limits;
  constructor({ fetch: fetcher = globalThis.fetch, limits = {} } = {}) {
    if (typeof fetcher !== 'function' || !limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => !Object.hasOwn(MAX, key))) fail(400, 'invalid-source-sync-options');
    this.#fetch = fetcher; this.#limits = { ...MAX, ...limits };
    for (const [name, value] of Object.entries(this.#limits)) if (!Number.isSafeInteger(value) || value < 1 || value > MAX[name]) fail(400, 'invalid-source-sync-limit');
  }
  async read(project, token, { expectedRemote, repositoryId, baseRemote } = {}) {
    const destination = destinationFor(project), branch = project.branch, visibility = project.source.github.visibility || 'private', limits = this.#limits;
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) fail(400, 'explicit-project-token-required');
    if (expectedRemote !== undefined && !isSha(expectedRemote) || baseRemote !== undefined && !isSha(baseRemote) || repositoryId !== undefined && (!Number.isSafeInteger(repositoryId) || repositoryId <= 0)) fail(400, 'full-source-identities-required');
    const start = Date.now(), basePath = `repos/${destination}`, tokenBytes = Buffer.from(token); let requests = 0, networkBytes = 0;
    const cancel = async response => { try { await response.body?.cancel(); } catch {} };
    const request = async (path, maxBytes = 1024 * 1024, missing = false) => {
      if (++requests > limits.requests || Date.now() - start >= limits.timeoutMs) fail(413, 'remote-source-request-or-time-budget-exceeded');
      let response;
      try {
        response = await this.#fetch(`https://api.github.com/${basePath}${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.min(30000, Math.max(1, limits.timeoutMs - (Date.now() - start)))),
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': SOURCE_SYNC_API_VERSION } });
      } catch { fail(502, 'github-source-transport-failed'); }
      if (missing && response.status === 404) { await cancel(response); return null; }
      if (!response.ok) { await cancel(response); fail(response.status === 404 ? 404 : [401, 403].includes(response.status) ? 403 : 502, `github-source-request-failed-${response.status}`); }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && (length > maxBytes || length + networkBytes > limits.networkBytes)) { await cancel(response); fail(413, 'remote-source-response-budget-exceeded'); }
      const chunks = []; let size = 0;
      try {
        const reader = response.body?.getReader();
        if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; networkBytes += value.length; if (size > maxBytes || networkBytes > limits.networkBytes) { await reader.cancel(); fail(413, 'remote-source-response-budget-exceeded'); } chunks.push(value); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) { if (error.code === 'remote-source-response-budget-exceeded') fail(413, 'remote-source-response-budget-exceeded'); fail(502, 'invalid-github-source-response'); }
    };
    const repository = async () => {
      const value = await request('');
      if (!Number.isSafeInteger(value?.id) || value.id <= 0 || typeof value.full_name !== 'string' || value.full_name.toLowerCase() !== destination || typeof value.private !== 'boolean') fail(502, 'github-source-repository-identity-mismatch');
      if (value.private !== (visibility === 'private')) fail(409, 'github-source-visibility-mismatch');
      if (repositoryId !== undefined && value.id !== repositoryId) fail(409, 'github-source-repository-replaced');
      return value.id;
    };
    const head = async () => {
      const value = await request(`/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      if (Array.isArray(value) || value?.ref !== `refs/heads/${branch}` || value.object?.type !== 'commit' || !isSha(value.object?.sha)) fail(502, 'github-source-branch-identity-mismatch');
      return value.object.sha;
    };
    const repoId = await repository(), remoteCommit = await head();
    if (expectedRemote !== undefined && expectedRemote !== remoteCommit) fail(409, 'github-source-branch-differs-from-expected');
    const commit = await request(`/git/commits/${remoteCommit}`);
    if (commit?.sha !== remoteCommit || !isSha(commit.tree?.sha) || !Array.isArray(commit.parents) || commit.parents.length > 100 || commit.parents.some(parent => !isSha(parent.sha))) fail(502, 'github-source-commit-identity-mismatch');
    const tree = commit.tree.sha, listing = await request(`/git/trees/${tree}?recursive=1`, 7 * 1024 * 1024);
    if (listing?.sha !== tree || listing.truncated !== false || !Array.isArray(listing.tree)) fail(502, 'github-source-tree-incomplete-or-mismatched');
    if (listing.tree.length > limits.entries) fail(413, 'remote-source-entry-limit-exceeded');
    const blobs = [], directoryEntries = [], seen = new Set(); let bytes = 0;
    for (const entry of listing.tree) {
      if (!entry || typeof entry.path !== 'string' || !isSha(entry.sha) || seen.has(entry.path)) fail(502, 'invalid-github-source-tree-entry');
      seen.add(entry.path);
      if (entry.type === 'tree' && entry.mode === '040000') { directoryEntries.push(entry); continue; }
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail(400, 'remote-source-symlinks-or-submodules-unsupported');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail(502, 'invalid-github-source-blob-size');
      bytes += entry.size; blobs.push(entry);
      if (bytes > limits.bytes || blobs.length > limits.files) fail(413, 'remote-source-file-or-byte-limit-exceeded');
    }
    if (!blobs.length) fail(409, 'remote-source-snapshot-empty');
    // Validate all paths and cross-platform collisions before downloading a single file.
    sourceTreeIdentity(blobs.map(entry => ({ path: entry.path, mode: entry.mode, base64: '' })), { maxBytes: limits.bytes });
    const cache = new Map(), files = [];
    for (const entry of blobs) {
      let content = cache.get(entry.sha);
      if (!content) {
        const value = await request(`/git/blobs/${entry.sha}`, Math.ceil(entry.size * 1.5) + 8192);
        if (value?.sha !== entry.sha || value.encoding !== 'base64' || value.size !== entry.size || typeof value.content !== 'string' || /[^A-Za-z0-9+/=\r\n]/.test(value.content)) fail(502, 'github-source-blob-identity-mismatch');
        const canonical = value.content.replace(/[\r\n]/g, ''), buffer = Buffer.from(canonical, 'base64');
        if (buffer.toString('base64') !== canonical || buffer.length !== entry.size || gitHash('blob', buffer) !== entry.sha) fail(502, 'github-source-blob-integrity-mismatch');
        if (buffer.includes(tokenBytes)) fail(400, 'remote-source-contains-project-credential');
        content = { base64: canonical, size: buffer.length }; cache.set(entry.sha, content);
      }
      if (content.size !== entry.size) fail(502, 'github-source-blob-size-mismatch');
      files.push({ path: entry.path, mode: entry.mode, base64: content.base64 });
    }
    const rebuilt = sourceTreeIdentity(files, { maxBytes: limits.bytes });
    if (rebuilt.tree !== tree || directoryEntries.length !== rebuilt.trees.size - 1 || directoryEntries.some(entry => rebuilt.trees.get(entry.path) !== entry.sha)) fail(502, 'github-source-tree-integrity-mismatch');
    let ancestry;
    if (baseRemote !== undefined) {
      if (baseRemote === remoteCommit) ancestry = { status: 'identical', baseRemoteCommit: baseRemote, remoteCommit, mergeBaseCommit: baseRemote, aheadBy: 0, behindBy: 0 };
      else {
        const comparison = await request(`/compare/${baseRemote}...${remoteCommit}?per_page=1`, 2 * 1024 * 1024, true);
        if (!comparison) ancestry = { status: 'unavailable', baseRemoteCommit: baseRemote, remoteCommit, mergeBaseCommit: null, aheadBy: null, behindBy: null };
        else {
          if (comparison.base_commit?.sha !== baseRemote || !isSha(comparison.merge_base_commit?.sha) || !['ahead', 'behind', 'diverged', 'identical'].includes(comparison.status) || !Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by < 0 || !Number.isSafeInteger(comparison.behind_by) || comparison.behind_by < 0 || !Array.isArray(comparison.commits) || comparison.commits.some(value => !isSha(value.sha))) fail(502, 'github-source-ancestry-identity-mismatch');
          ancestry = { status: comparison.status, baseRemoteCommit: baseRemote, remoteCommit, mergeBaseCommit: comparison.merge_base_commit.sha, aheadBy: comparison.ahead_by, behindBy: comparison.behind_by };
        }
      }
    }
    if (await head() !== remoteCommit || await repository() !== repoId) fail(409, 'github-source-identity-changed-during-read');
    return { files: rebuilt.files, tree, originCommit: remoteCommit,
      source: { provider: 'github', repository: canonicalRepository(destination), commit: remoteCommit },
      provenance: { provider: 'github', repository: canonicalRepository(destination), repositoryId: repoId, branch, remoteCommit, tree, parents: commit.parents.map(parent => parent.sha), ...(ancestry ? { ancestry } : {}) },
    };
  }
  async planPull(project, token, { local, base = null, expectedRemote, repositoryId = base?.repositoryId } = {}) {
    const snapshot = await this.read(project, token, { expectedRemote, repositoryId, ...(base ? { baseRemote: base.remoteCommit } : {}) });
    return { ...planSourcePull({ project, local, base, remote: snapshot }), snapshot };
  }
}
