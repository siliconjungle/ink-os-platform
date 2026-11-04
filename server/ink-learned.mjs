// Learned parameters of installed Ink apps as World rows, and gated edits.
//
// An app with `learn` holes keeps its parameters in its Ink state, behind the
// generated `__learn_get` query and `__learn_set` learn change. This module
// lists them as keyed rows (a choice entry by its argument values, an mlp
// weight by index), mirrors them into a World object for history and search,
// and applies edits from anyone, including language-model agents, only when
// the app's declared objective improves on the owner's gate data.
//
// Edits are judged on a separate scratch state of the same release, so a
// rejected edit never touches the live state. Objectives read only the
// parameters and their arguments, so the scratch gives exact values. An
// admitted edit is one live learn commit, followed by a World record with its
// receipt. Gating compares measurements; it grants no other authority.
import { createHash } from 'node:crypto';
import { installedInk } from './ink-apps.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';

export const ROWS_FORMAT = 'ink-learn-rows-v1';
export const EDIT_FORMAT = 'ink-learn-edit-v1';
export const LEARNED_ENTRY = /^(__learn_get|__learn_set|__objective_[A-Za-z_][A-Za-z0-9_]*)$/;
const SCRATCH = 'ink-app:learned-scratch';
const MAX_ROWS = 16384, MAX_GATE_BYTES = 4 * 1024 * 1024, HISTORY = 50;

// Objective values arrive as exact wire floats ({F32Bits} / {F64Bits}).
function scalar(v) {
  const view = new DataView(new ArrayBuffer(8));
  if (v && typeof v === 'object' && 'F32Bits' in v) { view.setUint32(0, Number(v.F32Bits)); return view.getFloat32(0); }
  if (v && typeof v === 'object' && 'F64Bits' in v) { view.setBigUint64(0, BigInt(v.F64Bits)); return view.getFloat64(0); }
  const n = Number(v);
  if (!Number.isFinite(n)) fail(500, 'The objective did not return a finite number.');
  return n;
}
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const sha = text => createHash('sha256').update(text).digest('hex');
const recordId = (appId, kind) => sha(appId + '\0' + kind).slice(0, 32);
const queues = new Map();
function serial(appId, task) {
  const next = (queues.get(appId) || Promise.resolve()).then(task, task);
  queues.set(appId, next.catch(() => {}));
  return next;
}

/** Hole layout and objectives from a compiled app's checked core. */
export function learnedLayout(artifact) {
  const core = typeof artifact?.core === 'string' ? JSON.parse(artifact.core) : artifact?.core;
  const learning = (core?.program ?? core)?.contracts?.learning;
  return learning?.holes?.length ? { holes: learning.holes, objectives: learning.objectives || [] } : null;
}

const ordinal = v => (typeof v === 'bigint' ? Number(v) : v);
function keyOf(h, i) { return h.domains.map(d => { const v = d[i % d.length]; i = Math.floor(i / d.length); return v; }); }
function indexOf(h, key) {
  if (!Array.isArray(key) || key.length !== h.domains.length) fail(400, `${h.name}: key needs ${h.domains.length} values`);
  let index = 0, stride = 1;
  key.forEach((v, j) => { const k = h.domains[j].indexOf(v); if (k < 0) fail(400, `${h.name}: ${v} is not one of ${h.domains[j].join(', ')}`); index += k * stride; stride *= h.domains[j].length; });
  return index;
}

/** Rows for a `__learn_get` parameter record. */
export function learnedRows(layout, params) {
  const rows = [];
  for (const h of layout.holes) {
    const xs = params?.[h.field];
    if (!Array.isArray(xs)) fail(500, `Missing parameters for ${h.name}`);
    xs.forEach((x, i) => rows.push(h.family === 'choice' ? { hole: h.name, key: keyOf(h, i), value: h.values[ordinal(x)] } : { hole: h.name, index: i, value: x }));
  }
  return rows;
}

/** Apply rows to a parameter record; returns {next, changed}. */
export function applyLearnedRows(layout, params, rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail(400, `An edit is a list of at most ${MAX_ROWS} rows`);
  const next = structuredClone(params), seen = new Set();
  let changed = 0;
  for (const r of rows) {
    const h = layout.holes.find(h => h.name === r?.hole);
    if (!h) fail(400, `Unknown learn hole ${r?.hole}`);
    let i, v;
    if (h.family === 'choice') {
      if (r.index !== undefined) fail(400, `${h.name}: choice rows are addressed by key`);
      i = indexOf(h, r.key);
      v = h.values.indexOf(r.value);
      if (v < 0) fail(400, `${h.name}: ${r.value} is not one of ${h.values.join(', ')}`);
    } else {
      if (r.key !== undefined) fail(400, `${h.name}: mlp rows are addressed by index`);
      i = r.index; v = r.value;
      if (!Number.isInteger(i) || i < 0 || i >= h.parameters || typeof v !== 'number' || !Number.isFinite(v)) fail(400, `${h.name}: index ${i} or value ${v} is out of range`);
    }
    if (seen.has(h.name + ':' + i)) fail(400, `${h.name}: an edit addresses parameter ${i} twice`);
    seen.add(h.name + ':' + i);
    if (ordinal(next[h.field][i]) !== v) changed++;
    next[h.field][i] = v;
  }
  return { next, changed };
}

