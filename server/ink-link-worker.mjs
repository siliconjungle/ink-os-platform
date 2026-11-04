// A link worker evaluates cross-app read plans next to a read-only copy of
// one provider release's Ink state.
//
// The copy is restored from the provider's journal and follows it by
// replaying committed records, the same deterministic replay recovery uses;
// any reply that differs from the recorded one discards the copy. Nothing in
// this worker can reach World, storage, host bindings or effects: it receives
// values and returns values. Consumer modules are loaded only to call pure
// functions that admission proved pure.
import { parentPort, workerData } from 'node:worker_threads';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { wireValue, wireResult } from '../shared/ink-values.mjs';
import { native } from './ink-input.mjs';

const { artifact, entries } = workerData;
const load = (javascript) =>
  import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
const provider = await load(artifact.javascript);
provider.setParallelism?.(1);
const named = artifact.manifest.named_types;
const api = (await WebAssembly.instantiate(workerData.compiler, {})).exports;
const consumers = new Map();
let checked = false,
  state = null,
  bindings = new Map();

function prepare(entry, input) {
  const bytes = Buffer.from(
    JSON.stringify({
      op: 'prepare',
      ...(checked ? {} : { core: artifact.core }),
      identity: artifact.manifest.core_sha256,
      entry,
      input,
    }),
  );
  const pointer = api.ink_env_alloc(bytes.length);
  if (!pointer) throw Error('Compiler request allocation failed.');
  try {
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    const result = api.ink_env_request(pointer, bytes.length),
      response = JSON.parse(
        Buffer.from(api.memory.buffer, result, api.ink_env_response_len()).toString(),
      );
    if (response.error) throw Error(response.error);
    checked = true;
    return response.ok.input;
  } finally {
    api.ink_env_free(pointer, bytes.length);
  }
}
function invoke(entry, input) {
  const selected = entries.find((candidate) => candidate.name === entry && candidate.action);
  if (!selected) throw Error('Unknown provider action ' + entry);
  if (!state) throw Error('The provider copy is not loaded.');
  const args = parseExactJSON(prepare(entry, input)).map((value, i) =>
    native(value, selected.params[i].type, named),
  );
  if (!bindings.has(entry)) bindings.set(entry, state.bind(entry));
  return { selected, output: bindings.get(entry)(...args) };
}
function replay(records) {
  for (const record of records) {
    const { selected, output } = invoke(record.entry, record.input);
    const wire = stringifyExactJSON(wireResult(output, selected, artifact.manifest));
    if (!output.committed || wire !== record.wire) {
      state = null;
      throw Error('Provider copy replay mismatch.');
    }
  }
}
const U64 = (1n << 64n) - 1n;
function evaluate({ entry, input, plan, consumer }) {
  const started = performance.now(),
    { selected, output } = invoke(entry, input);
  if (output.committed) throw Error('A link plan read committed state.');
  const data = wireValue(output.result, selected.result, named);
  let rows = data.rows,
    total = data.total;
  const c = consumer && consumers.get(consumer);
  if ((plan.where || plan.aggregate?.value) && !c) throw Error('Consumer code is not loaded.');
  const call = (name, row) => c.module.callOwned(name, [native(row, c.functions[name].param, c.named)]);
  if (plan.where) rows = rows.filter((row) => call(plan.where, row) === true);
  if (plan.aggregate) {
    const op = plan.aggregate.op;
    if (op === 'count') total = { Some: BigInt(rows.length) };
    else {
      let value = null;
      for (const row of rows) {
        const x = BigInt(call(plan.aggregate.value, row));
        value = value === null ? x : op === 'sum' ? value + x : op === 'min' ? (x < value ? x : value) : x > value ? x : value;
        if (value > U64) throw Object.assign(Error('Link aggregate sum overflows u64'), { status: 422 });
      }
      total = op === 'sum' ? { Some: value ?? 0n } : value === null ? { None: null } : { Some: value };
    }
  } else if (plan.where) total = { Some: BigInt(rows.length) };
  const matched = rows.length,
    offset = plan.offset ?? 0;
  rows = rows.slice(offset, plan.limit === undefined ? undefined : offset + plan.limit);
  return {
    wire: stringifyExactJSON({ rows, total, version: data.version }),
    scanned: data.rows.length,
    matched,
    ms: performance.now() - started,
  };
}

parentPort.on('message', async (message) => {
  try {
    let value = true;
    if (message.op === 'load') {
      state = provider.createState();
      bindings = new Map();
      if (message.snapshot) await state.restore(new Uint8Array(Buffer.from(message.snapshot, 'base64')));
      replay(message.records || []);
    } else if (message.op === 'apply') replay(message.records);
    else if (message.op === 'consumer') {
      if (!consumers.has(message.id))
        consumers.set(message.id, {
          module: await load(message.javascript),
          functions: message.functions,
          named: message.named,
        });
    } else if (message.op === 'evaluate') value = evaluate(message);
    else throw Error('Unknown link worker operation.');
    parentPort.postMessage({ value });
  } catch (error) {
    parentPort.postMessage({ error: error.message, status: error.status });
  }
});
