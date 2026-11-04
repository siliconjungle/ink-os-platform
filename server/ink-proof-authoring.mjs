import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { compilerRequest, compileInkProgram } from './ink-compiler.mjs';
import {
  proofPlan,
  encodeProofUnit,
  proofUnitIdentity,
} from './ink-proof-plan.mjs';
/** Produce a candidate rebinding after a source edit. This supplies checked
 * source observations; the full maintained checker must still admit the result.
 * It cannot manufacture a missing factorisation or preservation proof. */
export async function rebindProofPlan(source, text) {
  const envelope = proofPlan(text);
  if (!envelope) throw Error('Expected a proof-unit plan');
  const packet = parseExactJSON(envelope.plan);
  if (packet.steps.length !== 1 || packet.steps[0].kind !== 'maintained_units')
    throw Error('Source rebinding requires one maintained-units step');
  const artifact = await compileInkProgram(source),
    wire = await compilerRequest({
      op: 'maintainedSubjects',
      ...(typeof source === 'string' ? { source } : { graph: source }),
    }),
    observed = parseExactJSON(wire.text);
  const step = packet.steps[0],
    scope = step.package.knowledge;
  for (const entry of Object.values(observed.objects)) {
    const { id, unit } = encodeProofUnit(entry);
    envelope.units[id] = unit;
  }
  const objects = Object.keys(envelope.units).sort();
  scope.objects = objects;
  scope.roots = [
    ...new Set([...scope.roots, ...Object.keys(observed.objects)]),
  ].sort();
  const witnesses = [],
    membership = {};
  function branch(ids) {
    if (ids.length <= 64) {
      const index = witnesses.length;
      witnesses.push({ entries: ids, path: [] });
      for (const id of ids) membership[id] = index;
      return {
        root: proofUnitIdentity({ schema: 1, entries: ids }),
        leaves: [index],
      };
    }
    const mid = Math.floor(ids.length / 2),
      left = branch(ids.slice(0, mid)),
      right = branch(ids.slice(mid));
    for (const index of left.leaves)
      witnesses[index].path.push({ left: false, sibling: right.root });
    for (const index of right.leaves)
      witnesses[index].path.push({ left: true, sibling: left.root });
    return {
      root: proofUnitIdentity({
        schema: 1,
        left: left.root,
        right: right.root,
      }),
      leaves: [...left.leaves, ...right.leaves],
    };
  }
  scope.snapshot.root = branch(objects).root;
  scope.membership = membership;
  scope.witnesses = witnesses;
  packet.input_core_sha256 = artifact.manifest.core_sha256;
  step.package.input_core_sha256 = artifact.manifest.core_sha256;
  envelope.plan = stringifyExactJSON(packet);
  const candidate = JSON.stringify(envelope);
  proofPlan(candidate);
  // No artifact can escape this authoring API until the ordinary source-bound
  // checker has replayed the candidate using independently admitted units.
  await compileInkProgram({
    kind: 'ink-os-planned-v1',
    source,
    plan: candidate,
  });
  return candidate;
}
