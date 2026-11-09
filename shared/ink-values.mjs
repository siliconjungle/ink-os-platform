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
  const codec = entryCodec(entry, manifest);
  if (codec) return { wire: codec.write(output), output: codec.display(output) };
  const wire = stringifyExactJSON(wireResult(output, entry, manifest));
  return { wire, output: displayWire(wire) };
}

// Type-specialised result encoding.
//
// publicResult used to build the wire structure (wireValue), stringify it
// (stringifyExactJSON) and parse it again with a reviver (displayWire): three
// generic passes over every value. For each value type we now generate one
// function that writes the same exact JSON text and one that builds the same
// display value directly. Types that are recursive, deeply nested or have a
// field named __proto__ keep the generic path. tests/ink-values.test.mjs
// compares both paths.
const MAX_SPECIALISED_DEPTH = 100;
function encodeNumber(value) {
  if (!Number.isFinite(value)) throw new RangeError('JSON numbers must be finite');
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    const s = String(value);
    return /[.eE]/.test(s) ? s : s + '.0';
  }
  return Object.is(value, -0) ? '-0.0' : String(value);
}
const encodeScalar = (value) =>
  typeof value === 'string' ? JSON.stringify(value) : value === null ? 'null' : typeof value === 'boolean' ? (value ? 'true' : 'false') : stringifyExactJSON(value);
const displayBig = (value) => (value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value.toString());
const f32Bits = (value) => {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'F32Bits')) return Number(value.F32Bits);
  bits.setFloat32(0, Number(value), true);
  return bits.getUint32(0, true);
};
const f64Bits = (value) => {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'F64Bits')) return String(value.F64Bits);
  bits.setFloat64(0, Number(value), true);
  return bits.getBigUint64(0, true).toString();
};
const intText = (value) => String(value && typeof value === 'object' && Object.hasOwn(value, 'Int') ? value.Int : value);
const dense = (value, i) => {
  if (Array.isArray(value) && !Object.hasOwn(value, i)) throw new TypeError('Sparse JSON array');
};
const HELPERS = { encodeNumber, encodeScalar, displayBig, f32Bits, f64Bits, intText, dense, BigInt, Number, String, JSON, Object };

function generate(root, named) {
  const out = [],
    ids = new Map();
  let failed = false;
  // One write function (w) and one display function (d) per type node.
  const node = (type, depth, active) => {
    if (failed) return 0;
    if (depth > MAX_SPECIALISED_DEPTH) return void (failed = true), 0;
    if (type.kind === 'ref') {
      if (active.has(type.name) || !named[type.name]) return void (failed = true), 0;
      return node(named[type.name], depth + 1, new Set([...active, type.name]));
    }
    const key = JSON.stringify(type) + '@' + depth;
    if (ids.has(key)) return ids.get(key);
    const id = ids.size;
    ids.set(key, id);
    let w, d;
    switch (type.kind) {
      case 'f32':
        w = `return '{"F32Bits":'+encodeNumber(f32Bits(v))+'}';`;
        d = `return {F32Bits:f32Bits(v)};`;
        break;
      case 'f64':
        w = `return '{"F64Bits":'+JSON.stringify(f64Bits(v))+'}';`;
        d = `return {F64Bits:f64Bits(v)};`;
        break;
      case 'u32':
      case 'i32':
        w = `return encodeNumber(Number(v));`;
        d = `const n=Number(v);encodeNumber(n);return n;`;
        break;
      case 'u64':
      case 'i64':
        w = `return BigInt(v).toString();`;
        d = `return displayBig(BigInt(v));`;
        break;
      case 'int':
        w = `return '{"Int":'+JSON.stringify(intText(v))+'}';`;
        d = `return {Int:intText(v)};`;
        break;
      case 'list':
      case 'vector': {
        const e = node(type.element, depth + 1, active);
        w = `const n=v.length;let s='[';for(let i=0;i<n;i++){dense(v,i);if(i)s+=',';s+=w${e}(v[i]);}return s+']';`;
        d = `const n=v.length,a=new Array(n);for(let i=0;i<n;i++){dense(v,i);a[i]=d${e}(v[i]);}return a;`;
        break;
      }
      case 'record': {
        if (type.fields.some((f) => f.name === '__proto__')) return void (failed = true), 0;
        const fields = type.fields.map((f) => [f.name, node(f.type, depth + 1, active)]);
        w = `return '{'${fields.map(([name, e], i) => `+${JSON.stringify((i ? ',' : '') + JSON.stringify(name) + ':')}+w${e}(v[${JSON.stringify(name)}])`).join('')}+'}';`;
        d = `return {${fields.map(([name, e]) => `${JSON.stringify(name)}:d${e}(v[${JSON.stringify(name)}])`).join(',')}};`;
        break;
      }
      case 'option': {
        const e = node(type.element, depth + 1, active);
        w = `return Object.hasOwn(v,'Some')?'{"Some":'+w${e}(v.Some)+'}':'{"None":null}';`;
        d = `return Object.hasOwn(v,'Some')?{Some:d${e}(v.Some)}:{None:null};`;
        break;
      }
      case 'result': {
        const ok = node(type.ok, depth + 1, active),
          err = node(type.error, depth + 1, active);
        w = `return Object.hasOwn(v,'Ok')?'{"Ok":'+w${ok}(v.Ok)+'}':'{"Err":'+w${err}(v.Err)+'}';`;
        d = `return Object.hasOwn(v,'Ok')?{Ok:d${ok}(v.Ok)}:{Err:d${err}(v.Err)};`;
        break;
      }
      case 'unit':
      case 'bool':
      case 'string':
      case 'id':
      case 'enum':
        w = `return encodeScalar(v);`;
        d = `encodeScalar(v);return v;`;
        break;
      default:
        failed = true;
        return 0;
    }
    out.push(`function w${id}(v){${w}}`, `function d${id}(v){${d}}`);
    return id;
  };
  const top = node(root, 0, new Set());
  if (failed) return null;
  return { code: out.join('\n'), top };
}

