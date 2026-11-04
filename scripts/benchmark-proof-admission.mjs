import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildInkApp, inkSource } from '../server/ink-apps.mjs';
import {
  buildImplementation,
  verifyImplementation,
} from '../server/ink-planning.mjs';
import { compilerInfo } from '../server/ink-compiler.mjs';
import { packProofPlan, unpackProofPlan } from '../server/ink-proof-plan.mjs';
import { rebindProofPlan } from '../server/ink-proof-authoring.mjs';
import {
  proofAdmissionStats,
  closeProofCompiler,
} from '../server/ink-proof-compiler.mjs';
const execute = promisify(execFile),
  args = process.argv.slice(2),
  child = args.indexOf('--child'),
  baselineIndex = args.indexOf('--baseline-directory'),
  previous = baselineIndex < 0 ? null : resolve(args[baselineIndex + 1]);
if (child >= 0) {
  const mode = args[child + 1],
    directory = args[child + 2],
    source = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8')),
    prefix = mode === 'previous-units' ? 'units' : mode,
    text = await readFile(join(directory, prefix + '.json'), 'utf8');
  const planning =
      mode === 'previous-units'
        ? await import(pathToFileURL(join(previous, 'server/ink-planning.mjs')))
        : { verifyImplementation },
    proofCompiler =
      mode === 'previous-units'
        ? await import(
            pathToFileURL(join(previous, 'server/ink-proof-compiler.mjs'))
          )
        : { proofAdmissionStats, closeProofCompiler };
  let peakRSS = process.memoryUsage().rss;
  const sample = () => (peakRSS = Math.max(peakRSS, process.memoryUsage().rss)),
    timer = setInterval(sample, 3);
  try {
    const start = performance.now(),
      cold = await planning.verifyImplementation(source, text),
      coldMS = performance.now() - start;
    sample();
    const coldMemory = process.memoryUsage(),
      afterCold = proofCompiler.proofAdmissionStats();
    const next = JSON.parse(
        await readFile(join(directory, 'changed-source.json'), 'utf8'),
      ),
      changed = await readFile(
        join(directory, prefix + '-changed.json'),
        'utf8',
      ),
      begin = performance.now();
    await planning.verifyImplementation(next, changed);
    const changedMS = performance.now() - begin,
      afterChanged = proofCompiler.proofAdmissionStats();
    const reorderedSource = JSON.parse(
        await readFile(join(directory, 'reordered-source.json'), 'utf8'),
      ),
      reordered = await readFile(
        join(directory, prefix + '-reordered.json'),
        'utf8',
      ),
      reorderStart = performance.now();
    await planning.verifyImplementation(reorderedSource, reordered);
    const reorderedMS = performance.now() - reorderStart;
    sample();
    console.log(
      JSON.stringify({
        mode,
        coldMS,
        changedMS,
        reorderedMS,
        coldPacketBytes: Buffer.byteLength(text),
        changedPacketBytes: Buffer.byteLength(changed),
        coldMemory,
        afterMemory: process.memoryUsage(),
        sampledPeakRSS: peakRSS,
        osHighWaterRSSBytes: process.resourceUsage().maxRSS * 1024,
        afterCold,
        afterChanged,
        afterReordered: proofCompiler.proofAdmissionStats(),
        selected: cold.implementation.checked,
      }),
    );
  } finally {
    clearInterval(timer);
    await proofCompiler.closeProofCompiler();
  }
} else {
  const directory = await mkdtemp(join(tmpdir(), 'ink-proof-costs-'));
  try {
    const root = new URL('../examples/tables-system/tables/', import.meta.url),
      manifest = JSON.parse(
        await readFile(new URL('ink-app.json', root), 'utf8'),
      ),
      files = await Promise.all(
        manifest.modules.modules.map(async (m) => ({
          path: m.path,
          base64: (await readFile(new URL(m.path, root))).toString('base64'),
        })),
      );
    const baseline = await buildInkApp(
        { ...manifest, optimisation: { version: 1, mode: 'baseline' } },
        files,
      ),
      source = inkSource(baseline.ink, baseline.files),
      packed = packProofPlan(
        await readFile(new URL('selected.plan.json', root), 'utf8'),
      ),
      legacy = await unpackProofPlan(packed),
      changedSource = structuredClone(source);
    changedSource.modules[0].source = changedSource.modules[0].source.replace(
      '"Tables"',
      '"Changed proof admission heading"',
    );
    const changed = await rebindProofPlan(changedSource, packed),
      reorderedSource = structuredClone(changedSource),
      envelope = JSON.parse(changed);
    reorderedSource.modules[0].source +=
      '\n// identical mathematical source, differently ordered transport fields';
    envelope.units = Object.fromEntries(
      Object.entries(envelope.units).map(([id, u]) => [
        id,
        { brotli: u.brotli, dependencies: u.dependencies, bytes: u.bytes },
      ]),
    );
    const plans = {
        legacy,
        units: packed,
        'legacy-changed': await unpackProofPlan(changed),
        'units-changed': changed,
        'legacy-reordered': await unpackProofPlan(changed),
        'units-reordered': JSON.stringify(envelope),
      },
      saved = {};
    for (const [name, plan] of Object.entries(plans)) {
      const value = await buildImplementation(
        name.endsWith('reordered')
          ? reorderedSource
          : name.endsWith('changed')
            ? changedSource
            : source,
        [{ path: 'plan.json', base64: Buffer.from(plan).toString('base64') }],
        { version: 1, mode: 'replay', plan: 'plan.json' },
      );
      saved[name] = value.implementation;
      await writeFile(
        join(directory, name + '.json'),
        JSON.stringify(value.implementation),
      );
    }
    for (const key of ['javascript', 'native']) {
      assert.equal(
        saved.legacy.targets[key].sha256,
        saved.units.targets[key].sha256,
      );
      assert.equal(
        saved['legacy-changed'].targets[key].sha256,
        saved['units-changed'].targets[key].sha256,
      );
    }
    for (const key of ['javascript', 'native'])
      assert.equal(
        saved['legacy-reordered'].targets[key].sha256,
        saved['units-reordered'].targets[key].sha256,
      );
    await writeFile(
      join(directory, 'reordered-source.json'),
      JSON.stringify(reorderedSource),
    );
    if (previous) {
      const before = JSON.parse(
        await readFile(join(previous, 'public/compiler-info.json'), 'utf8'),
      );
      assert.equal(
        before.sha256,
        (await compilerInfo()).sha256,
        'Compared compiler bytes must match',
      );
    }
    await writeFile(join(directory, 'source.json'), JSON.stringify(source));
    await writeFile(
      join(directory, 'changed-source.json'),
      JSON.stringify(changedSource),
    );
    await closeProofCompiler();
    const runs = [];
    for (let trial = 0; trial < 3; trial++)
      for (const mode of trial % 2
        ? ['units', ...(previous ? ['previous-units'] : []), 'legacy']
        : ['legacy', ...(previous ? ['previous-units'] : []), 'units']) {
        const result = await execute(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            '--child',
            mode,
            directory,
            ...(previous ? ['--baseline-directory', previous] : []),
          ],
          { maxBuffer: 2 * 1024 * 1024 },
        );
        runs.push({ trial, ...JSON.parse(result.stdout) });
      }
    console.log(
      JSON.stringify(
        {
          version: 2,
          currentSources: Object.fromEntries(
            await Promise.all(
              [
                'server/ink-proof-compiler.mjs',
                'server/ink-proof-worker.mjs',
                'scripts/benchmark-proof-admission.mjs',
              ].map(async (path) => [
                path,
                createHash('sha256')
                  .update(
                    await readFile(new URL('../' + path, import.meta.url)),
                  )
                  .digest('hex'),
              ]),
            ),
          ),
          ...(previous
            ? {
                previousRevision: (
                  await execute('git', ['-C', previous, 'rev-parse', 'HEAD'])
                ).stdout.trim(),
              }
            : {}),
          node: process.versions.node,
          cpu: cpus()[0]?.model,
          compiler: await compilerInfo(),
          scope:
            'Fresh Node process per mode/trial. Cold full release verification, then a changed view with refreshed source observations and an equivalent descriptor-order variant. Prior-unit mode loads the previous host from an explicit checkout with identical compiler bytes. Includes kernel replay, source checks, emission and artifact comparison; excludes authoring/compaction, disk transfer, execution and rendering. OS high-water RSS includes the Node coordinator and its worker threads; heap counters do not include every worker heap. No forced GC.',
          proofPlanBytes: {
            legacy: Buffer.byteLength(legacy),
            units: Buffer.byteLength(packed),
          },
          targets: saved.units.targets,
          runs,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeProofCompiler();
    await rm(directory, { recursive: true, force: true });
  }
}
