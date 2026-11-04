import { portableProofPlan } from './ink-proof-plan.mjs';
import { hostBudget, WORKER_MEMORY_MB } from './execution-budget.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  compileInkProgram,
  compilerInfo,
  inkProgramKey,
  sealInkProgram,
} from './ink-compiler.mjs';
import { sourceFiles } from '../shared/source-files.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { moduleSummaries } from './ink-module-summaries.mjs';

const LIMIT = 12 * 1024 * 1024;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
const exactCanonical = (value) => stringifyExactJSON(sortKeys(value));
function sortKeys(value) {
  return Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sortKeys(value[key])]),
        )
      : value;
}
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
export function implementationSummary(value) {
  return {
    ...value.checked,
    targets: value.targets,
    selection: {
      mode: value.selection.mode,
      reason:
        value.selection.reason ||
        value.selection.receipt?.selection?.reason ||
        (value.checked.steps === 0
          ? 'Baseline retained by the recorded selection gates.'
          : 'Implementation selected by the recorded selection gates.'),
      ...(value.selection.receipt?.selection?.total_ns
        ? { totalNS: value.selection.receipt.selection.total_ns }
        : {}),
    },
  };
}

/** Source manifests select data and bounded effort, never executable host commands. */
export function planningOptions(input = { version: 1, mode: 'auto' }) {
  if (
    !input ||
    input.version !== 1 ||
    !['auto', 'search', 'replay', 'baseline'].includes(input.mode) ||
    Object.keys(input).some(
      (key) =>
        ![
          'version',
          'mode',
          'plan',
          'profile',
          'workload',
          'targetProfile',
          'budget',
          'timeSeconds',
        ].includes(key),
    )
  )
    fail('Invalid Ink optimisation contract.');
  if ((input.mode === 'replay') !== (input.plan !== undefined))
    fail('Replay requires a committed plan file.');
  const names = ['plan', 'profile', 'workload', 'targetProfile'].filter(
    (key) => input[key] !== undefined,
  );
  for (const key of names) {
    if (typeof input[key] !== 'string')
      fail('Planning inputs require source file paths.');
    sourceFiles([{ path: input[key], base64: '' }]);
  }
  if (
    ['profile', 'workload', 'targetProfile'].filter(
      (key) => input[key] !== undefined,
    ).length % 3
  )
    fail('Supply profile, workload and targetProfile together.');
  if (
    ['baseline', 'replay'].includes(input.mode) &&
    names.some((key) => key !== 'plan')
  )
    fail('Cost inputs require search or auto mode.');
  for (const [key, max] of [
    ['budget', 16384],
    ['timeSeconds', 120],
  ])
    if (
      input[key] !== undefined &&
      (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > max)
    )
      fail('Planning budgets exceed the OS build limits.');
  return {
    ...input,
    budget: input.budget ?? 2048,
    timeSeconds: input.timeSeconds ?? 8,
  };
}
export function planningFiles(options) {
  return ['plan', 'profile', 'workload', 'targetProfile'].flatMap((key) =>
    options[key] ? [options[key]] : [],
  );
}
function inputText(files, path) {
  const file = files.find((file) => file.path === path);
  if (!file || Buffer.byteLength(file.base64, 'base64') > LIMIT)
    fail('Missing or oversized committed planning input: ' + path);
  const bytes = Buffer.from(file.base64, 'base64'),
    text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes))
    fail('Planning input must be exact UTF-8.');
  return text;
}
async function boundedText(path) {
  if ((await stat(path)).size > LIMIT)
    fail('Planner output exceeds the release evidence limit.');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > LIMIT)
    fail('Planner output exceeds the release evidence limit.');
  return text;
}

// Bound the whole subprocess group, including search/proof producers. Search is
// only called by builds; verification and execution never enter this function.
export function runPlanningProcess(executable, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      bytes = 0,
      failure;
    const stop = (error) => {
      failure ||= error;
      try {
        process.platform === 'win32'
          ? child.kill('SIGKILL')
          : process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(
      () => stop(Error('Ink planning exceeded its build time limit.')),
      timeout,
    );
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024)
          stop(Error('Ink planning output limit exceeded.'));
        else output = (output + chunk.toString()).slice(-4000);
      });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      failure
        ? reject(failure)
        : code
          ? reject(Error('Ink planning failed: ' + output))
          : resolve();
    });
  });
}
let searchTail = Promise.resolve(),
  queued = 0;
