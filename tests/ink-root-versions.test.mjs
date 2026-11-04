import test from 'node:test';
import assert from 'node:assert/strict';
import { RootVersions } from '../server/ink-root-versions.mjs';

// A commit's hint explains only the header that commit wrote. Another write
// that lands while the commit is in flight (replicated, migrated) advances
// every path instead of taking the commit's paths.
test('commit hints explain only the state header their own commit wrote', () => {
  const appId = 'a'.repeat(32),
    commits = new Map(),
    hints = new Map(),
    platform = { world: { stateCommits: commits, get: () => null }, code: { commitHints: hints } },
    versions = new RootVersions(platform),
    write = (body) => {
      commits.set(appId + '\0ink-app:state', { revision: commits.size + 1, body });
      return versions.observe({ type: 'ink-state', appId, key: 'ink-app:state' });
    };
  commits.set(appId + '\0ink-app:state', { revision: 0, body: '{"n":0}' });
  versions.entry(appId);
  const [rows0, other0] = versions.versions(appId, ['Rows', 'Other']);

  hints.set(appId + '\0ink-app:state', { roots: ['Rows'], body: '{"n":1}' });
  assert.deepEqual(write('{"n":1}'), { appId, roots: ['Rows'] }, 'the hinted header advances its paths');
  const [rows1, other1] = versions.versions(appId, ['Rows', 'Other']);
  assert.ok(rows1 > rows0);
  assert.equal(other1, other0, 'other paths stay current');

  // A replicated header arrives while the next commit is in flight.
  hints.set(appId + '\0ink-app:state', { roots: ['Rows'], body: '{"n":2}' });
  assert.deepEqual(write('{"replicated":true}'), { appId, roots: null }, 'an unexplained header advances every path');
  const [, other2] = versions.versions(appId, ['Rows', 'Other']);
  assert.ok(other2 > other1);
});
