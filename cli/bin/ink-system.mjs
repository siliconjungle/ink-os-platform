import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { sourceFiles } from '../../shared/source-files.mjs';
import { inkModuleGraph } from '../../shared/ink-app.mjs';
import { planningFiles, planningOptions } from '../../server/ink-planning.mjs';
import { buildInkSystem } from '../../server/ink-system.mjs';
import { committedSource } from './ink.mjs';
export async function loadInkSystem(directory, { committed = false } = {}) {
  directory = await realpath(resolve(directory));
  let supplied;
  if (committed)
    supplied = await committedSource(directory, undefined, 'ink-system.json');
  const read = async (path) => {
    sourceFiles([{ path, base64: '' }]);
    if (supplied) {
      const f = supplied.files.find((f) => f.path === path);
      if (!f)
        throw Error('System source is not in its committed tree: ' + path);
      return Buffer.from(f.base64, 'base64');
    }
    const target = await realpath(join(directory, path)),
      inside = relative(directory, target);
    if (inside === '..' || inside.startsWith('..' + sep))
      throw Error('System source escapes its root');
    const bytes = await readFile(target);
    if (bytes.length > 12 * 1024 * 1024)
      throw Error('System source file exceeds its limit');
    return bytes;
  };
  const system = JSON.parse(await read('ink-system.json'));
  if (
    system.version !== 1 ||
    !Array.isArray(system.apps) ||
    system.apps.length > 16
  )
    throw Error('Declare at most 16 system apps');
  const apps = [];
  for (const unit of system.apps) {
    if (
      typeof unit.path !== 'string' ||
      unit.path.startsWith('/') ||
      !unit.path
    )
      throw Error('System units use relative source directories');
    sourceFiles([{ path: unit.path + '/ink-app.json', base64: '' }]);
    const manifest = JSON.parse(await read(unit.path + '/ink-app.json')),
      names = [
        'ink-app.json',
        ...(manifest.modules
          ? inkModuleGraph(manifest.modules).modules.map((m) => m.path)
          : [manifest.source || 'main.ink']),
        ...planningFiles(planningOptions(manifest.optimisation)),
      ];
    const icon = manifest.desktop?.icon;
    if (typeof icon === 'string' && icon.endsWith('.svg')) names.push(icon);
    const files = [];
    for (const path of new Set(names))
      files.push({
        path,
        base64: (await read(unit.path + '/' + path)).toString('base64'),
      });
    apps.push({ name: unit.name, manifest, files });
  }
  return { version: 1, apps, links: system.links || [] };
}
export async function systemCLI(action, directory, options, request) {
  directory = resolve(directory || '.');
  const input = await loadInkSystem(directory, {
    committed: action === 'system-deploy',
  });
  if (action === 'system-deploy')
    return request('ink/systems/deploy', 'POST', { input });
  const packet = await buildInkSystem(input, {
      cacheDirectory: join(directory, '.ink/system-cache'),
    }),
    output = resolve(options.output || join(directory, '.ink/system.json'));
  await mkdir(join(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(packet), { mode: 0o600 });
  return {
    output,
    identity: packet.graph.identity,
    stats: packet.stats,
    units: packet.graph.units.map((u) => ({
      name: u.name,
      source: u.source,
      steps: u.implementation.steps,
    })),
    links: packet.graph.links.length,
  };
}
