import { parentPort, workerData } from 'node:worker_threads';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { proofPlan } from './ink-proof-plan.mjs';
const wire = new Map();
const instance = await WebAssembly.instantiate(workerData.module, {}),
  api = instance.exports;
function call(request) {
  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > 16 * 1024 * 1024)
    throw Error('Compiler request exceeds 16 MiB');
  const pointer = api.ink_env_alloc(bytes.length);
  if (!pointer) throw Error('Compiler request allocation failed');
  try {
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    const result = api.ink_env_request(pointer, bytes.length),
      length = api.ink_env_response_len();
    if (length > 32 * 1024 * 1024)
      throw Error('Compiler response exceeds 32 MiB');
    const response = JSON.parse(
      Buffer.from(api.memory.buffer, result, length).toString(),
    );
    if (response.error) throw Error(response.error);
    return response.ok;
  } finally {
    api.ink_env_free(pointer, bytes.length);
  }
}
parentPort.on('message', ({ id, request }) => {
  try {
    const envelope = proofPlan(request.plan);
    if (!envelope) throw Error('A bounded proof unit envelope is required');
    const ids = Object.keys(envelope.units),
      status = call({ op: 'proofUnits', ids }),
      present = new Set(status.present),
      active = new Set();
    let checked = 0,
      reused = ids.filter((id) => present.has(id)).length,
      expandedBytes = 0;
    if (
      status.bytes +
        ids
          .filter((id) => !present.has(id))
          .reduce((sum, id) => sum + envelope.units[id].bytes, 0) >
      32 * 1024 * 1024
    )
      throw Error('Proof unit capacity exceeded; replay in a fresh session');
    for (const id of present)
      if (wire.get(id) !== JSON.stringify(envelope.units[id]))
        throw Error('Proof unit encoding changed; replay in a fresh session');
    for (const root of ids) {
      const pending = [[root, false]];
      while (pending.length) {
        const [id, leaving] = pending.pop();
        if (present.has(id)) continue;
        const unit = envelope.units[id];
        if (!unit) throw Error('Missing proof unit dependency');
        if (!leaving) {
          if (active.has(id)) throw Error('Cyclic proof unit dependencies');
          active.add(id);
          pending.push([id, true]);
          for (const dependency of [...unit.dependencies].reverse())
            pending.push([dependency, false]);
          continue;
        }
        const bytes = brotliDecompressSync(Buffer.from(unit.brotli, 'base64'), {
          maxOutputLength: unit.bytes,
        });
        if (
          bytes.length !== unit.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== id
        )
          throw Error(
            'Proof unit bytes differ from their declaration identity',
          );
        const object = bytes.toString('utf8');
        if (!Buffer.from(object).equals(bytes))
          throw Error('Proof units must be exact UTF-8');
        call({ op: 'admitProofUnit', id, object });
        checked++;
        expandedBytes += bytes.length;
        present.add(id);
        active.delete(id);
        wire.set(id, JSON.stringify(unit));
      }
    }
    const value = call({ ...request, plan: envelope.plan });
    parentPort.postMessage({
      id,
      value,
      stats: {
        checked,
        reused,
        expandedBytes,
        units: ids.length,
        wasmBytes: api.memory.buffer.byteLength,
      },
    });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
