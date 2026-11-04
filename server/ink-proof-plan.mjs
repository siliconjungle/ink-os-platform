import { createHash } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const canonical = (value) => stringifyExactJSON(sort(value));
const sort = (value) =>
  Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sort(value[key])]),
        )
      : value;
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
export function proofPlan(text) {
  if (typeof text !== 'string' || !text.includes('ink-proof-plan-v1'))
    return null;
  if (Buffer.byteLength(text) > 12 * 1024 * 1024)
    fail('Proof plan exceeds 12 MiB');
  const value = JSON.parse(text);
  if (value.format !== 'ink-proof-plan-v1') return null;
  if (
    !fields(value, ['format', 'plan', 'units']) ||
    typeof value.plan !== 'string' ||
    !value.units ||
    typeof value.units !== 'object' ||
    Array.isArray(value.units) ||
    Object.keys(value.units).length > 16384
  )
    fail('Invalid proof unit envelope');
  let bytes = 0;
  for (const [key, unit] of Object.entries(value.units)) {
    if (
      !id(key) ||
      !fields(unit, ['bytes', 'dependencies', 'brotli']) ||
      !Number.isSafeInteger(unit.bytes) ||
      unit.bytes < 1 ||
      unit.bytes > 16 * 1024 * 1024 ||
      !Array.isArray(unit.dependencies) ||
      unit.dependencies.length > 128 ||
      unit.dependencies.some(
        (d, i) => !id(d) || (i > 0 && d <= unit.dependencies[i - 1]),
      ) ||
      typeof unit.brotli !== 'string' ||
      Buffer.from(unit.brotli, 'base64').toString('base64') !== unit.brotli
    )
      fail('Invalid bounded proof unit');
    bytes += unit.bytes;
  }
  if (bytes > 12 * 1024 * 1024) fail('Expanded proof units exceed 12 MiB');
  const packet = JSON.parse(value.plan),
    required = new Set();
  if (!Array.isArray(packet.steps)) fail('Missing compiled proof plan');
  for (const step of packet.steps)
    if (step.kind === 'maintained_units') {
      const objects = step.package?.knowledge?.objects;
      if (!Array.isArray(objects)) fail('Missing proof unit scope');
      for (const object of objects) {
        if (!id(object)) fail('Invalid scoped proof identity');
        required.add(object);
      }
    }
  if (
    !required.size ||
    required.size !== Object.keys(value.units).length ||
    [...required].some((id) => !Object.hasOwn(value.units, id))
  )
    fail('Proof unit inventory differs from complete plan closure');
  return value;
}
export function portableProofPlan(original, checked) {
  const envelope = proofPlan(original);
  return envelope ? JSON.stringify({ ...envelope, plan: checked }) : checked;
}
/** Transport compaction only. Every declaration and application equation still
 * reaches the kernel. No "checked" flag or producer hash grants authority. */
export function encodeProofUnit(entry) {
  const bytes = Buffer.from(canonical(entry));
  return {
    id: sha(bytes),
    unit: {
      bytes: bytes.length,
      dependencies: entry.dependencies,
      brotli: brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
      }).toString('base64'),
    },
  };
}
export const proofUnitIdentity = (value) => sha(canonical(value));
export function packProofPlan(text) {
  if (proofPlan(text)) return text;
  const plan = parseExactJSON(text),
    units = {};
  let found = false;
  for (const step of plan.steps || [])
    if (step.kind === 'maintained') {
      const knowledge = step.package.knowledge;
      if (
        Object.values(knowledge.objects).some(
          (entry) => entry.semantics !== 'first-order-inductive-equality-v1',
        )
      )
        fail('Only first-order maintained proof closures can be unitized');
      for (const [key, entry] of Object.entries(knowledge.objects)) {
        const encoded = encodeProofUnit(entry);
        if (encoded.id !== key) fail('Proof unit content identity mismatch');
        const unit = encoded.unit;
        if (units[key] && JSON.stringify(units[key]) !== JSON.stringify(unit))
          fail('Conflicting proof unit bytes');
        units[key] = unit;
      }
      const witnesses = [],
        known = new Map();
      knowledge.membership = Object.fromEntries(
        Object.entries(knowledge.membership).map(([id, witness]) => {
          const key = JSON.stringify(witness);
          if (!known.has(key)) {
            known.set(key, witnesses.length);
            witnesses.push(witness);
          }
          return [id, known.get(key)];
        }),
      );
      knowledge.witnesses = witnesses;
      knowledge.objects = Object.keys(knowledge.objects).sort();
      step.kind = 'maintained_units';
      step.package.semantics = 'ink-maintained-fold-units-v1';
      found = true;
    }
  if (!found) fail('No maintained mathematical proof closure to unitize');
  const output = JSON.stringify({
    format: 'ink-proof-plan-v1',
    plan: canonical(plan),
    units,
  });
  proofPlan(output);
  return output;
}

/** Expand for inspection or an existing complete-plan producer. Admission never
 * trusts expansion: the ordinary kernel still checks the result. */
export async function unpackProofPlan(text) {
  const envelope = proofPlan(text);
  if (!envelope) return text;
  const { brotliDecompressSync } = await import('node:zlib'),
    plan = parseExactJSON(envelope.plan);
  for (const step of plan.steps)
    if (step.kind === 'maintained_units') {
      const knowledge = step.package.knowledge,
        objects = {};
      for (const id of knowledge.objects) {
        const unit = envelope.units[id],
          bytes = brotliDecompressSync(Buffer.from(unit.brotli, 'base64'), {
            maxOutputLength: unit.bytes,
          });
        if (bytes.length !== unit.bytes || sha(bytes) !== id)
          fail('Proof unit content identity mismatch');
        objects[id] = parseExactJSON(bytes.toString());
      }
      knowledge.objects = objects;
      knowledge.membership = Object.fromEntries(
        Object.entries(knowledge.membership).map(([id, index]) => [
          id,
          knowledge.witnesses[index],
        ]),
      );
      delete knowledge.witnesses;
      step.kind = 'maintained';
      step.package.semantics = 'ink-maintained-fold-v1';
    }
  return canonical(plan);
}
