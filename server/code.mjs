import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from './world.mjs';
import { stateObjectId } from './app-data.mjs';
import { compileInk, compilerRequest, isolatedWorker } from './ink-compiler.mjs';
import { stringifyExactJSON } from '../shared/exact-json.mjs';

export class Code {
  constructor(root, directory = join(root, '.data/code'), world) {
    Object.assign(this, { root, directory, world });
    this.tasks = new Map(); this.compilations = new Map();
  }
  async compile(source) {
    if (typeof source !== 'string') throw Error('Provide Ink source text.');
    if (!/^\s*module\s/m.test(source)) source = 'module app;\n' + source;
    const digest = hash(source);
    if (!this.compilations.has(digest)) {
      const task = compileInk(source).then(artifact => ({
        digest, artifact,
        entries: [
          ...artifact.manifest.functions.filter(fn => !fn.internal && !fn.name.startsWith('__')).map(fn => ({ ...fn, action: false })),
          ...(artifact.manifest.state?.actions || []).map(fn => ({ ...fn, action: true })),
        ],
      }));
      this.compilations.set(digest, task);
      task.catch(() => this.compilations.delete(digest));
      if (this.compilations.size > 16) this.compilations.delete(this.compilations.keys().next().value);
    }
    return this.compilations.get(digest);
  }
  run(input) {
    if (typeof input.source !== 'string') return Promise.reject(Error('Provide Ink source text.'));
    const key = (input.stateKey || hash(input.source || '')) + ':' + (input.namespace || input.instance || 'preview');
    const task = (this.tasks.get(key) || Promise.resolve()).catch(() => {}).then(() => this.execute(input));
    this.tasks.set(key, task);
    task.finally(() => { if (this.tasks.get(key) === task) this.tasks.delete(key); }).catch(() => {});
    return task;
  }
  async loadCheckpoint(namespace, key, principal) {
    if (this.world.collaboration) return this.world.collaboration.state(principal || { namespace }, key, namespace);
    const object = this.world.get(stateObjectId(namespace, key));
    return { value: object && !object.archived ? JSON.parse(object.body) : null, revision: object?.revision || 0 };
  }
  async saveCheckpoint(namespace, key, value, expected, principal) {
    if (this.world.collaboration) return this.world.collaboration.state(principal || { namespace }, key, namespace, value, expected, true);
    return this.world.put({ id: stateObjectId(namespace, key), namespace, kind: 'state', title: key, body: JSON.stringify(value) }, { writer: namespace, expected, actor: 'Ink program', action: 'saved app state', writeAccess: principal?.writeAccess });
  }
  async execute(input) {
    if (input.backend && !['javascript', 'auto', 'native'].includes(input.backend)) throw Object.assign(Error('Choose javascript, auto or native execution.'), { status: 400 });
    const started = performance.now(), compiled = await this.compile(input.source);
    const nativeArtifact = input.backend !== 'javascript' && input.namespace && this.nativeJobs ? await this.nativeJobs.readyFor(input.namespace, input.source, compiled.artifact) : null;
    if (input.backend === 'native' && !nativeArtifact) throw Object.assign(Error('Build the native target for this app before requesting native execution.'), { status: 409 });
    const selected = input.entry ? compiled.entries.find(fn => fn.name === input.entry) : compiled.entries[0];
    if (!selected) throw Error('Select an exported function, query, or change.');
    if (input.input === undefined && selected.params.length !== (input.args || []).length) return { entries: compiled.entries, needsArguments: true, selected: selected.name, digest: compiled.digest };
    const prepared = await compilerRequest({ op: 'prepare', core: compiled.artifact.core, identity: compiled.artifact.manifest.core_sha256, entry: selected.name, input: input.input ?? stringifyExactJSON(input.args || []) });
    const stateKey = input.stateKey || 'ink-program:' + compiled.digest;
    let saved = { value: null, revision: 0 };
    const path = join(this.directory, hash((input.namespace || input.instance || 'preview') + ':' + compiled.digest) + '.json');
    if (selected.action) {
      if (input.namespace && this.world) saved = await this.loadCheckpoint(input.namespace, stateKey, input.principal);
      else { try { saved.value = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (saved.value && saved.value.digest !== compiled.digest) throw Object.assign(Error('Ink state belongs to a different source revision. Migrate or explicitly reset it before running this revision.'), { status: 409 });
    }
    const result = nativeArtifact
      ? await this.nativeJobs.native.run(nativeArtifact, { namespace: input.namespace, entry: selected.name, input: prepared.input, snapshot: saved.value?.snapshot })
      : await isolatedWorker(new URL('./ink-run-worker.mjs', import.meta.url), { artifact: compiled.artifact, selected, input: prepared.input, snapshot: saved.value?.snapshot });
    if (nativeArtifact && result.sourceIdentity !== compiled.artifact.manifest.core_sha256) throw Error('Native artifact source identity mismatch.');
    if (result.committed) {
      const value = { digest: compiled.digest, snapshot: result.snapshot };
      if (input.namespace && this.world) await this.saveCheckpoint(input.namespace, stateKey, value, saved.revision, input.principal);
      else { await mkdir(this.directory, { recursive: true }); await writeFile(path + '.next', JSON.stringify(value), { mode: 0o600, flush: true }); await rename(path + '.next', path); }
    }
    return { output: result.output, wire: result.wire, entries: compiled.entries, selected: selected.name, digest: compiled.digest, elapsed: performance.now() - started, backend: nativeArtifact ? 'native' : 'javascript', sourceHash: compiled.artifact.manifest.core_sha256 };
  }
}
