import { readFile } from 'node:fs/promises';
import { compileInkProgram, compilerInfo } from './ink-compiler.mjs';
import { inkEntries, inkCommands, inkSpec, inkModuleGraph } from '../shared/ink-app.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { sourceFiles } from '../shared/source-files.mjs';

const encode = (path, bytes) => ({ path, base64: Buffer.from(bytes).toString('base64') });
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };

function sourceText(file) {
  if (!file) fail(400, 'Ink source file is missing from the committed package.');
  const validated = sourceFiles([file], { maxBytes: 128 * 1024 })[0];
  const bytes = Buffer.from(validated.base64, 'base64'), text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail(400, 'Ink source must be exact UTF-8 text.');
  return text;
}

/** Read only the explicitly declared private release source closure. No ambient imports. */
export function inkSource(input, files) {
  if (!Array.isArray(files)) fail(400, 'Ink package files are missing.');
  const spec = inkSpec(input, new Set(files.map(file => file.path)));
  const paths = new Set(spec.modules ? spec.modules.modules.map(module => module.path) : [spec.source]);
  const selected = sourceFiles(files.filter(file => paths.has(file.path)), { maxBytes: 128 * 1024 });
  const byPath = new Map(selected.map(file => [file.path, file]));
  if (!spec.modules) return sourceText(byPath.get(spec.source));
  return inkModuleGraph({ ...spec.modules, modules: spec.modules.modules.map(module => ({ ...module, source: sourceText(byPath.get(module.path)) })) }, { sources: true });
}