// Codecs per named-type table, by type object and then by type structure.
const codecs = new WeakMap();
/** A generated {write, display} pair for values of this type, or null. */
export function valueCodec(type, named = {}) {
  let cache = codecs.get(named);
  if (!cache) codecs.set(named, (cache = { objects: new WeakMap(), keys: new Map() }));
  if (cache.objects.has(type)) return cache.objects.get(type);
  const key = JSON.stringify(type);
  if (!cache.keys.has(key)) {
    const plan = generate(type, named);
    cache.keys.set(
      key,
      plan ? new Function(...Object.keys(HELPERS), `${plan.code}\nreturn {write:w${plan.top},display:d${plan.top}};`)(...Object.values(HELPERS)) : null,
    );
  }
  const codec = cache.keys.get(key);
  cache.objects.set(type, codec);
  return codec;
}

const entryCodecs = new WeakMap();
function entryCodec(entry, manifest) {
  if (entryCodecs.has(entry)) return entryCodecs.get(entry);
  const named = manifest.named_types || {},
    result = valueCodec(entry.result, named);
  let codec = null;
  if (result && !entry.action) codec = result;
  else if (result) {
    const channels = new Map();
    for (const type of manifest.state?.events || []) {
      const c = valueCodec(type.type, named);
      if (!c) return entryCodecs.set(entry, null), null;
      channels.set(type.name, c);
    }
    const channel = (event) => {
      const c = channels.get(event.channel);
      if (!c) throw Error('Unknown Ink event channel.');
      return c;
    };
    codec = {
      write(output) {
        let events = '[';
        for (let i = 0; i < output.events.length; i++) {
          const event = output.events[i];
          const value = channel(event).write(event.value);
          if (i) events += ',';
          events += '{"commit":' + BigInt(event.commit).toString() + ',"position":' + encodeNumber(Number(event.position)) + ',"channel":' + encodeScalar(event.channel) + ',"value":' + value + '}';
        }
        return '{"result":' + result.write(output.result) + ',"committed":' + encodeScalar(output.committed) + ',"version":' + BigInt(output.version).toString() + ',"events":' + events + ']}';
      },
      display(output) {
        return {
          result: result.display(output.result),
          committed: output.committed,
          version: displayBig(BigInt(output.version)),
          events: output.events.map((event) => {
            const value = channel(event).display(event.value);
            return { commit: displayBig(BigInt(event.commit)), position: Number(event.position), channel: event.channel, value };
          }),
        };
      },
    };
  }
  entryCodecs.set(entry, codec);
  return codec;
}

/** The exact JSON wire of a value of this type (generated when possible). */
export function exactWire(value, type, named = {}) {
  const codec = valueCodec(type, named);
  return codec ? codec.write(value) : stringifyExactJSON(wireValue(value, type, named));
}

/** The exact JSON wire of an entry's result alone (no display value). */
export function resultWire(output, entry, manifest) {
  const codec = entryCodec(entry, manifest);
  return codec ? codec.write(output) : stringifyExactJSON(wireResult(output, entry, manifest));
}
