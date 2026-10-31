import { hash } from './world.mjs';
import { compilerRequest, isolatedWorker } from './ink-compiler.mjs';
import { inkSpec } from '../shared/ink-app.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';

const STATE_KEY = 'ink-app:state';
const fail = (status, code) => { throw Object.assign(Error(`Ink migration: ${code}.`), { status, code }); };
const identity = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0;
const entryName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.]{0,100}$/.test(value) && !value.startsWith('__');

async function checkedRelease(platform, appId, releaseId) {
  const record = platform.world.get(releaseId);
  if (!record || record.kind !== 'release' || record.archived || record.namespace !== 'os') fail(404, 'release-not-available');
  const metadata = JSON.parse(record.body);
  if (metadata.appId !== appId || !/^[a-f0-9]{64}$/.test(metadata.digest || '')) fail(409, 'release-source-provenance-mismatch');
  const bundle = await platform.bundle(releaseId);
  if (hash(JSON.stringify(bundle)) !== metadata.digest || !bundle.ink || !Array.isArray(bundle.files)) fail(409, 'release-bundle-integrity-mismatch');
  const spec = inkSpec(bundle.ink, new Set(bundle.files.map(file => file.path)));
  const file = bundle.files.find(file => file.path === spec.source);
  if (typeof file?.base64 !== 'string' || Buffer.from(file.base64, 'base64').toString('base64') !== file.base64) fail(409, 'release-source-bytes-invalid');
  const bytes = Buffer.from(file.base64, 'base64'), source = bytes.toString('utf8');
  if (!Buffer.from(source).equals(bytes)) fail(409, 'release-source-not-utf8');
  return { record, spec, compiled: await platform.code.compile(source), digest: metadata.digest };
}

async function prepared(compiled, entry, input, side) {
  try { return await compilerRequest({ op: 'prepare', core: compiled.artifact.core, identity: compiled.artifact.manifest.core_sha256, entry: entry.name, input }); }
  catch { fail(400, side + '-input-or-type-invalid'); }
}
async function execute(compiled, selected, input, snapshot, side) {
  try { return await isolatedWorker(new URL('./ink-run-worker.mjs', import.meta.url), { artifact: compiled.artifact, selected, input, ...(snapshot ? { snapshot } : {}) }); }
  catch { fail(409, side + '-execution-or-checkpoint-invalid'); }
}
function resultWire(result) {
  const wire = parseExactJSON(result.wire);
  if (!wire || typeof wire !== 'object' || !Object.hasOwn(wire, 'result')) fail(500, 'invalid-action-wire');
  return { wire, valueWire: stringifyExactJSON(wire.result) };
}

/** Explicit owner migration for the already selected NEW release, using a verified OLD release.
 *
 * input = {fromReleaseId,toReleaseId,query,change,expectedAppRevision,expectedCheckpointRevision,input?}
 * The old entry must be an exported state query. Its exact result wire is passed as the SINGLE
 * argument of an exported new state change, evaluated in a fresh new-program state. The author is
 * responsible for exporting the desired old data and explicitly initializing every required new root.
 * Ordinary execution retains its source-identity guard; migration never relabels an old snapshot.
 *
 * Uses the publication queue, Code's ordinary state queue, runtime writer fence and checkpoint CAS.
 * No publication/catalog mutation occurs. The caller must publish/select the new release separately.
 * Runtime snapshots are source-bound; this is typed export/import, not universal schema migration.
 */
