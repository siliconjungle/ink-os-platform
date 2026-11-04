import { parentPort, workerData } from 'node:worker_threads';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { proofPlan } from './ink-proof-plan.mjs';
const wire = new Map();
const instance = await WebAssembly.instantiate(workerData.module, {}),
  api = instance.exports;
function call(request, stats) {
  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > 16 * 1024 * 1024)
    throw Error('Compiler request exceeds 16 MiB');
  stats.kernelRequestBytes += bytes.length;
  const pointer = api.ink_env_alloc(bytes.length);
  if (!pointer) throw Error('Compiler request allocation failed');
  try {
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    const result = api.ink_env_request(pointer, bytes.length),
      length = api.ink_env_response_len();
    if (length > 32 * 1024 * 1024)
      throw Error('Compiler response exceeds 32 MiB');
    stats.kernelResponseBytes += length;
    const response = JSON.parse(
      Buffer.from(api.memory.buffer, result, length).toString(),
    );
    if (response.error) throw Error(response.error);
    return response.ok;
  } finally {
    api.ink_env_free(pointer, bytes.length);
  }
}
const sameUnit = (a, b) =>
  a &&
  a.bytes === b.bytes &&
  a.brotli === b.brotli &&
  a.dependencies.length === b.dependencies.length &&
  a.dependencies.every((id, i) => id === b.dependencies[i]);
parentPort.on('message', ({ id, request }) => {
  const started = process.hrtime.bigint(),
    stats = {
      checked: 0,
      reused: 0,
      expandedBytes: 0,
      units: 0,
      wasmBytes: 0,
      kernelRequestBytes: 0,
      kernelResponseBytes: 0,
      timingNS: {
        parse: 0,
        status: 0,
        reuse: 0,
        decode: 0,
        admit: 0,
        compose: 0,
        total: 0,
      },
    };
  const timed = (phase, run) => {
    const begin = process.hrtime.bigint();
    try {
      return run();
    } finally {
      stats.timingNS[phase] += Number(process.hrtime.bigint() - begin);
    }
  };
  const finish = (message) => {
    stats.wasmBytes = api.memory.buffer.byteLength;
    stats.timingNS.total = Number(process.hrtime.bigint() - started);
    parentPort.postMessage({ id, ...message, stats });
  };
  try {
    const envelope = timed('parse', () => proofPlan(request.plan));
    if (!envelope) throw Error('A bounded proof unit envelope is required');
    const ids = Object.keys(envelope.units);
    stats.units = ids.length;
    const status = timed('status', () =>
        call({ op: 'proofUnits', ids }, stats),
      ),
      present = new Set(status.present),
      active = new Set();
    if (
      status.bytes +
        ids
          .filter((id) => !present.has(id))
          .reduce((sum, id) => sum + envelope.units[id].bytes, 0) >
      32 * 1024 * 1024
    )
      throw Error('Proof unit capacity exceeded; replay in a fresh session');
    timed('reuse', () => {
      for (const id of present)
        if (!sameUnit(wire.get(id), envelope.units[id]))
          throw Error('Proof unit encoding changed; replay in a fresh session');
    });
    stats.reused = present.size;
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
        const object = timed('decode', () => {
          const bytes = brotliDecompressSync(
            Buffer.from(unit.brotli, 'base64'),
            { maxOutputLength: unit.bytes },
          );
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
          return object;
        });
        timed('admit', () => call({ op: 'admitProofUnit', id, object }, stats));
        stats.checked++;
        stats.expandedBytes += unit.bytes;
        present.add(id);
        active.delete(id);
        // Keep immutable fields without copying the complete compressed payload
        // into a second JSON string. Property order is not mathematical meaning.
        wire.set(id, {
          bytes: unit.bytes,
          dependencies: [...unit.dependencies],
          brotli: unit.brotli,
        });
      }
    }
    const value = timed('compose', () =>
      call({ ...request, plan: envelope.plan }, stats),
    );
    finish({ value });
  } catch (error) {
    finish({ error: error.message });
  }
});
