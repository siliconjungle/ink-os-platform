import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProjectSourceSync, planSourcePull, sourceTreeIdentity, SOURCE_SYNC_API_VERSION } from '../server/project-source-sync.mjs';

const token = 'explicit_project_token_' + 'p'.repeat(30);
const localCommit = '1'.repeat(40), baseRemote = '2'.repeat(40), remoteCommit = '3'.repeat(40);
const project = () => ({ id: 'a'.repeat(32), branch: 'proof/reconcile', source: { provider: 'github', github: { owner: 'Example-Team', repository: 'Palette', visibility: 'private' } } });
const file = (path, bytes, mode = '100644') => ({ path, mode, base64: Buffer.from(bytes).toString('base64') });
const objectHash = (type, bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])).digest('hex');
const rawTree = entries => objectHash('tree', Buffer.concat(entries.flatMap(([mode, name, sha]) => [Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')])));

// API fixtures are built from literal Git tree records, independently of sourceTreeIdentity's traversal.
function fixture() {
  const files = [file('main.ink', 'module palette;\r\n'), file('assets/bytes.bin', [0, 255, 13, 10]), file('tools/render', '#!/bin/sh\necho render\n', '100755')];
  const blobs = files.map(value => ({ ...value, bytes: Buffer.from(value.base64, 'base64'), sha: objectHash('blob', Buffer.from(value.base64, 'base64')) }));
  const assetsTree = rawTree([['100644', 'bytes.bin', blobs[1].sha]]), toolsTree = rawTree([['100755', 'render', blobs[2].sha]]);
  const tree = rawTree([['40000', 'assets', assetsTree], ['100644', 'main.ink', blobs[0].sha], ['40000', 'tools', toolsTree]]);
  const state = { calls: [], repoCalls: 0, headCalls: 0, tree, files, blobs, repository: { id: 42, full_name: 'example-team/palette', private: true },
    ref: { ref: 'refs/heads/proof/reconcile', object: { type: 'commit', sha: remoteCommit } },
    commit: { sha: remoteCommit, tree: { sha: tree }, parents: [{ sha: baseRemote }], author: { name: token }, message: token },
    listing: { sha: tree, truncated: false, tree: [
      { path: 'assets', mode: '040000', type: 'tree', sha: assetsTree }, { path: 'tools', mode: '040000', type: 'tree', sha: toolsTree },
      ...blobs.map(blob => ({ path: blob.path, mode: blob.mode, type: 'blob', size: blob.bytes.length, sha: blob.sha, url: 'https://attacker.invalid/never-follow' })),
    ] },
    comparison: { status: 'ahead', base_commit: { sha: baseRemote }, merge_base_commit: { sha: baseRemote }, ahead_by: 1, behind_by: 0, commits: [{ sha: remoteCommit }] },
  };
  state.fetch = async (url, options) => {
    const parsed = new URL(url), path = parsed.pathname;
    assert.equal(parsed.origin, 'https://api.github.com'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.headers['X-GitHub-Api-Version'], SOURCE_SYNC_API_VERSION);
    state.calls.push(path);
    if (state.responseOverride) { const response = await state.responseOverride(path); if (response) return response; }
    if (path === '/repos/example-team/palette') { state.repoCalls++; return Response.json(state.repoCalls > 1 && state.finalRepository ? state.finalRepository : state.repository); }
    if (path === '/repos/example-team/palette/git/ref/heads/proof/reconcile') { state.headCalls++; return Response.json(state.headCalls > 1 && state.finalRef ? state.finalRef : state.ref); }
    if (path === `/repos/example-team/palette/git/commits/${remoteCommit}`) return Response.json(state.commit);
    if (path === `/repos/example-team/palette/git/trees/${tree}`) { assert.equal(parsed.searchParams.get('recursive'), '1'); return Response.json(state.listing); }
    if (path === `/repos/example-team/palette/compare/${baseRemote}...${remoteCommit}`) { assert.equal(parsed.searchParams.get('per_page'), '1'); return state.comparison ? Response.json(state.comparison) : Response.json({}, { status: 404 }); }
    const blob = blobs.find(blob => path === `/repos/example-team/palette/git/blobs/${blob.sha}`);
    if (blob) return Response.json(state.blobOverride ? state.blobOverride(blob) : { sha: blob.sha, encoding: 'base64', size: blob.bytes.length, content: blob.base64.match(/.{1,8}/g).join('\n') + '\n' });
    throw Error('Unexpected fixture path');
  };
  state.reader = new ProjectSourceSync({ fetch: state.fetch });
  return state;
}
const baseline = tree => ({ repository: 'https://github.com/example-team/palette', repositoryId: 42, branch: 'proof/reconcile', sourceCommit: localCommit, remoteCommit: baseRemote, tree });
const cleanLocal = tree => ({ commit: localCommit, tree, changes: '' });

test('source tree hashes preserve binary bytes, executable bits and Git byte/directory sorting', () => {
  const f = fixture(), rebuilt = sourceTreeIdentity(f.files);
  assert.equal(rebuilt.tree, f.tree);
  const blob = objectHash('blob', Buffer.from('x')), leafTree = rawTree([['100644', 'x', blob]]);
  const expected = rawTree([['100644', 'a.c', blob], ['40000', 'a', leafTree], ['100644', 'é', blob]]);
  assert.equal(sourceTreeIdentity([file('a/x', 'x'), file('é', 'x'), file('a.c', 'x')]).tree, expected);
  assert.notEqual(sourceTreeIdentity(f.files.map(value => ({ ...value, mode: '100644' }))).tree, f.tree);
});

test('read returns canonical committed snapshot and only allowlisted provenance using explicit private inputs', async () => {
  const f = fixture(), result = await f.reader.read(project(), token, { expectedRemote: remoteCommit, repositoryId: 42 });
  assert.equal(result.tree, f.tree); assert.equal(result.originCommit, remoteCommit); assert.equal(result.source.commit, remoteCommit);
  assert.deepEqual(result.files, sourceTreeIdentity(f.files).files);
  assert.deepEqual(Buffer.from(result.files.find(value => value.path === 'assets/bytes.bin').base64, 'base64'), Buffer.from([0, 255, 13, 10]));
  assert.equal(result.files.find(value => value.path === 'tools/render').mode, '100755');
  assert.equal(result.provenance.repositoryId, 42); assert.equal(f.headCalls, 2); assert.equal(f.repoCalls, 2);
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(f.reader).includes(token));
  assert.equal(f.calls.filter(path => path.includes('/git/blobs/')).length, 3);
});

test('identical blob objects are downloaded once while every file remains in the verified tree', async () => {
  const f = fixture(), alias = { ...f.listing.tree[3], path: 'copy.bin' };
  f.listing.tree.push(alias);
  const newTree = rawTree([['40000', 'assets', f.listing.tree[0].sha], ['100644', 'copy.bin', alias.sha], ['100644', 'main.ink', f.blobs[0].sha], ['40000', 'tools', f.listing.tree[1].sha]]);
  f.commit.tree.sha = newTree; f.listing.sha = newTree;
  f.responseOverride = path => path.includes('/git/trees/') ? Response.json(f.listing) : null;
  const result = await f.reader.read(project(), token);
  assert.equal(result.files.length, 4); assert.equal(result.tree, newTree);
  assert.equal(f.calls.filter(path => path.includes('/git/blobs/')).length, 3);
  assert.equal(result.files.find(value => value.path === 'copy.bin').base64, f.blobs[1].base64);
});

test('source reading validates repo visibility/ID, exact branch and full commit/tree identities', async () => {
  for (const [mutate, code] of [
    [f => f.repository.full_name = 'foreign/repository', 'repository-identity-mismatch'],
    [f => f.repository.private = false, 'visibility-mismatch'],
    [f => f.repository.id = 43, 'repository-replaced'],
    [f => f.ref.ref = 'refs/heads/other', 'branch-identity-mismatch'],
    [f => f.ref.object.type = 'tag', 'branch-identity-mismatch'],
    [f => f.ref.object.sha = 'short', 'branch-identity-mismatch'],
    [f => f.commit.sha = baseRemote, 'commit-identity-mismatch'],
    [f => f.commit.tree.sha = 'short', 'commit-identity-mismatch'],
    [f => f.listing.sha = baseRemote, 'tree-incomplete-or-mismatched'],
    [f => f.listing.truncated = true, 'tree-incomplete-or-mismatched'],
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(f.reader.read(project(), token, { repositoryId: 42 }), error => error.code.includes(code));
  }
  const f = fixture(); await assert.rejects(f.reader.read(project(), token, { expectedRemote: baseRemote }), { status: 409 });
  assert.equal(f.calls.some(path => path.includes('/git/commits/')), false);
});

test('branch movement and repository replacement during a read fail without returning a stale snapshot', async () => {
  for (const mutate of [f => f.finalRef = { ...f.ref, object: { type: 'commit', sha: baseRemote } }, f => f.finalRepository = { ...f.repository, id: 99 }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.reader.read(project(), token), { status: 409 });
  }
});

test('unsupported modes and credential/colliding paths fail before blob downloads', async () => {
  for (const mutate of [
    entry => { entry.mode = '120000'; }, entry => { entry.type = 'commit'; entry.mode = '160000'; },
    entry => { entry.path = '.env'; }, entry => { entry.path = 'nested/.dev.vars'; }, entry => { entry.path = '../outside'; },
    entry => { entry.path = '.git/config'; }, entry => { entry.path = 'tools\\outside'; }, entry => { entry.path = 'MAIN.ink'; },
    entry => { entry.path = Array(66).fill('deep').join('/'); },
  ]) {
    const f = fixture(); mutate(f.listing.tree.at(-1));
    await assert.rejects(f.reader.read(project(), token)); assert.equal(f.calls.some(path => path.includes('/git/blobs/')), false);
  }
});

test('blob SHA/bytes/size/encoding, directory hashes and complete reconstructed tree are verified', async () => {
  for (const mutate of [
    value => { value.sha = baseRemote; }, value => { value.content = '%%'; }, value => { value.content = 'eA=='; },
    value => { value.size++; }, value => { value.encoding = 'utf-8'; }, value => { value.content = 'Zg='; },
  ]) {
    const f = fixture(); f.blobOverride = blob => { const value = { sha: blob.sha, content: blob.base64, size: blob.bytes.length, encoding: 'base64' }; mutate(value); return value; };
    await assert.rejects(f.reader.read(project(), token), { status: 502 });
  }
  for (const mutate of [f => f.listing.tree[0].sha = baseRemote, f => f.listing.tree.push({ path: 'empty', mode: '040000', type: 'tree', sha: baseRemote }), f => f.listing.tree.at(-1).mode = '100644', f => f.listing.tree.pop()]) {
    const f = fixture(); mutate(f); await assert.rejects(f.reader.read(project(), token), error => error.code === 'github-source-tree-integrity-mismatch');
  }
});

test('file, byte, entry, request and network budgets reject before unbounded work', async () => {
  for (const limits of [{ files: 2 }, { bytes: 1 }, { entries: 4 }, { requests: 1 }, { networkBytes: 1 }]) {
    const f = fixture(), reader = new ProjectSourceSync({ fetch: f.fetch, limits });
    await assert.rejects(reader.read(project(), token), { status: 413 });
  }
  const f = fixture(); f.responseOverride = path => path.endsWith('/git/commits/' + remoteCommit) ? new Response('x'.repeat(1024 * 1024 + 1)) : null;
  await assert.rejects(f.reader.read(project(), token), { status: 413 });
  assert.throws(() => new ProjectSourceSync({ limits: { files: 5001 } }), { status: 400 });
});

test('credentials never escape echoed provider errors, remote metadata or source files', async () => {
  for (const response of [() => { throw Error(token); }, () => Response.json({ token }, { status: 403 }), () => new Response(token), () => Response.json({}, { status: 302 })]) {
    const f = fixture(), reader = new ProjectSourceSync({ fetch: response });
    await assert.rejects(reader.read(project(), token), error => !JSON.stringify({ message: error.message, ...error }).includes(token));
  }
  const f = fixture(); f.blobs[0].bytes = Buffer.from(token); f.blobs[0].sha = objectHash('blob', f.blobs[0].bytes); f.blobs[0].base64 = f.blobs[0].bytes.toString('base64');
  f.listing.tree[2].sha = f.blobs[0].sha; f.listing.tree[2].size = f.blobs[0].bytes.length;
  await assert.rejects(f.reader.read(project(), token), { code: 'remote-source-contains-project-credential' });
  const noToken = fixture(); await assert.rejects(noToken.reader.read(project()), { status: 400 }); assert.equal(noToken.calls.length, 0);
});

test('pull planning preserves independent local/remote commit identities and allows only baseline-bound remote advance', async () => {
  const f = fixture(), base = baseline(f.tree), local = cleanLocal(f.tree);
  const planned = await f.reader.planPull(project(), token, { local, base });
  assert.equal(planned.canPull, true); assert.equal(planned.action, 'import');
  assert.equal(planned.identity.local.commit, localCommit); assert.equal(planned.identity.base.remoteCommit, baseRemote); assert.equal(planned.identity.remote.remoteCommit, remoteCommit);
  assert.notEqual(planned.preconditions.localCommit, planned.preconditions.remoteCommit);
  assert.equal(planned.target.originCommit, remoteCommit); assert.equal(planned.snapshot.tree, f.tree);
  const initial = planSourcePull({ project: project(), local: { commit: null, tree: null, changes: '' }, remote: planned.snapshot }); assert.equal(initial.action, 'import');
  const identicalBase = { ...base, remoteCommit }, identical = planSourcePull({ project: project(), local, base: identicalBase, remote: planned.snapshot }); assert.equal(identical.action, 'none');
});

test('pull planning refuses dirty/untracked/ignored changes, local advances, missing baselines and remote divergence', async () => {
  const f = fixture(), snapshot = await f.reader.read(project(), token, { baseRemote }), base = baseline(f.tree);
  for (const [local, expected] of [[{ ...cleanLocal(f.tree), changes: '?? untracked\n!! ignored\n' }, 'local-source-dirty'], [{ ...cleanLocal(f.tree), commit: '4'.repeat(40) }, 'local-source-history-advanced'], [{ ...cleanLocal(f.tree), tree: '4'.repeat(40) }, 'local-source-tree-diverged']]) {
    const plan = planSourcePull({ project: project(), local, base, remote: snapshot }); assert.equal(plan.canPull, false); assert.equal(plan.action, 'reconcile'); assert.ok(plan.conflicts.includes(expected)); assert.equal(plan.target, undefined);
  }
  const noBase = planSourcePull({ project: project(), local: cleanLocal(f.tree), remote: snapshot }); assert.ok(noBase.conflicts.includes('explicit-source-baseline-required'));
  for (const comparison of [null, { ...f.comparison, status: 'diverged', behind_by: 1 }, { ...f.comparison, status: 'behind', ahead_by: 0, behind_by: 2 }]) {
    const fixture2 = fixture(); fixture2.comparison = comparison;
    const plan = await fixture2.reader.planPull(project(), token, { local: cleanLocal(fixture2.tree), base: baseline(fixture2.tree) }); assert.equal(plan.canPull, false); assert.ok(plan.conflicts.includes('remote-source-history-diverged'));
  }
  const unverified = await f.reader.read(project(), token); assert.ok(planSourcePull({ project: project(), local: cleanLocal(f.tree), base, remote: unverified }).conflicts.includes('remote-source-ancestry-unverified'));
  assert.throws(() => planSourcePull({ project: project(), local: cleanLocal(f.tree), base: { ...base, repositoryId: 9 }, remote: snapshot }), { status: 409 });
});

test('ancestry responses cannot silently rebind the remote baseline, and malformed caller identities are rejected', async () => {
  for (const mutate of [value => value.base_commit.sha = localCommit, value => value.ahead_by = -1, value => value.commits[0].sha = 'short']) {
    const f = fixture(); mutate(f.comparison);
    await assert.rejects(f.reader.planPull(project(), token, { local: cleanLocal(f.tree), base: baseline(f.tree) }), { code: 'github-source-ancestry-identity-mismatch' });
  }
  const f = fixture();
  await assert.rejects(f.reader.read(project(), token, { expectedRemote: 'short' }), { status: 400 }); assert.equal(f.calls.length, 0);
  const snapshot = await f.reader.read(project(), token);
  assert.throws(() => planSourcePull({ project: project(), local: { commit: localCommit, tree: f.tree }, remote: snapshot }), { status: 400 });
  const brokenBase = { ...baseline('4'.repeat(40)), remoteCommit };
  const plan = planSourcePull({ project: project(), local: cleanLocal(brokenBase.tree), base: brokenBase, remote: snapshot });
  assert.equal(plan.canPull, false); assert.ok(plan.conflicts.includes('remote-baseline-tree-mismatch'));
});
