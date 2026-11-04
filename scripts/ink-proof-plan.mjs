import { readFile, writeFile } from 'node:fs/promises';
import {
  packProofPlan,
  unpackProofPlan,
  proofPlan,
} from '../server/ink-proof-plan.mjs';
const [operation, input, output] = process.argv.slice(2);
if (!['pack', 'unpack'].includes(operation) || !input || !output)
  throw Error('Use node scripts/ink-proof-plan.mjs pack|unpack INPUT OUTPUT');
const original = await readFile(input, 'utf8'),
  result =
    operation === 'pack'
      ? packProofPlan(original)
      : await unpackProofPlan(original);
await writeFile(output, result, { mode: 0o600 });
const envelope = proofPlan(result);
console.log(
  JSON.stringify({
    operation,
    inputBytes: Buffer.byteLength(original),
    outputBytes: Buffer.byteLength(result),
    units: envelope ? Object.keys(envelope.units).length : 0,
  }),
);
