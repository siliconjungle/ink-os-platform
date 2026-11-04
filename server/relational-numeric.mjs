// Reproducible binary64 aggregation: accumulate exact multiples of 2^-1074,
// then round once, ties to even. This is a relational aggregate contract, not
// an authorization to reassociate an Ink program's ordered floating-point fold.
const buffer = new DataView(new ArrayBuffer(8)),
  fractionMask = (1n << 52n) - 1n;
export class ExactSum {
  constructor() {
    this.units = 0n;
  }
  add(value) {
    if (!Number.isFinite(value))
      throw RangeError('Relational aggregate requires finite numbers');
    buffer.setFloat64(0, value);
    const bits = buffer.getBigUint64(0),
      exponent = Number((bits >> 52n) & 2047n);
    const mantissa = (bits & fractionMask) | (exponent ? 1n << 52n : 0n),
      units = mantissa << BigInt(exponent ? exponent - 1 : 0);
    this.units += bits >> 63n ? -units : units;
  }
  value(count = 1) {
    if (!Number.isSafeInteger(count) || count < 1)
      throw RangeError('Invalid relational average denominator');
    const negative = this.units < 0n,
      n = negative ? -this.units : this.units,
      d = BigInt(count);
    if (!n) return 0;
    let power = n.toString(2).length - d.toString(2).length;
    if (power >= 0 ? n < d << BigInt(power) : n << BigInt(-power) < d) power--;
    let shift = Math.max(0, power - 52),
      divisor = d << BigInt(shift),
      mantissa = n / divisor,
      remainder = n % divisor;
    if (
      remainder * 2n > divisor ||
      (remainder * 2n === divisor && mantissa & 1n)
    )
      mantissa++;
    if (mantissa >= 1n << 53n) {
      mantissa >>= 1n;
      shift++;
    }
    const exponent = mantissa < 1n << 52n ? 0 : shift + 1;
    if (exponent >= 2047)
      throw RangeError('Relational numeric aggregate overflow');
    const bits =
      (negative ? 1n << 63n : 0n) |
      (BigInt(exponent) << 52n) |
      (mantissa & fractionMask);
    buffer.setBigUint64(0, bits);
    return buffer.getFloat64(0);
  }
}
export function aggregateValue(sum, count, average = false) {
  try {
    return count ? sum.value(average ? count : 1) : null;
  } catch (error) {
    throw Object.assign(error, { status: 422 });
  }
}
