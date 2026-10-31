import { stringifyExactJSON } from './exact-json.mjs';

const bits = new DataView(new ArrayBuffer(8));
export function wireValue(value, type, named = {}, depth = 0) {
  if (depth > 128) throw Error('Ink value nesting exceeds 128 levels.');
  const next = (value, type) => wireValue(value, type, named, depth + 1);
  switch (type.kind) {
    case 'f32': {
      if (value && typeof value === 'object' && Object.hasOwn(value, 'F32Bits')) return { F32Bits: Number(value.F32Bits) };
      bits.setFloat32(0, Number(value), true); return { F32Bits: bits.getUint32(0, true) };
    }
    case 'f64': {
      if (value && typeof value === 'object' && Object.hasOwn(value, 'F64Bits')) return { F64Bits: String(value.F64Bits) };
      bits.setFloat64(0, Number(value), true); return { F64Bits: bits.getBigUint64(0, true).toString() };
    }
    case 'u32': case 'i32': return Number(value);
    case 'u64': case 'i64': return BigInt(value);
    case 'int': return { Int: String(value && typeof value === 'object' && Object.hasOwn(value, 'Int') ? value.Int : value) };
    case 'list': case 'vector': return value.map(item => next(item, type.element));
    case 'record': return Object.fromEntries(type.fields.map(field => [field.name, next(value[field.name], field.type)]));
    case 'ref': {
      if (!named[type.name]) throw Error('Unknown Ink value type: ' + type.name);
      return next(value, named[type.name]);
    }
    case 'option': return Object.hasOwn(value, 'Some') ? { Some: next(value.Some, type.element) } : { None: null };
    case 'result': return Object.hasOwn(value, 'Ok') ? { Ok: next(value.Ok, type.ok) } : { Err: next(value.Err, type.error) };
    case 'unit': case 'bool': case 'string': case 'id': case 'enum': return value;
    default: throw Error('Unsupported public value descriptor: ' + type.kind);
  }
}

export function wireResult(output, entry, manifest) {
  if (!entry.action) return wireValue(output, entry.result, manifest.named_types);
  return {
    result: wireValue(output.result, entry.result, manifest.named_types), committed: output.committed,
    version: BigInt(output.version),
    events: output.events.map(event => {
      const type = manifest.state.events.find(type => type.name === event.channel);
      if (!type) throw Error('Unknown Ink event channel.');
      return { commit: BigInt(event.commit), position: Number(event.position), channel: event.channel, value: wireValue(event.value, type.type, manifest.named_types) };
    }),
  };
}

export function displayWire(wire) {
  return JSON.parse(wire, (_key, value, context) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source || '') ? context.source : value);
}
export function publicResult(output, entry, manifest) {
  const wire = stringifyExactJSON(wireResult(output, entry, manifest));
  return { wire, output: displayWire(wire) };
}