async function context(platform, appId) {
  const app = await installedInk(platform, appId);
  const compiled = await platform.code.compile(app.source);
  const layout = learnedLayout(compiled.artifact);
  if (!layout) fail(409, 'This Ink app declares no learn holes.');
  const call = async (entry, args, stateKey = 'ink-app:state') => {
    const principal = platform.runtime.bind({ owner: false, appId, namespace: appId, releaseId: app.releaseId });
    const result = await platform.code.run({ source: app.source, entry, args, learned: true, namespace: appId, stateKey, principal });
    return parseExactJSON(result.wire).result;
  };
  return { app, layout, call };
}

async function store(platform, appId, kind, input, action) {
  const id = recordId(appId, kind), current = platform.world.get(id);
  return platform.world.put({ id, namespace: appId, ...input }, { writer: appId, expected: current?.revision || 0, actor: 'Learned parameters', action });
}

/** Current rows, layout, gate and recent admitted edits. */
export async function learnedState(platform, appId) {
  const { app, layout, call } = await context(platform, appId);
  const rows = learnedRows(layout, await call('__learn_get', []));
  const body = JSON.stringify({ format: ROWS_FORMAT, releaseId: app.releaseId, rows });
  if (platform.world.get(recordId(appId, 'ink-learned-rows'))?.body !== body)
    await store(platform, appId, 'ink-learned-rows', { kind: 'state', title: 'Learned parameters', tags: ['ink-learned-rows'], body }, 'listed learned parameters');
  const gate = platform.world.get(recordId(appId, 'ink-learned-gate'));
  const parsed = gate && JSON.parse(gate.body);
  const history = platform.world.all().filter(o => o.namespace === appId && o.kind === 'ink-learned-edit' && !o.archived).slice(-HISTORY).map(o => ({ id: o.id, ...JSON.parse(o.body) }));
  return { releaseId: app.releaseId, holes: layout.holes, objectives: layout.objectives, rows, gate: parsed ? { objective: parsed.objective, dataSha256: sha(stringifyExactJSON(parsed.data)) } : null, history };
}

/** The owner's held-out data for judging edits. */
export async function setLearnedGate(platform, appId, input = {}) {
  const { layout } = await context(platform, appId);
  if (!layout.objectives.includes(input.objective)) fail(400, `Unknown objective ${input.objective}; declared: ${layout.objectives.join(', ')}`);
  if (!Array.isArray(input.data)) fail(400, 'Gate data is the JSON array of the objective arguments.');
  const text = stringifyExactJSON(input.data);
  if (text.length > MAX_GATE_BYTES) fail(413, 'Gate data is too large.');
  await store(platform, appId, 'ink-learned-gate', { kind: 'state', title: 'Learned parameter gate', tags: ['ink-learned-gate'], body: JSON.stringify({ objective: input.objective, data: input.data }) }, 'set learned parameter gate');
  return { objective: input.objective, dataSha256: sha(text) };
}

/** Admit an edit only if the gate objective improves (or, with allowEqual, does not worsen). */
export function editLearned(platform, appId, input = {}) {
  return serial(appId, async () => {
    const edit = input.edit;
    if (edit?.format !== EDIT_FORMAT) fail(400, `Expected an ${EDIT_FORMAT} edit.`);
    const gateRecord = platform.world.get(recordId(appId, 'ink-learned-gate'));
    if (!gateRecord) fail(409, 'Set gate data before submitting edits.');
    const gate = JSON.parse(gateRecord.body);
    const { app, layout, call } = await context(platform, appId);
    const current = await call('__learn_get', []);
    const { next, changed } = applyLearnedRows(layout, current, edit.rows);
    const objective = '__objective_' + gate.objective;
    const score = async () => scalar(await call(objective, gate.data, SCRATCH));
    const ok = v => v !== null && typeof v === 'object' && Object.hasOwn(v, 'Ok');
    if (!ok(await call('__learn_set', [current], SCRATCH))) fail(500, 'The scratch state rejected the current parameters.');
    const before = await score();
    const receipt = { semantics: 'ink-os-learned-gate-v1', releaseId: app.releaseId, objective: gate.objective, dataSha256: sha(stringifyExactJSON(gate.data)), editSha256: sha(stringifyExactJSON(edit)), author: edit.author ?? null, reason: edit.reason ?? null, rows: edit.rows.length, changed, rule: input.allowEqual ? 'no-regression' : 'strict-improvement', before };
    if (!ok(await call('__learn_set', [next], SCRATCH))) return { ...receipt, admitted: false, rejection: 'The parameters failed their shape check.' };
    const after = await score();
    const admitted = changed > 0 && (after < before || (input.allowEqual === true && after <= before));
    if (!admitted) return { ...receipt, after, admitted: false, rejection: changed ? 'The objective did not improve on the gate data.' : 'The edit changes no parameter.' };
    // Apply to the live state only if nothing changed it meanwhile.
    if (stringifyExactJSON(await call('__learn_get', [])) !== stringifyExactJSON(current)) fail(409, 'The learned parameters changed; resubmit the edit.');
    if (!ok(await call('__learn_set', [next]))) fail(500, 'The live state rejected admitted parameters.');
    const result = { ...receipt, after, admitted: true };
    await platform.world.create({ namespace: appId, kind: 'ink-learned-edit', title: 'Learned edit: ' + (edit.reason || edit.author || changed + ' parameters'), tags: ['ink-learned-edit'], body: JSON.stringify({ edit, receipt: result }) }, { writer: appId, actor: edit.author || 'Learned parameters', action: 'admitted learned edit' });
    await store(platform, appId, 'ink-learned-rows', { kind: 'state', title: 'Learned parameters', tags: ['ink-learned-rows'], body: JSON.stringify({ format: ROWS_FORMAT, releaseId: app.releaseId, rows: learnedRows(layout, next) }) }, 'admitted learned edit');
    return result;
  });
}
