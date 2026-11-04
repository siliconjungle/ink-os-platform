import test from 'node:test';
import assert from 'node:assert/strict';
import { ExactSum } from '../server/relational-numeric.mjs';
const sum = (values) => {
  const sum = new ExactSum();
  for (const value of values) sum.add(value);
  return sum;
};
test('relational sums are order-independent and round once with correct ties and subnormals', () => {
  for (const values of [
    [1e16, 1, -1e16],
    [1e16, -1e16, 1],
    [1, -1e16, 1e16],
  ])
    assert.equal(sum(values).value(), 1);
  assert.equal(sum([0.1, 0.2, -0.3]).value(), 2 ** -55);
  assert.equal(sum([1, 1 + Number.EPSILON]).value(2), 1);
  assert.equal(
    sum([1 + Number.EPSILON, 1 + 2 * Number.EPSILON]).value(2),
    1 + 2 * Number.EPSILON,
  );
  assert.equal(sum([Number.MIN_VALUE, 0]).value(2), 0);
  assert.equal(
    sum([Number.MIN_VALUE, Number.MIN_VALUE, 0]).value(3),
    Number.MIN_VALUE,
  );
  assert.ok(Object.is(sum([-Number.MIN_VALUE, 0]).value(2), -0));
  assert.equal(
    sum([Number.MAX_VALUE, Number.MAX_VALUE]).value(2),
    Number.MAX_VALUE,
  );
  assert.throws(
    () => sum([Number.MAX_VALUE, Number.MAX_VALUE]).value(),
    /overflow/,
  );
  const maintained = sum([1e16, 1, -1e16]);
  maintained.add(-1e16);
  maintained.add(1e16);
  assert.equal(maintained.value(), 1);
});

test('single-round pair addition agrees with IEEE binary64 across held-out bit patterns', () => {
  const bits = new DataView(new ArrayBuffer(8));
  let seed = 0x2152c1;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const number = () => {
    bits.setUint32(0, random() & 0xffefffff);
    bits.setUint32(4, random());
    return bits.getFloat64(0);
  };
  for (let index = 0; index < 1000; index++) {
    const a = number(),
      b = number(),
      expected = a + b;
    if (!Number.isFinite(expected)) {
      assert.throws(() => sum([a, b]).value(), /overflow/);
      continue;
    }
    assert.ok(
      Object.is(sum([a, b]).value(), expected) ||
        sum([a, b]).value() === expected,
    );
  }
});
