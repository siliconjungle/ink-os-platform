import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildInkApp, inkSource } from '../server/ink-apps.mjs';
import { compileInkProgram } from '../server/ink-compiler.mjs';
const execute = promisify(execFile),
  compiler = process.env.INK_COMPILER;
if (!compiler || !process.env.PYTHONPATH)
  throw Error(
    'Set INK_COMPILER to the pinned Ink CLI and PYTHONPATH to the pinned planner/knowledge packages',
  );
const root = new URL('../examples/tables-system/tables/', import.meta.url),
  manifest = JSON.parse(await readFile(new URL('ink-app.json', root))),
  files = await Promise.all(
    manifest.modules.modules.map(async (module) => ({
      path: module.path,
      base64: (await readFile(new URL(module.path, root))).toString('base64'),
    })),
  ),
  bundle = await buildInkApp(
    { ...manifest, optimisation: { version: 1, mode: 'baseline' } },
    files,
  ),
  source = inkSource(bundle.ink, bundle.files),
  artifact = await compileInkProgram(source),
  directory = await mkdtemp(join(tmpdir(), 'ink-system-proof-'));
try {
  const core = join(directory, 'source.core.json'),
    output = join(directory, 'producer');
  await writeFile(core, artifact.core);
  await execute(
    process.env.PYTHON || 'python3',
    [
      '-m',
      'producers.maintained_folds',
      core,
      '--core',
      '--compiler',
      compiler,
      '--keep',
      'OpenTotal',
      '--keep',
      'OpenCount',
      '-o',
      output,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const target = fileURLToPath(new URL('selected.plan.json', root));
  await execute(
    process.env.PYTHON || 'python3',
    [
      fileURLToPath(new URL('./compact-ink-plan.py', import.meta.url)),
      join(output, 'plan.json'),
      target,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  await execute(compiler, ['check-plan', core, target, '--core'], {
    maxBuffer: 1024 * 1024,
  });
  console.log(
    JSON.stringify({
      status: 'checked',
      core: artifact.manifest.core_sha256,
      bytes: (await readFile(target)).length,
      scope: 'Explicit maintained folds; no automatic profitability claim',
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
