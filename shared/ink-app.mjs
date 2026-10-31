const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
const entryName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.]{0,100}$/.test(value);
const symbol = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value) && !value.startsWith('__');
const modulePath = value => typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_./-]+\.ink$/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(?:\.git|\.data|\.local|node_modules|\.(?:env|dev\.vars|npmrc)(?:\.|$))/i.test(part));
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));

/** Explicit graph v1. Paths are package-relative; there is no filesystem/network resolver. */
export function inkModuleGraph(input, { sources = false, paths, privatePaths = false } = {}) {
  if (!keys(input, ['version', 'root', 'modules']) || input.version !== 1 || !modulePath(input.root) || !Array.isArray(input.modules) || !input.modules.length || input.modules.length > 64) fail('Provide an explicit version 1 Ink module graph with 1–64 sources.');
  const seen = new Set(), names = new Set(); let bytes = 0;
  const modules = input.modules.map(module => {
    if (!keys(module, ['path', 'name', 'dependencies', 'exports', ...(sources ? ['source'] : [])]) || !modulePath(module.path) || privatePaths && !module.path.startsWith('server/') || paths && !paths.has(module.path) || seen.has(module.path.toLowerCase()) || typeof module.name !== 'string' || module.name.length > 100 || !module.name.split('.').every(symbol) || names.has(module.name)) fail('Invalid, duplicate or missing Ink module path/name.');
    seen.add(module.path.toLowerCase()); names.add(module.name);
    if (!Array.isArray(module.dependencies) || module.dependencies.length > 64 || module.dependencies.some(path => !modulePath(path)) || new Set(module.dependencies).size !== module.dependencies.length || !Array.isArray(module.exports) || module.exports.length > 63 || module.exports.some(name => !symbol(name)) || new Set(module.exports).size !== module.exports.length) fail('Declare unique Ink module dependencies and exports.');
    if (sources) {
      if (typeof module.source !== 'string') fail('Every Ink graph source must be explicit text.');
      bytes += new TextEncoder().encode(module.source).length;
      if (bytes > 128 * 1024) fail('Combined Ink module sources exceed 128 KiB.');
    }
    return { path: module.path, name: module.name, dependencies: [...module.dependencies].sort(), exports: [...module.exports].sort(), ...(sources ? { source: module.source } : {}) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const byPath = new Map(modules.map(module => [module.path, module])), active = new Set(), done = new Set();
  const visit = path => {
    if (active.has(path)) fail('Cyclic Ink module dependency.');
    if (done.has(path)) return;
    const module = byPath.get(path); if (!module) fail('Ink module graph references a missing source: ' + path);
    active.add(path); for (const dependency of module.dependencies) visit(dependency);
    active.delete(path); done.add(path);
  };
  visit(input.root);
  if (done.size !== modules.length) fail('Ink module graph contains unreachable sources.');
  return { version: 1, root: input.root, modules };
}

export function inkSpec(input, paths) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provide an Ink application contract.');
  if (input.version !== undefined && ![1,2].includes(input.version)) fail('Unsupported Ink application contract version.');
  if ((input.host !== undefined) !== (input.version === 2)) fail('Host bindings require Ink application contract version 2.');
  if (typeof input.source !== 'string' || !/^server\/[A-Za-z0-9_./-]+\.ink$/.test(input.source) || input.source.split('/').some(part => part === '..' || part === '.' || !part) || paths && !paths.has(input.source)) fail('Ink source must be a private server/*.ink release file.');
  if (input.view !== undefined && input.view !== null && !entryName(input.view)) fail('Choose a valid Ink view entry.');
  if (!Array.isArray(input.exports) || input.exports.length > 63 || input.exports.some(name => !entryName(name)) || new Set(input.exports).size !== input.exports.length) fail('Declare up to 63 unique Ink exports.');
  const modules = input.modules === undefined ? null : inkModuleGraph(input.modules, { paths, privatePaths: true });
  if (modules && (modules.root !== input.source || [...input.exports, ...(input.view ? [input.view] : [])].some(name => !modules.modules.find(module => module.path === modules.root).exports.includes(name)))) fail('Ink view and app exports must be declared root module exports.');
  const host=input.host===undefined?undefined:inkHost(input.host);
  return { version: host?2:1, source: input.source, view: input.view || null, exports: [...input.exports], ...(modules ? { modules } : {}),...(host?{host}:{}) };
}

export function inkHost(input){
  if(!keys(input,['version','bindings'])||input.version!==1||!Array.isArray(input.bindings)||!input.bindings.length||input.bindings.length>16)fail('Declare 1–16 version 1 host data bindings.');
  const seen=new Set();return{version:1,bindings:input.bindings.map(binding=>{if(!keys(binding,['entry','effect','key'])||!symbol(binding.entry)||seen.has(binding.entry)||!['read','write'].includes(binding.effect)||typeof binding.key!=='string'||!/^[a-z][a-z0-9.-]{0,99}$/.test(binding.key))fail('Host bindings need a unique entry, read/write effect and fixed app-data key.');seen.add(binding.entry);return{entry:binding.entry,effect:binding.effect,key:binding.key};}).sort((a,b)=>a.entry.localeCompare(b.entry))};
}
export function inkHostBindings(spec,entries){
  for(const binding of spec.host?.bindings||[]){const entry=entries.find(entry=>entry.name===binding.entry);if(!entry||entry.action||!spec.exports.includes(entry.name)&&spec.view!==entry.name||entry.params.length!==(binding.effect==='write'?2:1)||entry.params.some(param=>param.type?.kind!=='string')||binding.effect==='write'&&entry.result?.kind!=='string')fail('Host bindings require exported stateless String transforms: read(String), write(String,String)->String.');if(spec.view===entry.name&&binding.effect!=='read')fail('A view cannot perform a host write.');}
  return spec.host?.bindings||[];
}
export function inkPublicEntries(spec,entries){inkHostBindings(spec,entries);return entries.map(entry=>{const binding=spec.host?.bindings.find(binding=>binding.entry===entry.name);return binding?{...entry,params:binding.effect==='read'?[]:[{name:'expectedRevision',type:{kind:'u64'}},...entry.params.slice(1)],hostBinding:binding}:entry;});}

export function inkEntries(manifest, graph) {
  if (graph && (!Array.isArray(graph.root_exports) || graph.root_exports.some(name => !symbol(name)))) fail('Invalid checked Ink root export metadata.');
  return [
    ...manifest.functions.filter(fn => !fn.internal && !fn.name.startsWith('__')).map(fn => ({ ...fn, action: false, change: false })),
    ...(manifest.state?.actions || []).filter(fn => !fn.name.startsWith('__')).map(fn => ({ ...fn, action: true })),
  ].filter(entry => !graph || graph.root_exports.includes(entry.name));
}

export function inkCommands(spec, entries) {
  inkHostBindings(spec,entries);
  if (spec.view) {
    const view = entries.find(entry => entry.name === spec.view);
    if (!view || view.change || (spec.host?.bindings.find(binding=>binding.entry===view.name)?.effect==='read'?view.params.length!==1:view.params.length)) fail('The Ink view must be an exported function or query without arguments.');
  }
  const ids = new Set();
  return spec.exports.map(name => {
    const entry = inkPublicEntries(spec,entries).find(entry => entry.name === name);
    if (!entry || entry.params.length > 16) fail('Ink command is missing or has more than 16 arguments: ' + name);
    const id = 'ink.' + name.toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 59);
    if (ids.has(id)) fail('Ink exports have conflicting command names.');
    ids.add(id);
    return {
      id, title: name.replace(/_/g, ' '),
      description: 'Run ' + name + '.', keywords: ['ink'],
      inputs: entry.params.map((param, index) => ({ name: 'arg' + index, label: param.name, type: 'json', required: true })),
      handler: { type: 'ink', entry: name, arguments: entry.params.map((_param, index) => 'arg' + index) },
      effect: entry.change||entry.hostBinding?.effect==='write' ? 'write' : 'read', idempotent: !entry.change&&entry.hostBinding?.effect!=='write',
      outputs: [{ label: 'Value', path: 'value', type: 'json' }, { label: 'Exact JSON', path: 'valueWire', type: 'json' }],
    };
  });
}
