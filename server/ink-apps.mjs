import { buildDataPaths, verifyDataPaths, dataPathSummary } from './data-path-planning.mjs';
import { readFile } from 'node:fs/promises';
import { compileInkProgram, compilerInfo, sealInkProgram } from './ink-compiler.mjs';
import { inkEntries, inkCommands, inkSpec, inkModuleGraph,inkPublicEntries } from '../shared/ink-app.mjs';
import{runInkHostBinding}from'./ink-host-bindings.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { sourceFiles } from '../shared/source-files.mjs';
import { EFFECT_CAPABILITIES } from '../shared/ink-effects.mjs';
import { buildImplementation, verifyImplementation, implementationSummary } from './ink-planning.mjs';

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

/** Private release implementations are replayed against the complete original closure. */
export async function inkExecutionSource(input, files) {
  const source = inkSource(input, files);
  if (!input.implementation) return source;
  const file = files.find(file => file.path === input.implementation.path);
  if (!file || Buffer.from(file.base64, 'base64').toString('base64') !== file.base64) fail(400, 'Missing or invalid Ink implementation bytes.');
  const bytes = Buffer.from(file.base64, 'base64'), text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail(400, 'Ink implementation must be exact UTF-8.');
  return (await verifyImplementation(source, text)).execution;
}

export async function buildInkApp(manifest, files, { source, cachedImplementation } = {}) {
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
  const candidate = { source: sourcePath, exports: [], ...(graph ? { modules: graph } : {}),...(manifest.host!==undefined?{version:2,host:manifest.host}:{}) };
  const program = inkSource(candidate, sourceRelease);
  const { implementation, artifact } = cachedImplementation?await verifyImplementation(program,JSON.stringify(cachedImplementation)):await buildImplementation(program, files, manifest.optimisation);
  const entries = inkEntries(artifact.manifest, artifact.module_graph);
  const dataPaths=await buildDataPaths(program,manifest.ui,manifest.storagePlanning,files);
  const spec = inkSpec({ ...candidate, version: 3, implementation: { version: 1, path: 'server/implementation.json' }, ...(dataPaths?{dataPaths:{version:1,path:'server/data-paths.json'}}:{}), ...(manifest.effects?{effects:manifest.effects}:{}),...(manifest.tasks?{tasks:manifest.tasks}:{}),...(manifest.ui?.version===1?{ui:manifest.ui}:{}), view: manifest.ui?.entry ?? null, exports: manifest.exports || entries.filter(entry => entry.name !== manifest.ui?.entry&&!manifest.ui?.components?.some(component=>component.entry===entry.name)&&!manifest.effects?.protocols?.some(protocol=>protocol.resume===entry.name)).map(entry => entry.name) });
  const capabilities=[...new Set(['code.execute','world.read','world.write',...(manifest.capabilities||[])])];
  validateEffectCapabilities(spec,capabilities);
  const commands = inkCommands(spec, entries,artifact.manifest.named_types);
  const visibleEntries = inkPublicEntries(spec,entries,artifact.manifest.named_types).filter(entry => spec.exports.includes(entry.name) || spec.view === entry.name);
  const metadata = { title: manifest.title || manifest.slug, ink: spec, entries: visibleEntries, namedTypes: artifact.manifest.named_types, compiler: await compilerInfo(), implementation: implementationSummary(implementation), ...(dataPaths?{dataPaths:dataPathSummary(dataPaths)}:{}), ...(artifact.module_graph ? { moduleGraph: artifact.module_graph } : {}) };
  const release = [
    ...sourceRelease,
    ...(dataPaths?[encode('server/data-paths.json',JSON.stringify(dataPaths))]:[]),
    encode('server/implementation.json', JSON.stringify(implementation)),
    encode('app.json', JSON.stringify(metadata)),
    encode('index.html', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/ink.css"><link rel="stylesheet" href="/app.css"><title>Ink app</title></head><body><main id="app" aria-busy="true"></main><p id="status" role="status"></p><script src="/sdk.js"></script><script type="module" src="/app.mjs"></script></body></html>'),
  ];
  for (const name of ['ink-app.mjs', 'ink-app.css', 'sdk.js', 'desktop-keys.mjs', 'live-query.mjs','ui.mjs']) {
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
  return { entry: 'index.html', ink: spec, files: release, commands, desktop, capabilities, ...(source ? { source } : {}) };
}

function validateEffectCapabilities(spec,capabilities){if(spec.ui?.components.some(component=>component.read&&component.read.appId!=='self')&&!capabilities?.includes('apps.invoke'))fail(400,'Declare apps.invoke for cross-app UI reads');for(const protocol of spec.effects?.protocols||[])for(const operation of protocol.operations)if(!capabilities?.includes(EFFECT_CAPABILITIES[operation.kind]))fail(400,'Declare '+EFFECT_CAPABILITIES[operation.kind]+' for this effect protocol');}
export async function validateInkBundle(bundle, {allowUnboundUi=false}={}) {
  if (!bundle.ink) {
    if (bundle.commands.some(command => command.handler.type === 'ink')) fail(400, 'Ink commands require an Ink source contract.');
    return;
  }
  const spec = inkSpec(bundle.ink, new Set(bundle.files.map(file => file.path)));
  if (!allowUnboundUi && spec.ui?.components.some(component=>component.data)) fail(400,'Bind every system UI data port before deployment');
  validateEffectCapabilities(spec,bundle.capabilities);
  if(spec.dataPaths)verifyDataPaths(inkSource(spec,bundle.files),spec.ui,JSON.parse(Buffer.from(bundle.files.find(f=>f.path===spec.dataPaths.path).base64,'base64')));
  const artifact = await compileInkProgram(await inkExecutionSource(spec, bundle.files));
  if (spec.tasks) {
    const { checkTaskContract } = await import('./ink-tasks.mjs'), { TASK_CAPABILITIES } = await import('../shared/ink-tasks.mjs');
    const missing = ['code.execute', ...spec.tasks.effects.map(b => TASK_CAPABILITIES[b.kind])].find(c => !bundle.capabilities?.includes(c));
    if (missing) fail(400, 'Declare ' + missing + ' for this tasks contract');
    checkTaskContract(spec.tasks, artifact);
  }
  const expected = inkCommands(spec, inkEntries(artifact.manifest, artifact.module_graph),artifact.manifest.named_types);
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

// A release is admitted once per runtime/code instance. Cached immutable bytes
// remain bound to the current release record digest; app/release fences are
// checked on every request. Ordinary execution does not reload proof packets.
const admittedInk=new WeakMap();
const immutable=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))immutable(item);Object.freeze(value);}return value;};
export async function installedInk(platform, appId, releaseId) {
 const app=platform.app(appId),manifest=JSON.parse(app.body),selected=releaseId||manifest.releaseId;
 if(!selected||selected!==manifest.releaseId)fail(409,'The Ink app release changed; refresh before running it.');
 const release=platform.world.get(selected);if(release?.kind!=='release'||JSON.parse(release.body).appId!==appId)fail(404,'Ink app release not found.');
 let cache=admittedInk.get(platform);if(!cache||cache.code!==platform.code){cache={code:platform.code,entries:new Map(),bytes:0};admittedInk.set(platform,cache);}
 const key=appId+':'+selected+':'+JSON.parse(release.body).digest;if(cache.entries.has(key))return cache.entries.get(key).task;
 const entry={bytes:0};entry.task=(async()=>{
 const bundle=await platform.bundle(selected);if(!bundle.ink)fail(400,'This app has no Ink source contract.');
 const spec=inkSpec(bundle.ink,new Set(bundle.files.map(file=>file.path))),source=sealInkProgram(await inkExecutionSource(spec,bundle.files)),compiled=await platform.code.compile(source);
 inkCommands(spec,compiled.entries,compiled.artifact.manifest.named_types);
 const implementation=spec.implementation?implementationSummary(JSON.parse(Buffer.from(bundle.files.find(file=>file.path===spec.implementation.path).base64,'base64'))):null;
 const paths=spec.dataPaths?verifyDataPaths(inkSource(spec,bundle.files),spec.ui,JSON.parse(Buffer.from(bundle.files.find(f=>f.path===spec.dataPaths.path).base64,'base64'))):null;
 const dataPaths=paths?{identity:paths.identity,queries:paths.queries,plans:paths.plans,workload:{version:1,tables:paths.workload.tables.map(t=>({id:t.id,columns:t.columns,rows:[]})),history:[]}}:null;
 const result=immutable({source,spec,...(dataPaths?{dataPaths}:{}),entries:inkPublicEntries(spec,compiled.entries,compiled.artifact.manifest.named_types).filter(entry=>spec.exports.includes(entry.name)||spec.view===entry.name),namedTypes:compiled.artifact.manifest.named_types,releaseId:selected,...(implementation?{implementation}:{}),...(compiled.sourceIdentity?{sourceIdentity:compiled.sourceIdentity}:{})});
 entry.bytes=Buffer.byteLength(JSON.stringify(result));cache.bytes+=entry.bytes;for(const [id,item]of cache.entries){if(cache.entries.size<=16&&cache.bytes<=64*1024*1024)break;if(item.bytes){cache.entries.delete(id);cache.bytes-=item.bytes;}}
 return result;
 })();cache.entries.set(key,entry);entry.task.catch(()=>{if(cache.entries.get(key)===entry){cache.entries.delete(key);cache.bytes-=entry.bytes;}});return entry.task;
}

