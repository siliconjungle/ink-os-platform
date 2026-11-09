// publicResult and exactWire use encoders generated per value type. They must
// produce exactly the wire text and display value of the generic path
// (wireValue + stringifyExactJSON + displayWire).
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicResult, exactWire, valueCodec, wireValue, wireResult, displayWire } from '../shared/ink-values.mjs';
import { stringifyExactJSON } from '../shared/exact-json.mjs';

const named = {
  Inner: { kind: 'record', fields: [{ name: 'n', type: { kind: 'u32' } }, { name: 's', type: { kind: 'string' } }] },
  Row: {
    kind: 'record',
    fields: [
      { name: 'id', type: { kind: 'u64' } },
      { name: 'title', type: { kind: 'string' } },
      { name: 'signed', type: { kind: 'i32' } },
      { name: 'weight', type: { kind: 'f32' } },
      { name: 'wide', type: { kind: 'f64' } },
      { name: 'big', type: { kind: 'int' } },
      { name: 'open', type: { kind: 'bool' } },
      { name: 'key', type: { kind: 'id' } },
      { name: 'color', type: { kind: 'enum', variants: ['Color.Red', 'Color.Green'] } },
      { name: 'tags', type: { kind: 'list', element: { kind: 'u32' } } },
      { name: 'point', type: { kind: 'vector', size: 2, element: { kind: 'f32' } } },
      { name: 'inner', type: { kind: 'option', element: { kind: 'ref', name: 'Inner' } } },
      { name: 'outcome', type: { kind: 'result', ok: { kind: 'u64' }, error: { kind: 'string' } } },
      { name: 'nothing', type: { kind: 'unit' } },
    ],
  },
  Tree: { kind: 'record', fields: [{ name: 'children', type: { kind: 'list', element: { kind: 'ref', name: 'Tree' } } }] },
};

let seed = 7;
const random = (n) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
const pick = (xs) => xs[random(xs.length)];
const row = () => ({
  id: pick([0n, 1n, 9007199254740991n, 9007199254740992n, 18446744073709551615n]),
  title: pick(['', 'Row', 'é "quoted"\n\\', '\ud800 lone', '😀']),
  signed: pick([0, -1, 2147483647, -2147483648]),
  weight: pick([0, -0, 1.5, Math.fround(0.1), NaN, Infinity, { F32Bits: 2143289344 }]),
  wide: pick([0.1, -0, 1e300, NaN, { F64Bits: '9221120237041090560' }]),
  big: pick([0n, -5n, 1n << 80n, { Int: '-123456789012345678901234567890' }]),
  open: random(2) === 0,
  key: '0123456789abcdef0123456789abcdef',
  color: pick(['Color.Red', 'Color.Green']),
  tags: Array.from({ length: random(4) }, () => random(1000)),
  point: [Math.fround(random(100) / 3), -0],
  inner: random(2) ? { Some: { n: random(10), s: 'x' } } : { None: null },
  outcome: random(2) ? { Ok: BigInt(random(1000)) } : { Err: 'no' },
  nothing: null,
});

const generic = (output, entry, manifest) => {
  const wire = stringifyExactJSON(wireResult(output, entry, manifest));
  return { wire, output: displayWire(wire) };
};

test('generated encoders match the generic wire and display for every value kind', () => {
  const list = { kind: 'list', element: { kind: 'ref', name: 'Row' } };
  const manifest = {
    named_types: named,
    state: { events: [{ name: 'changed', type: { kind: 'ref', name: 'Row' } }, { name: 'tick', type: { kind: 'u64' } }] },
  };
  assert.ok(valueCodec(list, named), 'a list of records is specialised');
  for (let round = 0; round < 300; round++) {
    const rows = Array.from({ length: random(5) }, row);
    const query = { action: false, result: list };
    assert.deepEqual(publicResult(rows, query, manifest), generic(rows, query, manifest));
    assert.equal(exactWire(rows, list, named), stringifyExactJSON(wireValue(rows, list, named)));
    const action = { action: true, result: { kind: 'option', element: { kind: 'ref', name: 'Row' } } };
    const output = {
      result: random(2) ? { Some: row() } : { None: null },
      committed: random(2) === 0,
      version: pick([0n, 5n, 1n << 60n]),
      events: Array.from({ length: random(3) }, (_, i) =>
        random(2) ? { commit: 3n, position: i, channel: 'changed', value: row() } : { commit: 4n, position: i, channel: 'tick', value: 1n << 62n },
      ),
    };
    assert.deepEqual(publicResult(output, action, manifest), generic(output, action, manifest));
  }
});

test('non-finite numbers fail as before, and recursive types keep the generic path', () => {
  const manifest = { named_types: named, state: { events: [] } };
  const entry = { action: false, result: { kind: 'u32' } };
  assert.throws(() => publicResult(NaN, entry, manifest), RangeError);
  assert.throws(() => generic(NaN, entry, manifest), RangeError);
  const tree = { kind: 'ref', name: 'Tree' };
  assert.equal(valueCodec(tree, named), null);
  const value = { children: [{ children: [] }] };
  assert.deepEqual(publicResult(value, { action: false, result: tree }, manifest), generic(value, { action: false, result: tree }, manifest));
  assert.throws(() => publicResult([1, , 3], { action: false, result: { kind: 'list', element: { kind: 'u32' } } }, manifest), /Sparse JSON array/);
});