export function migrateInstalledInk(platform, appId, input, principal) {
  platform.owner(principal);
  if (principal.keyId && !principal.scopes?.includes('world:write') && !principal.scopes?.includes('computer')) fail(403, 'owner-key-needs-state-write-permission');
  if (!identity(appId) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['fromReleaseId', 'toReleaseId', 'query', 'change', 'expectedAppRevision', 'expectedCheckpointRevision', 'input'].includes(key)) || !identity(input.fromReleaseId) || !identity(input.toReleaseId) || input.fromReleaseId === input.toReleaseId || !entryName(input.query) || !entryName(input.change) || !revision(input.expectedAppRevision) || !revision(input.expectedCheckpointRevision) || input.input !== undefined && (typeof input.input !== 'string' || Buffer.byteLength(input.input) > 8 * 1024 * 1024)) return Promise.reject(Object.assign(Error('Ink migration: explicit-releases-entries-and-revisions-required.'), { status: 400, code: 'explicit-releases-entries-and-revisions-required' }));
  if (platform.code?.world !== platform.world || typeof platform.code?.serializeState !== 'function' || typeof platform.runtime?.activate !== 'function' || !platform.publishTail) return Promise.reject(Object.assign(Error('Ink migration: serialized-runtime-state-required.'), { status: 503, code: 'serialized-runtime-state-required' }));
  const task = platform.publishTail.then(() => platform.code.serializeState(appId, STATE_KEY, () => platform.runtime.activate(appId, {}, async () => {
    const app = platform.app(appId);
    if (app.revision !== input.expectedAppRevision || JSON.parse(app.body).releaseId !== input.toReleaseId) fail(409, 'selected-release-or-app-revision-changed');
    const saved = await platform.code.loadCheckpoint(appId, STATE_KEY, principal);
    if (!saved.value || saved.revision !== input.expectedCheckpointRevision) fail(409, 'checkpoint-missing-or-revision-changed');
    if (typeof saved.value.snapshot !== 'string' || saved.value.snapshot.length > 44 * 1024 * 1024 || Buffer.from(saved.value.snapshot, 'base64').toString('base64') !== saved.value.snapshot || !saved.value.snapshot) fail(409, 'checkpoint-snapshot-invalid');
    const old = await checkedRelease(platform, appId, input.fromReleaseId), next = await checkedRelease(platform, appId, input.toReleaseId);
    if (saved.value.digest !== old.compiled.digest) fail(409, 'old-release-does-not-match-checkpoint');
    const query = old.compiled.entries.find(entry => entry.name === input.query), change = next.compiled.entries.find(entry => entry.name === input.change);
    if (!old.spec.exports.includes(input.query) || !query?.action || query.change !== false) fail(400, 'old-entry-must-be-exported-state-query');
    if (!next.spec.exports.includes(input.change) || !change?.action || change.change !== true || change.params.length !== 1) fail(400, 'new-entry-must-be-exported-single-argument-change');
    const oldInput = await prepared(old.compiled, query, input.input ?? '[]', 'old-query');
    const exported = await execute(old.compiled, query, oldInput.input, saved.value.snapshot, 'old-query');
    const exportResult = resultWire(exported);
    if (exported.committed || exportResult.wire.committed !== false || !Array.isArray(exportResult.wire.events) || exportResult.wire.events.length) fail(500, 'old-query-attempted-state-change');
    // Never round-trip through display JSON/Number: full-width integers and floating-point bit tokens survive.
    const newInput = await prepared(next.compiled, change, '[' + exportResult.valueWire + ']', 'new-change');
    const migrated = await execute(next.compiled, change, newInput.input, undefined, 'new-change');
    const migrationResult = resultWire(migrated);
    if (!migrated.committed || migrationResult.wire.committed !== true || typeof migrated.snapshot !== 'string' || !migrated.snapshot) fail(409, 'new-change-did-not-commit');
    const guard = () => {
      const current = platform.app(appId);
      if (current.revision !== input.expectedAppRevision || JSON.parse(current.body).releaseId !== input.toReleaseId) fail(409, 'selected-release-or-app-revision-changed');
      for (const release of [old, next]) {
        const latest = platform.world.get(release.record.id);
        if (!latest || latest.archived || latest.revision !== release.record.revision || latest.body !== release.record.body) fail(409, 'release-source-changed-during-migration');
      }
      principal.writeAccess?.check();
    };
    const authority = { ...principal, writeAccess: { check: guard, run: run => { guard(); return principal.writeAccess ? principal.writeAccess.run(run) : run(); } } };
    guard();
    const committed = await platform.code.saveCheckpoint(appId, STATE_KEY, { digest: next.compiled.digest, snapshot: migrated.snapshot }, saved.revision, authority);
    return { appId, fromReleaseId: input.fromReleaseId, toReleaseId: input.toReleaseId, query: query.name, change: change.name,
      previousRevision: saved.revision, revision: committed.revision, fromDigest: old.compiled.digest, digest: next.compiled.digest,
      fromSourceHash: old.compiled.artifact.manifest.core_sha256, sourceHash: next.compiled.artifact.manifest.core_sha256,
      exportValueWire: exportResult.valueWire, valueWire: migrationResult.valueWire, backend: 'javascript', committed: true };
  })));
  platform.publishTail = task.catch(() => {});
  return task;
}
