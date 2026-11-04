import { parseExactJSON } from '../shared/exact-json.mjs';

export function native(value, type, named, depth = 0) {
  if (depth > 128) throw Error('Input nesting exceeds 128 levels.');
  switch (type.kind) {
    case 'u32':
    case 'i32':
      return Number(value);
    case 'u64':
    case 'i64':
      return BigInt(value);
    case 'int':
      return BigInt(value.Int);
    case 'f32':
      return value && typeof value === 'object'
        ? { F32Bits: Number(value.F32Bits) }
        : Number(value);
    case 'f64':
      return value && typeof value === 'object'
        ? { F64Bits: String(value.F64Bits) }
        : Number(value);
    case 'list':
    case 'vector':
      return value.map((item) => native(item, type.element, named, depth + 1));
    case 'record':
      return Object.fromEntries(
        type.fields.map((field) => [
          field.name,
          native(value[field.name], field.type, named, depth + 1),
        ]),
      );
    case 'ref':
      return native(value, named[type.name], named, depth + 1);
    case 'option':
      return Object.hasOwn(value, 'Some')
        ? { Some: native(value.Some, type.element, named, depth + 1) }
        : { None: null };
    case 'result':
      return Object.hasOwn(value, 'Ok')
        ? { Ok: native(value.Ok, type.ok, named, depth + 1) }
        : { Err: native(value.Err, type.error, named, depth + 1) };
    case 'unit':
    case 'bool':
    case 'string':
    case 'id':
    case 'enum':
      return value;
    default:
      throw Error('Unsupported public value descriptor: ' + type.kind);
  }
}

// Typed arguments decoded without the compiler.
//
// The compiler's `prepare` checks an entry's JSON arguments against its
// declared types and returns them in canonical form. For inputs already in
// their plainest form this function makes the same decision and returns the
// same values `native()` makes of the canonical form; anything else returns
// null, and the caller asks the compiler, whose answer or error stands.
// `tests/ink-fast-arguments.test.mjs` compares both on a corpus of edge cases.
//
// Use it only for state actions: their bound entries round f32 inputs to
// binary32 on capture, so an f32 decimal passed through unrounded is the same
// input as its canonical spelling.
const MISS = Symbol('miss'),
  U32 = 0xffffffffn,
  I32_MIN = -0x80000000n,
  I32_MAX = 0x7fffffffn,
  U64 = (1n << 64n) - 1n,
  MAX_INPUT = 1024 * 1024,
  INT = /^-?(?:0|[1-9][0-9]*)$/,
  ID = /^[0-9a-fA-F]{32}$/,
  // The compiler reads an integer token -0 as the float -0.0.
  NEGATIVE_ZERO = /-0(?![.eE])/,
  VECTOR_ELEMENTS = new Set(['u32', 'i32', 'u64', 'f32', 'f64', 'bool', 'vector']);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value) => (typeof value === 'number' || typeof value === 'bigint' ? Number(value) : NaN);

function typed(value, type, named, depth) {
  if (depth > 64 || !type) return MISS;
  switch (type.kind) {
    case 'unit':
      return value === null ? null : MISS;
    case 'bool':
      return typeof value === 'boolean' ? value : MISS;
    case 'u32':
      return typeof value === 'bigint' && value >= 0n && value <= U32 ? Number(value) : MISS;
    case 'i32':
      return typeof value === 'bigint' && value >= I32_MIN && value <= I32_MAX ? Number(value) : MISS;
    case 'u64':
      return typeof value === 'bigint' && value >= 0n && value <= U64 ? value : MISS;
    case 'int': {
      if (!plain(value) || Object.keys(value).length !== 1 || typeof value.Int !== 'string' || !INT.test(value.Int))
        return MISS;
      return BigInt(value.Int);
    }
    case 'f32': {
      const n = number(value);
      return Number.isFinite(Math.fround(n)) ? n : MISS;
    }
    case 'f64': {
      const n = number(value);
      return Number.isFinite(n) ? n : MISS;
    }
    case 'string':
      return typeof value === 'string' && value.isWellFormed() ? value : MISS;
    case 'id':
      return typeof value === 'string' && ID.test(value) ? value.toLowerCase() : MISS;
    case 'enum':
      return typeof value === 'string' && type.variants.includes(value) ? value : MISS;
    case 'vector':
      if (!Array.isArray(value) || value.length !== type.size || !VECTOR_ELEMENTS.has(type.element?.kind)) return MISS;
    // falls through
    case 'list': {
      if (!Array.isArray(value)) return MISS;
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const item = typed(value[i], type.element, named, depth + 1);
        if (item === MISS) return MISS;
        out[i] = item;
      }
      return out;
    }
    case 'record': {
      if (!plain(value) || Object.keys(value).length !== type.fields.length) return MISS;
      const out = {};
      for (const field of type.fields) {
        if (!Object.hasOwn(value, field.name)) return MISS;
        const item = typed(value[field.name], field.type, named, depth + 1);
        if (item === MISS) return MISS;
        out[field.name] = item;
      }
      return out;
    }
    case 'ref':
      return typed(value, named?.[type.name], named, depth + 1);
    case 'option': {
      if (!plain(value)) return MISS;
      const keys = Object.keys(value);
      if (keys.length !== 1) return MISS;
      if (keys[0] === 'None') return value.None === null ? { None: null } : MISS;
      if (keys[0] !== 'Some') return MISS;
      const item = typed(value.Some, type.element, named, depth + 1);
      return item === MISS ? MISS : { Some: item };
    }
    case 'result': {
      if (!plain(value)) return MISS;
      const keys = Object.keys(value);
      if (keys.length !== 1 || (keys[0] !== 'Ok' && keys[0] !== 'Err')) return MISS;
      const item = typed(value[keys[0]], keys[0] === 'Ok' ? type.ok : type.error, named, depth + 1);
      return item === MISS ? MISS : { [keys[0]]: item };
    }
    default:
      return MISS;
  }
}

/** Native arguments for a state action, or null to ask the compiler. */
export function fastArguments(input, params, named) {
  if (typeof input !== 'string' || input.length > MAX_INPUT || Buffer.byteLength(input) > MAX_INPUT) return null;
  if (NEGATIVE_ZERO.test(input)) return null;
  let values;
  try {
    values = parseExactJSON(input);
  } catch {
    return null;
  }
  if (!Array.isArray(values) || values.length !== params.length) return null;
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = typed(values[i], params[i].type, named, 0);
    if (value === MISS) return null;
    out[i] = value;
  }
  return out;
}
