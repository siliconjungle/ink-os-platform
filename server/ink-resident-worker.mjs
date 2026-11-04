import { parentPort, workerData } from 'node:worker_threads';
import { parseExactJSON } from '../shared/exact-json.mjs';
import { publicResult } from '../shared/ink-values.mjs';
import { native } from './ink-input.mjs';

const { artifact, entries } = workerData;
const module = await import(
  'data:text/javascript;base64,' +
    Buffer.from(artifact.javascript).toString('base64')
);
// One admitted CPU lane owns this worker. Nested parallel_map keeps its
// literal ordered semantics with one worker instead of multiplying host lanes.
module.setParallelism?.(1);
const api = (await WebAssembly.instantiate(workerData.compiler, {})).exports;
let checked = false,
  state,
  bindings;
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
  if (bytes.length > 8 * 1024 * 1024)
    throw Error('Compiler request exceeds 8 MiB.');
  const pointer = api.ink_env_alloc(bytes.length);
  if (!pointer) throw Error('Compiler request allocation failed.');
  try {
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    const result = api.ink_env_request(pointer, bytes.length),
      length = api.ink_env_response_len();
    if (length > 16 * 1024 * 1024)
      throw Error('Compiler response exceeds 16 MiB.');
    const response = JSON.parse(
      Buffer.from(api.memory.buffer, result, length).toString(),
    );
    if (response.error) throw Error(response.error);
    checked = true;
    return response.ok.input;
  } finally {
    api.ink_env_free(pointer, bytes.length);
  }
}
async function call({ entry, input }) {
  const selected = entries.find((candidate) => candidate.name === entry);
  if (!selected) throw Error('Select an exported Ink entry.');
  const canonical = prepare(entry, input);
  const args = parseExactJSON(canonical).map((value, index) =>
    native(value, selected.params[index].type, module.metadata.named_types),
  );
  let result;
  if (selected.action) {
    if (!state) throw Error('Resident Ink state was not loaded.');
    if (!bindings.has(entry)) bindings.set(entry, state.bind(entry));
    result = bindings.get(entry)(...args);
  } else result = module.callOwned(entry, args);
  const visible = publicResult(result, selected, artifact.manifest);
  if (Buffer.byteLength(visible.wire) > 8 * 1024 * 1024)
    throw Error('Ink output exceeds 8 MiB.');
  return {
    ...visible,
    committed: !!selected.action && result.committed === true,
  };
}
parentPort.on('message', async (message) => {
  try {
    let result;
    if (message.op === 'load') {
      state = module.createState();
      bindings = new Map();
      if (message.snapshot)
        await state.restore(
          new Uint8Array(Buffer.from(message.snapshot, 'base64')),
        );
      for (const record of message.records || []) {
        const result = await call(record);
        if (!result.committed || result.wire !== record.wire)
          throw Error('Ink application journal replay mismatch.');
      }
      result = true;
    } else if (message.op === 'call') result = await call(message);
    else if (message.op === 'checkpoint')
      result = Buffer.from(await state.checkpoint()).toString('base64');
    else throw Error('Unknown resident Ink operation.');
    parentPort.postMessage({ value: result });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