export async function runInstalledInk(platform, appId, input = {}, principal, releaseId, control={}) {
  if (principal?.releaseId && input.releaseId && principal.releaseId !== input.releaseId) fail(403, 'A runtime cannot change its release identity.');
  const app = await installedInk(platform, appId, releaseId || principal?.releaseId || input.releaseId);
  if (!app.spec.exports.includes(input.entry) && app.spec.view !== input.entry) fail(403, 'The Ink entry is not exported by this app.');
  if(app.spec.effects?.protocols.some(protocol=>protocol.entry===input.entry)){if(!platform.effects)fail(503,'Typed effect service is unavailable');return platform.effects.run(appId,{...input,releaseId:app.releaseId},principal||{appId,namespace:appId,releaseId:app.releaseId});}
  const hosted=await runInkHostBinding(platform,appId,app,input,principal);if(hosted)return hosted;
  const authority = platform.runtime.bind({ owner: false, appId, namespace: appId, releaseId: app.releaseId });
  const result = await platform.code.run({ source: app.source, entry: input.entry, input: input.input, args: input.args, backend: input.backend, requestId: input.requestId, signal:control.signal, parallelPure:control.parallelPure, namespace: appId, stateKey: 'ink-app:state', principal: authority });
  if (result.needsArguments) fail(400, 'Provide a JSON argument array for this Ink entry.');
  const entry = app.entries.find(entry => entry.name === input.entry), wire = parseExactJSON(result.wire);
  // Entry descriptors are fixed per release and published in its metadata
  // (app.json, installedInk); repeating them made up ~80% of reply bytes.
  const { entries: _entries, ...reply } = result;
  return { ...reply, value: entry.action ? result.output.result : result.output, valueWire: stringifyExactJSON(entry.action ? wire.result : wire), releaseId: app.releaseId };
}
