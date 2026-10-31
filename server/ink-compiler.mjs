import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

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
export async function compilerInfo() { return (await compilerModule()).metadata; }
