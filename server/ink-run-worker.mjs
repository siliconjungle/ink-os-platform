import { parentPort, workerData } from 'node:worker_threads';
import { parseExactJSON } from '../shared/exact-json.mjs';
import { publicResult } from '../shared/ink-values.mjs';

import { native } from './ink-input.mjs';

try {
  const { artifact, selected, input, snapshot } = workerData;
  const module = await import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));
  module.setParallelism?.(1);
  const args = parseExactJSON(input).map((value, index) => native(value, selected.params[index].type, module.metadata.named_types));
  let output, next;
  if (selected.action) {
    const state = module.createState();
    if (snapshot) await state.restore(new Uint8Array(Buffer.from(snapshot, 'base64')));
    output = state.invoke(selected.name, args);
    if (output.committed) next = Buffer.from(await state.checkpoint()).toString('base64');
  } else output = module.callOwned(selected.name, args);
  const { wire, output: display } = publicResult(output, selected, artifact.manifest);
  if (Buffer.byteLength(wire) > 8 * 1024 * 1024) throw Error('Ink output exceeds 8 MiB.');
  parentPort.postMessage({ value: { output: display, wire, snapshot: next, committed: !!next } });
} catch (error) { parentPort.postMessage({ error: error.message }); }