async function search(original, options, files) {
  if (queued >= 8) fail('Ink planning build queue is full.');
  queued++;
  const task = searchTail
    .catch(() => {})
    .then(async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ink-os-planning-'));
      try {
        const source = join(directory, 'source.core.json'),
          output = join(directory, 'program.mjs'),
          snapshotPath = join(directory, 'snapshot.json');
        await writeFile(source, original.core, { mode: 0o600 });
        const snapshot = await boundedText(
          process.env.INK_OS_KNOWLEDGE_SNAPSHOT,
        );
        await writeFile(snapshotPath, snapshot, { mode: 0o600 });
        const args = [
          'compile',
          source,
          '--core',
          '--optimise',
          process.env.INK_OS_KNOWLEDGE_ROOT,
          '--snapshot',
          snapshotPath,
          '--target',
          'javascript',
          '--planning-effort',
          'quick',
          '--search-budget',
          String(options.budget),
          '--state-limit',
          '32',
          '--planning-seconds',
          String(options.timeSeconds),
          '--recipe-workers',
          '1',
          '--measurement-mode',
          'auto',
          '--measure-timeout',
          String(Math.min(options.timeSeconds, 10)),
          '--measure-processes',
          '1',
          '--reference-budget',
          '1000000',
          '--planning-cache',
          'off',
          '-o',
          output,
        ];
        const costInputs = {};
        for (const [key, flag] of [
          ['profile', '--profile'],
          ['workload', '--workload'],
          ['targetProfile', '--target-profile'],
        ])
          if (options[key]) {
            const text = inputText(files, options[key]),
              path = join(directory, key + '.json');
            JSON.parse(text);
            await writeFile(path, text, { mode: 0o600 });
            args.push(flag, path);
            costInputs[key] = text;
          }
        await hostBudget.run(
          {
            owner: 'planner',
            resources: { cpu: 1, memoryMB: WORKER_MEMORY_MB },
            label: 'implementation search',
          },
          () =>
            runPlanningProcess(
              process.env.INK_OS_PLANNER_COMPILER,
              args,
              (options.timeSeconds + 30) * 1000,
            ),
        );
        const plan = await boundedText(output + '.planning.json');
        let receiptText = await boundedText(
          output + '.planning.json.receipt.json',
        );
        for (const [path, label] of [
          [directory, '<build>'],
          [process.env.INK_OS_KNOWLEDGE_ROOT, '<knowledge>'],
          [process.env.INK_OS_PLANNER_COMPILER, '<compiler>'],
        ])
          receiptText = receiptText.replaceAll(path, label);
        const receipt = JSON.parse(receiptText),
          observations = {};
        for (const ids of Object.values(receipt.selection?.observations || {}))
          for (const id of ids) {
            if (!/^[a-f0-9]{64}$/.test(id))
              fail('Invalid planner observation identity.');
            const text = await boundedText(
              join(
                process.env.INK_OS_KNOWLEDGE_ROOT,
                'store',
                'observations',
                id + '.json',
              ),
            );
            if (sha(exactCanonical(parseExactJSON(text))) !== id)
              fail('Planner observation content mismatch.');
            observations[id] = text;
          }
        return {
          plan,
          selection: {
            mode: 'search',
            snapshot,
            snapshotSHA256: sha(snapshot),
            costInputs,
            observations,
            receipt,
            emittedSHA256: sha(await boundedText(output)),
          },
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  searchTail = task;
  try {
    return await task;
  } finally {
    queued--;
  }
}

export async function buildImplementation(source, files, input) {
  const options = planningOptions(input),
    original = await compileInkProgram(source);
  let plan = JSON.stringify({
    schema: 1,
    semantics: 'ink-compiled-plan-v1',
    input_core_sha256: original.manifest.core_sha256,
    steps: [],
  });
  let selection = {
    mode: 'baseline',
    reason:
      options.mode === 'baseline'
        ? 'Explicit baseline.'
        : 'Planner is not configured on this build host.',
  };
  if (options.mode === 'replay') {
    plan = inputText(files, options.plan);
    selection = {
      mode: 'replay',
      reason: 'Explicit committed plan; no automatic profitability claim.',
    };
  }
  if (['auto', 'search'].includes(options.mode)) {
    const configured = [
      'INK_OS_PLANNER_COMPILER',
      'INK_OS_KNOWLEDGE_ROOT',
      'INK_OS_KNOWLEDGE_SNAPSHOT',
    ].map((key) => !!process.env[key]);
    if (configured.some(Boolean) && !configured.every(Boolean))
      fail(
        'Configure the planner compiler, knowledge root and pinned snapshot together.',
      );
    if (options.mode === 'search' && !configured.every(Boolean))
      fail(
        'Ink search requires a configured build planner and pinned snapshot.',
      );
    if (configured.every(Boolean)) {
      try {
        ({ plan, selection } = await search(original, options, files));
      } catch (error) {
        if (options.mode === 'search') throw error;
        selection = {
          mode: 'baseline',
          reason: 'Bounded search failed; checked baseline retained.',
          searchFailure: error.code || error.name,
        };
      }
    }
  }
  const execution = { kind: 'ink-os-planned-v1', source, plan },
    artifact = await compileInkProgram(execution);
  if (
    selection.mode === 'search' &&
    (selection.emittedSHA256 !== sha(artifact.javascript) ||
      selection.receipt.source !== artifact.compiled_plan.input ||
      selection.receipt.selected !== artifact.compiled_plan.plan ||
      selection.receipt.source_snapshot !==
        sha(exactCanonical(parseExactJSON(selection.snapshot))))
  )
    fail(
      'Planner emission/receipt differs from the bundled checked implementation; configure a matching distribution.',
    );
  const targets = {
    javascript: { available: true, sha256: sha(artifact.javascript) },
    native: artifact.rust
      ? { available: true, sha256: sha(artifact.rust) }
      : { available: false, reason: artifact.rust_reason },
    gpu: { available: false, reason: artifact.host_reason },
    auto: { nativeFallback: 'javascript' },
  };
  const implementation = {
    schema: 1,
    compiler: (await compilerInfo()).sha256,
    source: inkProgramKey(source),
    plan: portableProofPlan(plan, artifact.plan),
    checked: artifact.compiled_plan,
    targets,
    selection,
    artifact: (({ plan, ...target }) => target)(artifact),
    modules: await moduleSummaries(source, original),
  };
  return { implementation, artifact, execution };
}

const verified = new Map(),
  verifiedSizes = new Map();
let verifiedBytes = 0;
const discardVerified = (key) => {
  verified.delete(key);
  verifiedBytes -= verifiedSizes.get(key) || 0;
  verifiedSizes.delete(key);
};
const freezeEvidence = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
};
export async function verifyImplementation(source, text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 20 * 1024 * 1024)
    fail('Ink implementation file exceeds its limit.');
  const key = sha(inkProgramKey(source) + '\0' + text);
  if (!verified.has(key)) {
    const task = (async () => {
      const saved = JSON.parse(text);
      if (
        saved.schema !== 1 ||
        ![
          (await compilerInfo()).sha256,
          ...((await compilerInfo()).replayCompatible || []),
        ].includes(saved.compiler) ||
        saved.source !== inkProgramKey(source) ||
        typeof saved.plan !== 'string'
      )
        fail('Ink implementation compiler/source identity mismatch.');
      const execution = { kind: 'ink-os-planned-v1', source, plan: saved.plan },
        artifact = await compileInkProgram(execution);
      if (
        canonical(saved.artifact) !==
          canonical(
            Object.hasOwn(saved.artifact, 'plan')
              ? artifact
              : (({ plan, ...target }) => target)(artifact),
          ) ||
        canonical(saved.checked) !== canonical(artifact.compiled_plan)
      )
        fail('Ink implementation artifact or checked evidence mismatch.');
      if (
        saved.modules &&
        canonical(saved.modules) !==
          canonical(
            await moduleSummaries(source, await compileInkProgram(source), {
              compilerBinding: saved.compiler,
            }),
          )
      )
        fail('Ink module summary differs from checked source');
      const targets = {
        javascript: { available: true, sha256: sha(artifact.javascript) },
        native: artifact.rust
          ? { available: true, sha256: sha(artifact.rust) }
          : { available: false, reason: artifact.rust_reason },
        gpu: { available: false, reason: artifact.host_reason },
        auto: { nativeFallback: 'javascript' },
      };
      if (canonical(saved.targets) !== canonical(targets))
        fail('Ink implementation target inventory mismatch.');
      if (
        !saved.selection ||
        !['baseline', 'replay', 'search'].includes(saved.selection.mode)
      )
        fail('Ink implementation selection provenance is missing.');
      if (
        saved.selection.mode === 'baseline' &&
        artifact.compiled_plan.steps !== 0
      )
        fail('Baseline provenance cannot authorize a selected plan.');
      if (saved.selection.mode === 'search') {
        const selection = saved.selection;
        if (
          typeof selection.snapshot !== 'string' ||
          sha(selection.snapshot) !== selection.snapshotSHA256 ||
          selection.receipt?.source_snapshot !==
            sha(exactCanonical(parseExactJSON(selection.snapshot))) ||
          selection.emittedSHA256 !== sha(artifact.javascript) ||
          selection.receipt?.source !== artifact.compiled_plan.input ||
          selection.receipt?.selected !== artifact.compiled_plan.plan ||
          selection.receipt?.status !== 'checked'
        )
          fail('Ink planning receipt does not bind this implementation.');
        for (const ids of Object.values(
          selection.receipt.selection?.observations || {},
        ))
          for (const id of ids) {
            const text = selection.observations?.[id];
            if (
              !/^[a-f0-9]{64}$/.test(id) ||
              typeof text !== 'string' ||
              sha(exactCanonical(parseExactJSON(text))) !== id
            )
              fail('Ink planning cost observation mismatch.');
          }
      }
      return {
        execution: sealInkProgram(execution),
        implementation: freezeEvidence(saved),
        artifact,
      };
    })().then((result) => {
      if (verified.get(key) === task) {
        const bytes =
          Buffer.byteLength(text) +
          Buffer.byteLength(JSON.stringify(result.artifact));
        verifiedSizes.set(key, bytes);
        verifiedBytes += bytes;
        for (const id of verified.keys()) {
          if (verified.size <= 16 && verifiedBytes <= 64 * 1024 * 1024) break;
          if (verifiedSizes.has(id)) discardVerified(id);
        }
      }
      return result;
    });
    verified.set(key, task);
    task.catch(() => {
      if (verified.get(key) === task) discardVerified(key);
    });
    if (verified.size > 16) discardVerified(verified.keys().next().value);
  }
  return verified.get(key);
}
