import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { inkModuleGraph } from '../shared/ink-app.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);

let modulePromise;
async function compilerModule() {
  if (!modulePromise) modulePromise = (async () => {
    let base = new URL('../dist/', import.meta.url);
    let metadata;
    try { metadata = JSON.parse(await readFile(new URL('compiler-info.json', base), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; base = new URL('../public/', import.meta.url); metadata = JSON.parse(await readFile(new URL('compiler-info.json', base), 'utf8')); }
    const bytes = await readFile(new URL('ink-compiler.wasm', base));
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw Error('Ink compiler integrity check failed.');
    return { module: await WebAssembly.compile(bytes), metadata };
  })().catch(error => { modulePromise = null; throw error; });
  return modulePromise;
}

export function isolatedWorker(url, workerData, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      void worker.terminate(); error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Error('Ink operation exceeded its execution time limit.')), timeout);
    worker.once('message', message => finish(message.error ? Error(message.error) : null, message.value));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(Error('Ink worker exited before returning a result (' + code + ').')); });
  });
}

export async function compilerRequest(request, options = {}) {
  const { module } = await compilerModule();
  return isolatedWorker(new URL('./ink-compiler-worker.mjs', import.meta.url), { module, request }, options.timeout);
}
export async function compileInk(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 128 * 1024) throw Error('Ink source must be text of at most 128 KiB.');
  return compilerRequest({ op: 'compile', source });
}
export async function compileInkModules(input) {
  const graph = inkModuleGraph(input, { sources: true });
  const artifact = await compilerRequest({ op: 'compileModules', graph });
  const provenance = { version: 1, root: graph.root, modules: graph.modules.map(({ source, ...module }) => ({ ...module, sha256: sha(source) })) };
  const graphHash = sha(canonical(provenance)), coreHash = sha(artifact.core);
  const identity = sha(canonical({ graph_sha256: graphHash, core_sha256: coreHash }));
  const expected = { ...provenance, root_exports: graph.modules.find(module => module.path === graph.root).exports, graph_sha256: graphHash, core_sha256: coreHash, identity };
  if (canonical(artifact.module_graph) !== canonical(expected) || artifact.manifest.core_sha256 !== coreHash) throw Error('Ink compiler module graph identity mismatch.');
  return artifact;
}
/** The source form is explicit; object inputs are bounded module graphs, never import URLs. */
export function compileInkProgram(source) { return typeof source === 'string' ? compileInk(source) : compileInkModules(source); }
export function normalizeInkProgram(source) {
  if (typeof source === 'string') return source;
  return inkModuleGraph(source, { sources: true });
}
export function inkProgramKey(source) { return sha(typeof source === 'string' ? source : canonical(normalizeInkProgram(source))); }
export function inkProgramIdentity(artifact) {
  return artifact.module_graph ? { version: 1, identity: artifact.module_graph.identity, graphHash: artifact.module_graph.graph_sha256, coreHash: artifact.module_graph.core_sha256 } : null;
}
export async function compilerInfo() { return (await compilerModule()).metadata; }
