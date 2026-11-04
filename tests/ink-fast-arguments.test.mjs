// The resident and link workers decode plainly typed action arguments in
// JavaScript (fastArguments) instead of asking the compiler's `prepare`. Any
// input fastArguments accepts must be one the compiler accepts, with the same
// values; anything else must be left to the compiler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileInkProgram, compilerModule } from '../server/ink-compiler.mjs';
import { fastArguments, native } from '../server/ink-input.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';

const SOURCE = `module app;
enum Color { Red, Green, }
id Key;
record Inner {n:u32,s:String,}
record R {a:u32,b:i32,c:u64,d:String,e:Bool,f:Color,g:Option<u64>,h:List<u32>,i:f32,k:Result<u32,String>,m:List<Inner>,}
state N:u64=0;
change put(r:R,x:f64,u:Unit,y:f32,z:Int,key:Key,v:Vec3<f32>,o:Option<Inner>)->u64 reads(N) writes(N){N=N+1;return N;}
query small(a:u32,b:i32,c:u64,d:Bool)->u64 reads(N){return N;}
`;

async function compiler(artifact) {
  const api = new WebAssembly.Instance((await compilerModule()).module, {}).exports;
  let checked = false;
  return (entry, input) => {
    const bytes = Buffer.from(
      JSON.stringify({ op: 'prepare', ...(checked ? {} : { core: artifact.core }), identity: artifact.manifest.core_sha256, entry, input }),
    );
    const pointer = api.ink_env_alloc(bytes.length);
    try {
      new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
      const result = api.ink_env_request(pointer, bytes.length),
        response = JSON.parse(Buffer.from(api.memory.buffer, result, api.ink_env_response_len()).toString());
      if (response.error) return { error: response.error };
      checked = true;
      return { input: response.ok.input };
    } finally {
      api.ink_env_free(pointer, bytes.length);
    }
  };
}

const resolve = (type, named) => (type.kind === 'ref' ? resolve(named[type.name], named) : type);
// Equal as the runtime receives them: action entries round f32 to binary32.
function same(a, b, type, named, path) {
  type = resolve(type, named);
  switch (type.kind) {
    case 'f32':
      return assert.ok(Object.is(Math.fround(a), Math.fround(b)), path + ': ' + a + ' vs ' + b);
    case 'list':
    case 'vector':
      assert.equal(a.length, b.length, path);
      return a.forEach((x, i) => same(x, b[i], type.element, named, path + '[' + i + ']'));
    case 'record':
      assert.deepEqual(Object.keys(a), Object.keys(b), path);
      return type.fields.forEach((f) => same(a[f.name], b[f.name], f.type, named, path + '.' + f.name));
    case 'option':
      assert.deepEqual(Object.keys(a), Object.keys(b), path);
      return 'Some' in a ? same(a.Some, b.Some, type.element, named, path + '.Some') : assert.deepEqual(a, b, path);
    case 'result':
      assert.deepEqual(Object.keys(a), Object.keys(b), path);
      return 'Ok' in a ? same(a.Ok, b.Ok, type.ok, named, path + '.Ok') : same(a.Err, b.Err, type.error, named, path + '.Err');
    default:
      return assert.ok(Object.is(a, b) || a === b, path + ': ' + String(a) + ' vs ' + String(b));
  }
}

// A small deterministic generator of values near each type's edges.
function generator(seed) {
  let s = seed >>> 0;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296),
    pick = (xs) => xs[Math.floor(next() * xs.length)];
  const value = (type, named, depth = 0) => {
    type = resolve(type, named);
    switch (type.kind) {
      case 'unit': return null;
      case 'bool': return next() < 0.5;
      case 'u32': return pick([0n, 1n, 7n, 4294967295n, 2147483648n]);
      case 'i32': return pick([0n, -1n, 2147483647n, -2147483648n, 42n]);
      case 'u64': return pick([0n, 1n, 18446744073709551615n, 9007199254740993n]);
      case 'int': return { Int: pick(['0', '-17', '123456789012345678901234567890', '5']) };
      case 'f32': return pick([0.1, 1.5, -2.25, 3, 16777217n, 3.4e38, 1e-45, -0.0, 0.3333333333]);
      case 'f64': return pick([0.1, 1e21, -0.0, 5e-324, 1.7976931348623157e308, 12345678901234567890n, 2.5]);
      case 'string': return pick(['', 'x', 'é ', '"quoted"\n', '😀', 'tab\t']);
      case 'id': return pick(['0123456789abcdef0123456789abcdef', 'ABCDEF0123456789ABCDEF0123456789']);
      case 'enum': return pick(type.variants);
      case 'vector': return Array.from({ length: type.size }, () => value(type.element, named, depth + 1));
      case 'list': return Array.from({ length: depth > 2 ? 0 : Math.floor(next() * 3) }, () => value(type.element, named, depth + 1));
      case 'record': return Object.fromEntries(type.fields.map((f) => [f.name, value(f.type, named, depth + 1)]));
      case 'option': return next() < 0.5 ? { None: null } : { Some: value(type.element, named, depth + 1) };
      case 'result': return next() < 0.5 ? { Ok: value(type.ok, named, depth + 1) } : { Err: value(type.error, named, depth + 1) };
      default: throw Error(type.kind);
    }
  };
  // Replace one nested value with something near, but not of, its type.
  const mutate = (v) => {
    const wrong = pick([null, true, 1n, -1n, 1.5, 4294967296n, 18446744073709551616n, 'x', [], {}, { Some: 1n, None: null }, { Int: '+5' }, { F32Bits: 0n }]);
    if (Array.isArray(v)) return v.length ? v.map((x, i) => (i === 0 ? mutate(x) : x)) : [wrong];
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length || next() < 0.25) return { ...v, extra: wrong };
      const k = pick(keys);
      return next() < 0.2 ? Object.fromEntries(keys.filter((x) => x !== k).map((x) => [x, v[x]])) : { ...v, [k]: mutate(v[k]) };
    }
    return wrong;
  };
  return { value, mutate, next, pick };
}

