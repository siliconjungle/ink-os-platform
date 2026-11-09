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
import { wireValue, exactWire, resultWire } from '../shared/ink-values.mjs';
import { native, fastArguments } from './ink-input.mjs';

const { artifact, entries } = workerData;
const load = (javascript) =>
  import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
const provider = await load(artifact.javascript);
provider.setParallelism?.(1);
const named = artifact.manifest.named_types;
// Instantiated only for inputs fastArguments leaves to the compiler.
let instance = null;
const compiler = () => (instance ??= new WebAssembly.Instance(workerData.compiler, {}).exports);
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
  const api = compiler(),
    pointer = api.ink_env_alloc(bytes.length);
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
  const args =
    fastArguments(input, selected.params, named) ||
    parseExactJSON(prepare(entry, input)).map((value, i) => native(value, selected.params[i].type, named));
  if (!bindings.has(entry)) bindings.set(entry, state.bind(entry));
  return { selected, output: bindings.get(entry)(...args) };
}
function replay(records) {
  for (const record of records) {
    const { selected, output } = invoke(record.entry, record.input);
    const wire = resultWire(output, selected, artifact.manifest);
    if (!output.committed || wire !== record.wire) {
      state = null;
      throw Error('Provider copy replay mismatch.');
    }
  }
}
const U64 = (1n << 64n) - 1n;
const resolve = (type, types) => (type.kind === 'ref' ? resolve(types[type.name], types) : type);
// Consumer function results, reused row by row. A pure function's result
// depends only on the parameter fields admission found it reads
// (paramFields), so rows that agree on them share one call. Each memo holds
// at most what the last few evaluations needed.
const memos = new Map(),
  MEMO_LIMIT = 262144;
function fieldKey(value, type) {
  switch (type.kind) {
    case 'u32': case 'i32': case 'u64': case 'i64': case 'bool': case 'unit':
      return String(value);
    case 'string': case 'id': case 'enum':
      return JSON.stringify(value);
    default:
      return exactWire(value, type, named);
  }
}
function memoized(c, consumer, name, rowType) {
  const fn = c.functions[name],
    record = rowType.kind === 'record' ? rowType : null,
    fields = record && fn.fields ? fn.fields.map((f) => [f, record.fields.find((x) => x.name === f)?.type]) : null,
    key =
      fields && fields.every(([, type]) => type)
        ? fields.length === 1
          ? (row) => fieldKey(row[fields[0][0]], resolve(fields[0][1], named))
          : (row) => fields.map(([f, type]) => fieldKey(row[f], resolve(type, named))).join('\u0001')
        : (row) => exactWire(row, rowType, named),
    id = consumer + '\0' + name;
  let memo = memos.get(id);
  if (!memo) memos.set(id, (memo = new Map()));
  if (memo.size > MEMO_LIMIT) memo.clear();
  return (row) => {
    const k = key(row);
    let result = memo.get(k);
    if (result === undefined) {
      result = c.module.callOwned(name, [native(wireValue(row, rowType, named), fn.param, c.named)]);
      memo.set(k, result);
      counts.calls++;
    } else counts.reused++;
    return result;
  };
}
const counts = { calls: 0, reused: 0 };
function evaluate({ entry, input, plan, consumer }) {
  const started = performance.now(),
    { selected, output } = invoke(entry, input);
  if (output.committed) throw Error('A link plan read committed state.');
  // Rows stay native; only the fields a consumer function reads, and the
  // selected page, are converted.
  const dataType = resolve(selected.result, named),
    field = (name) => dataType.fields.find((f) => f.name === name).type,
    rowType = resolve(field('rows').element, named),
    value = output.result,
    all = value.rows;
  const c = consumer && consumers.get(consumer);
  if ((plan.where || plan.aggregate?.value) && !c) throw Error('Consumer code is not loaded.');
  const before = { ...counts };
  let rows = all,
    total = wireValue(value.total, field('total'), named);
  if (plan.where) {
    const test = memoized(c, consumer, plan.where, rowType);
    rows = all.filter((row) => test(row) === true);
  }
  if (plan.aggregate) {
    const op = plan.aggregate.op;
    if (op === 'count') total = { Some: BigInt(rows.length) };
    else {
      const of = memoized(c, consumer, plan.aggregate.value, rowType);
      let result = null;
      for (const row of rows) {
        const x = BigInt(of(row));
        result = result === null ? x : op === 'sum' ? result + x : op === 'min' ? (x < result ? x : result) : x > result ? x : result;
        if (result > U64) throw Object.assign(Error('Link aggregate sum overflows u64'), { status: 422 });
      }
      total = op === 'sum' ? { Some: result ?? 0n } : result === null ? { None: null } : { Some: result };
    }
  } else if (plan.where) total = { Some: BigInt(rows.length) };
  const matched = rows.length,
    offset = plan.offset ?? 0,
    page = rows.slice(offset, plan.limit === undefined ? undefined : offset + plan.limit);
  let pageWire = '';
  for (let i = 0; i < page.length; i++) pageWire += (i ? ',' : '') + exactWire(page[i], rowType, named);
  return {
    // The same text as stringifyExactJSON({ rows, total, version }) over wire values.
    wire: '{"rows":[' + pageWire + '],"total":' + stringifyExactJSON(total) + ',"version":' + exactWire(value.version, field('version'), named) + '}',
    scanned: all.length,
    matched,
    calls: counts.calls - before.calls,
    reused: counts.reused - before.reused,
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
