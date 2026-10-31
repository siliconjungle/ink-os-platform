import { parentPort, workerData } from 'node:worker_threads';
import { parseExactJSON } from '../shared/exact-json.mjs';
import { publicResult } from '../shared/ink-values.mjs';

function native(value, type, named, depth = 0) {
  if (depth > 128) throw Error('Input nesting exceeds 128 levels.');
  switch (type.kind) {
    case 'u32': case 'i32': return Number(value);
    case 'u64': case 'i64': return BigInt(value);
    case 'int': return BigInt(value.Int);
    case 'f32': return value && typeof value === 'object' ? { F32Bits: Number(value.F32Bits) } : Number(value);
    case 'f64': return value && typeof value === 'object' ? { F64Bits: String(value.F64Bits) } : Number(value);
    case 'list': case 'vector': return value.map(item => native(item, type.element, named, depth + 1));
    case 'record': return Object.fromEntries(type.fields.map(field => [field.name, native(value[field.name], field.type, named, depth + 1)]));
    case 'ref': return native(value, named[type.name], named, depth + 1);
    case 'option': return Object.hasOwn(value, 'Some') ? { Some: native(value.Some, type.element, named, depth + 1) } : { None: null };
    case 'result': return Object.hasOwn(value, 'Ok') ? { Ok: native(value.Ok, type.ok, named, depth + 1) } : { Err: native(value.Err, type.error, named, depth + 1) };
    case 'unit': case 'bool': case 'string': case 'id': case 'enum': return value;
    default: throw Error('Unsupported public value descriptor: ' + type.kind);
  }
}
try {
  const { artifact, selected, input, snapshot } = workerData;
  const module = await import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));
  const args = parseExactJSON(input).map((value, index) => native(value, selected.params[index].type, module.metadata.named_types));
  let output, next;
  if (selected.action) {
    const state = module.createState();
    if (snapshot) await state.restore(new Uint8Array(Buffer.from(snapshot, 'base64')));
    output = state.invoke(selected.name, args);
    if (output.committed) next = Buffer.from(await state.checkpoint()).toString('base64');
  } else output = selected.parallel ? await module.callAsync(selected.name, args) : module.callOwned(selected.name, args);
  const { wire, output: display } = publicResult(output, selected, artifact.manifest);
  if (Buffer.byteLength(wire) > 8 * 1024 * 1024) throw Error('Ink output exceeds 8 MiB.');
  parentPort.postMessage({ value: { output: display, wire, snapshot: next, committed: !!next } });
} catch (error) { parentPort.postMessage({ error: error.message }); }