test('fast argument decoding agrees with the compiler or defers to it', async () => {
  const artifact = await compileInkProgram(SOURCE),
    prepare = await compiler(artifact),
    named = artifact.manifest.named_types,
    actions = artifact.manifest.state.actions.filter((a) => ['put', 'small'].includes(a.name));
  const cases = [];
  // Hand-written edges: spellings the compiler accepts that are not plain,
  // and tokens whose meaning differs between JSON readers.
  cases.push(
    ['small', '[-0,0,0,true]'],
    ['small', '[0,-0,0,true]'],
    ['small', '[1.0,0,0,true]'],
    ['small', '[1e2,0,0,true]'],
    ['small', '[4294967296,0,0,true]'],
    ['small', '[0,2147483648,0,true]'],
    ['small', '[0,-2147483649,0,true]'],
    ['small', '[0,0,18446744073709551616,true]'],
    ['small', '[0,0,0,"true"]'],
    ['small', '[0,0,0]'],
    ['small', '[0,0,0,true,1]'],
    ['small', ' [ 1 , 2 , 3 , false ] '],
    ['small', '[1,2,3,false]x'],
    ['small', '{"0":1}'],
    ['small', '[01,0,0,true]'],
    ['small', '﻿[0,0,0,true]'],
  );
  const base = {
    r: { a: 1n, b: -2n, c: 3n, d: 'x', e: true, f: 'Color.Green', g: { None: null }, h: [], i: 1.5, k: { Ok: 4n }, m: [] },
    x: 2.5, u: null, y: 0.1, z: { Int: '5' }, key: '0123456789abcdef0123456789abcdef', v: [1, 2, 3], o: { None: null },
  };
  const put = (patch) => ['put', stringifyExactJSON(Object.values({ ...base, ...patch }))];
  cases.push(
    put({}),
    put({ x: -0.0 }),
    put({ y: 3.5e38 }),
    put({ y: 1e39 }),
    put({ y: { F32Bits: 2143289344n } }),
    put({ x: { F64Bits: '9221120237041090560' } }),
    put({ x: { F64Bits: '4607182418800017408' } }),
    put({ z: { Int: '-0' } }),
    put({ z: { Int: '+5' } }),
    put({ z: { Int: '05' } }),
    put({ z: { Int: '5', x: 1n } }),
    put({ z: 5n }),
    put({ key: 'ABCDEF0123456789ABCDEF0123456789' }),
    put({ key: '0123456789abcdef0123456789abcde' }),
    put({ v: [1, 2] }),
    put({ v: [1n, 2n, 3n] }),
    put({ o: { Some: { n: 1n, s: 'y' } } }),
    put({ o: { Some: { n: 1n, s: 'y', t: 1n } } }),
    put({ r: { ...base.r, f: 'Green' } }),
    put({ r: { ...base.r, f: 'Color.Blue' } }),
    put({ r: { ...base.r, g: { None: 0n } } }),
    put({ r: { ...base.r, k: { Ok: 1n, Err: 'x' } } }),
  );
  // Strings the readers decode differently, spelled out by hand.
  const raw = (text) => ['put', put({}).at(1).replace('"x"', text)];
  cases.push(raw('"\\ud800"'), raw('"\\udc00x"'), raw('"\\ud83d\\ude00"'), raw('"\\u0000"'), raw('"a\\/b"'));
  // Duplicate keys: the last one wins in both readers.
  cases.push(['put', put({}).at(1).replace('"a":1,', '"a":7,"a":1,')]);
  // Seeded random values, half of them mutated.
  for (let seed = 1; seed <= 400; seed++) {
    const g = generator(seed),
      action = g.pick(actions);
    let args = action.params.map((p) => g.value(p.type, named));
    if (seed % 2) args = args.map((x, i) => (i === seed % args.length ? g.mutate(x) : x));
    cases.push([action.name, stringifyExactJSON(args), !(seed % 2)]);
  }

  let fast = 0,
    deferred = 0;
  for (const [entry, input, plain] of cases) {
    const action = actions.find((a) => a.name === entry),
      mine = fastArguments(input, action.params, named),
      theirs = prepare(entry, input);
    // Well-typed values written by stringifyExactJSON, as callers send them, take the fast path.
    if (plain) assert.ok(mine, `${entry} ${input}: plain input deferred`);
    if (mine === null) {
      deferred++;
      continue;
    }
    fast++;
    assert.ok(theirs.input, `${entry} ${input}: fast path accepted what the compiler rejects (${theirs.error})`);
    const expected = parseExactJSON(theirs.input).map((v, i) => native(v, action.params[i].type, named));
    action.params.forEach((p, i) => same(mine[i], expected[i], p.type, named, `${entry} ${input} ${p.name}`));
  }
  // The plain, well-typed inputs real callers send take the fast path.
  assert.ok(fastArguments(put({})[1], actions[0].params, named));
  assert.ok(fast > 150, 'fast ' + fast);
  assert.ok(deferred > 100, 'deferred ' + deferred);
});