export async function buildInkApp(manifest, files, { source } = {}) {
  if (!manifest || manifest.language !== 'ink') fail(400, 'Set language to ink in ink-app.json.');
  files = sourceFiles(files);
  const paths = new Set(files.map(file => file.path));
  let graph, sourcePath = 'server/main.ink', sourceRelease;
  if (manifest.modules !== undefined) {
    const declared = inkModuleGraph(manifest.modules, { paths });
    if (manifest.source !== undefined && manifest.source !== declared.root) fail(400, 'Ink source must match the explicit module graph root.');
    const releasedPath = path => 'server/modules/' + path;
    graph = { version: 1, root: releasedPath(declared.root), modules: declared.modules.map(module => ({ ...module, path: releasedPath(module.path), dependencies: module.dependencies.map(releasedPath) })) };
    sourcePath = graph.root;
    sourceRelease = declared.modules.map(module => encode(releasedPath(module.path), sourceText(files.find(file => file.path === module.path))));
  } else {
    const sourceFile = manifest.source || 'main.ink';
    sourceRelease = [encode(sourcePath, sourceText(files.find(file => file.path === sourceFile)))];
  }
  const candidate = { source: sourcePath, exports: [], ...(graph ? { modules: graph } : {}) };
  const program = inkSource(candidate, sourceRelease), artifact = await compileInkProgram(program), entries = inkEntries(artifact.manifest, artifact.module_graph);
  const spec = inkSpec({ ...candidate, view: manifest.ui?.entry ?? null, exports: manifest.exports || entries.filter(entry => entry.name !== manifest.ui?.entry).map(entry => entry.name) });
  const commands = inkCommands(spec, entries);
  const visibleEntries = entries.filter(entry => spec.exports.includes(entry.name) || spec.view === entry.name);
  const metadata = { title: manifest.title || manifest.slug, ink: spec, entries: visibleEntries, namedTypes: artifact.manifest.named_types, compiler: await compilerInfo(), ...(artifact.module_graph ? { moduleGraph: artifact.module_graph } : {}) };
  const release = [
    ...sourceRelease,
    encode('app.json', JSON.stringify(metadata)),
    encode('index.html', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/ink.css"><link rel="stylesheet" href="/app.css"><title>Ink app</title></head><body><main id="app" aria-busy="true"></main><p id="status" role="status"></p><script src="/sdk.js"></script><script type="module" src="/app.mjs"></script></body></html>'),
  ];
  for (const name of ['ink-app.mjs', 'ink-app.css', 'sdk.js', 'desktop-keys.mjs', 'live-query.mjs']) {
    const path = name === 'ink-app.mjs' ? 'app.mjs' : name === 'ink-app.css' ? 'app.css' : name;
    release.push(encode(path, await readFile(new URL('../cli/templates/' + name, import.meta.url))));
  }
  for (const name of ['ink.css', 'base.css', 'components.css', 'tokens.css', 'font.css', 'fonts/inter-latin-wght-normal.woff2', 'fonts/OFL.txt']) {
    release.push(encode('styles/' + name, await readFile(new URL('../sdk/styles/' + name, import.meta.url))));
  }
  const desktop = { entry: 'app', icon: 'code', ...manifest.desktop };
  const iconPath = typeof desktop.icon === 'string' && /\.svg$/i.test(desktop.icon) ? desktop.icon : typeof desktop.icon?.svg === 'string' && !desktop.icon.svg.trim().startsWith('<') ? desktop.icon.svg : null;
  if (iconPath) {
    const icon = files.find(file => file.path === iconPath);
    if (!icon) fail(400, 'The custom icon is missing from the committed source.');
    desktop.icon = { svg: Buffer.from(icon.base64, 'base64').toString('utf8') };
  }
  return { entry: 'index.html', ink: spec, files: release, commands, desktop, capabilities: [...new Set(['code.execute', 'world.read', 'world.write', ...(manifest.capabilities || [])])], ...(source ? { source } : {}) };
}

export async function validateInkBundle(bundle) {
  if (!bundle.ink) {
    if (bundle.commands.some(command => command.handler.type === 'ink')) fail(400, 'Ink commands require an Ink source contract.');
    return;
  }
  const spec = inkSpec(bundle.ink, new Set(bundle.files.map(file => file.path)));
  const artifact = await compileInkProgram(inkSource(spec, bundle.files));
  const expected = inkCommands(spec, inkEntries(artifact.manifest, artifact.module_graph));
  if (JSON.stringify(bundle.commands) !== JSON.stringify((await import('../shared/app-commands.mjs')).validateCommands(expected))) fail(400, 'Ink commands must match the checked source exports and effects.');
}

export async function buildProjectRelease(platform, appId, input = {}) {
  const manifest = JSON.parse(platform.app(appId).body);
  const projectId = input.projectId || manifest.projectId;
  if (!projectId || manifest.projectId && projectId !== manifest.projectId) fail(403, 'Build from the application source project.');
  const commit = input.commit || (await platform.projects.status(projectId)).commit;
  const files = await platform.projects.files(projectId, commit);
  const config = files.find(file => file.path === 'ink-app.json');
  if (!config) fail(400, 'The source project needs ink-app.json.');
  const sourceManifest = JSON.parse(Buffer.from(config.base64, 'base64').toString('utf8'));
  const project = platform.projects.get(projectId);
  const source = { projectId, commit, ...(project.originCommit && project.commit === commit ? { originCommit: project.originCommit } : {}) };
  return platform.createRelease(appId, await buildInkApp(sourceManifest, files, { source }));
}

export async function duplicateProjectApp(platform, appId, { title, configuration = {}, copyData = true } = {}) {
  const original = platform.app(appId), manifest = JSON.parse(original.body);
  if (!manifest.releaseId || !manifest.sourceCommit) fail(409, 'Publish the application source before duplicating it.');
  const project = await platform.projects.duplicate(manifest.projectId, { title: title || original.title + ' copy', commit: manifest.sourceCommit });
  const commit = (await platform.projects.status(project.id)).commit;
  const slug = manifest.slug.slice(0, 25) + '-copy-' + project.id.slice(0, 6);
  const copy = await platform.createApp({ slug, title: title || original.title + ' copy', projectId: project.id, sourceCommit: commit, forkOf: appId, desktop: manifest.desktop, configuration, capabilities: manifest.capabilities });
  if (manifest.desktopOverrides?.icon !== undefined) await platform.updateApp(copy.id, { desktop: { icon: manifest.desktopOverrides.icon } });
  if (copyData) {
    const { appDataSnapshot, forkData } = await import('./app-data.mjs');
    const snapshot = appDataSnapshot(platform.world, appId);
    await platform.copyAppData(appId, copy.id, { snapshot });
    await platform.collaboration?.copyNamespace(appId, copy.id, forkData(snapshot, appId, copy.id));
  }
  const bundle = await platform.bundle(manifest.releaseId);
  const release = await platform.createRelease(copy.id, { ...bundle, source: { projectId: project.id, commit } });
  return platform.publish(copy.id, release.id);
}

export async function installedInk(platform, appId, releaseId) {
  const app = platform.app(appId), manifest = JSON.parse(app.body);
  const selected = releaseId || manifest.releaseId;
  if (!selected || selected !== manifest.releaseId) fail(409, 'The Ink app release changed; refresh before running it.');
  const release = platform.world.get(selected);
  if (release?.kind !== 'release' || JSON.parse(release.body).appId !== appId) fail(404, 'Ink app release not found.');
  const bundle = await platform.bundle(selected);
  if (!bundle.ink) fail(400, 'This app has no Ink source contract.');
  const spec = inkSpec(bundle.ink, new Set(bundle.files.map(file => file.path)));
  const source = inkSource(spec, bundle.files);
  const compiled = await platform.code.compile(source);
  inkCommands(spec, compiled.entries);
  return { source, spec, entries: compiled.entries.filter(entry => spec.exports.includes(entry.name) || spec.view === entry.name), namedTypes: compiled.artifact.manifest.named_types, releaseId: selected, ...(compiled.sourceIdentity ? { sourceIdentity: compiled.sourceIdentity } : {}) };
}

export async function runInstalledInk(platform, appId, input = {}, principal, releaseId) {
  if (principal?.releaseId && input.releaseId && principal.releaseId !== input.releaseId) fail(403, 'A runtime cannot change its release identity.');
  const app = await installedInk(platform, appId, releaseId || principal?.releaseId || input.releaseId);
  if (!app.spec.exports.includes(input.entry) && app.spec.view !== input.entry) fail(403, 'The Ink entry is not exported by this app.');
  const authority = platform.runtime.bind({ owner: false, appId, namespace: appId, releaseId: app.releaseId });
  const result = await platform.code.run({ source: app.source, entry: input.entry, input: input.input, args: input.args, backend: input.backend, namespace: appId, stateKey: 'ink-app:state', principal: authority });
  if (result.needsArguments) fail(400, 'Provide a JSON argument array for this Ink entry.');
  const entry = app.entries.find(entry => entry.name === input.entry), wire = parseExactJSON(result.wire);
  return { ...result, value: entry.action ? result.output.result : result.output, valueWire: stringifyExactJSON(entry.action ? wire.result : wire), releaseId: app.releaseId };
}
