import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, plain } from './world.mjs';import{stateObjectId}from './app-data.mjs';
const execute = promisify(execFile);
function native(value, type, named) {
  if (!type) return value;
  switch (type.kind) {
    case 'ref': return native(value, named[type.name], named);
    case 'u64': case 'i64': return BigInt(value);
    case 'int': return BigInt(value?.Int ?? value);
    case 'list': case 'vector': return value.map(v => native(v, type.element, named));
    case 'record': return Object.fromEntries(type.fields.map(f => [f.name, native(value[f.name], f.type, named)]));
    default: return value;
  }
}
export class Code {
  constructor(root, directory = join(root, '.data/code'),world) { this.world=world;this.directory = directory; this.tasks = new Map(); this.compilations = new Map(); this.root = root; this.compiler = process.env.INK_COMPILER || 'ink'; this.states = new Map(); }
  async compile(source) {
    if (typeof source !== 'string' || source.length > 100000) throw Error('Keep prototype programs below 100 KB');
    const digest = hash(source); let pending = this.compilations.get(digest);
    if (!pending) {
      pending = this.compileSource(source, digest); this.compilations.set(digest, pending);
      pending.catch(() => { if (this.compilations.get(digest) === pending) this.compilations.delete(digest); });
    }
    return pending;
  }
  async compileSource(source, digest) {
    const dir = join(this.directory, digest);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'program.ink'); const output = join(dir, 'program.mjs');
    if (!existsSync(output)) {
      await writeFile(file, /^\s*module\s/m.test(source) ? source : 'module user_program;\n\n' + source);
      try { await execute(this.compiler, ['build', file, '--target', 'javascript', '-o', output], { maxBuffer: 1024 * 1024 }); }
      catch (e) { throw Error((e.stderr || e.message).replaceAll(dir + '/', '')); }
    }
    const module = await import(pathToFileURL(output).href);
    const functions = module.metadata.functions.filter(f => !f.internal && !f.name.startsWith('__'));
    const actions = module.metadata.state?.actions || [];
    return { digest, dir, module, entries: [...functions.map(f => ({ ...f, action: false })), ...actions.map(f => ({ ...f, action: true }))] };
  }
  async run(input) {
    const key = hash(typeof input.source === 'string' ? input.source : '') + ':' + (input.namespace || input.instance || 'preview');
    const next = (this.tasks.get(key) || Promise.resolve()).catch(() => {}).then(() => this.execute(input));
    this.tasks.set(key, next);
    next.finally(() => { if (this.tasks.get(key) === next) this.tasks.delete(key); }).catch(() => {});
    return next;
  }
  async loadCheckpoint(namespace, key, principal) {
    if (this.world.collaboration) return this.world.collaboration.state(principal||{namespace}, key, namespace);
    const object = this.world.get(stateObjectId(namespace, key));
    return { value: object && !object.archived ? JSON.parse(object.body) : null, revision: object?.revision || 0 };
  }
  async saveCheckpoint(namespace, key, value, expected, principal) {
    if (this.world.collaboration) return this.world.collaboration.state(principal||{namespace}, key, namespace, value, expected, true);
    return this.world.put({id:stateObjectId(namespace,key),namespace,kind:'state',title:key,body:JSON.stringify(value)}, {writer:namespace,expected,actor:'Ink program',action:'saved app state',writeAccess:principal?.writeAccess});
  }
  async execute({ source, entry, args = [], instance = '', namespace, principal }) {
    const started = performance.now(); const compiled = await this.compile(source);
    const selected = compiled.entries.find(f => f.name === entry) || compiled.entries[0];
    if (!selected) throw Error('Add an exported function, query, or change to run this program');
    if (selected.params.length !== args.length) return { entries: compiled.entries, needsArguments: true, selected: selected.name, digest: compiled.digest };
    const nativeArgs = args.map((v, i) => native(v, selected.params[i].type, compiled.module.metadata.named_types));
    let output;
    if (selected.action) {
      const stateKey='ink-program:'+compiled.digest;const key = compiled.digest + ':' + (namespace||instance || 'preview'); let state = this.states.get(key);
      const checkpointPath = join(compiled.dir, hash(key) + '.snapshot');
      let saved;
      if (namespace && this.world) {
        saved = await this.loadCheckpoint(namespace, stateKey, principal);
        state = compiled.module.createState();
        if (saved.value !== null) {
          if (saved.value.digest !== compiled.digest || typeof saved.value.snapshot !== 'string') throw Error('Invalid Ink program checkpoint');
          await state.restore(new Uint8Array(Buffer.from(saved.value.snapshot, 'base64')));
        }
      } else if (!state) {
        state = compiled.module.createState();
        try { await state.restore(new Uint8Array(await readFile(checkpointPath))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        this.states.set(key, state);
      }
      const before=await state.checkpoint();output = state.invoke(selected.name, nativeArgs);
      if (output.committed) {
        try{const checkpoint=await state.checkpoint();if(namespace&&this.world){await this.saveCheckpoint(namespace,stateKey,{digest:compiled.digest,snapshot:Buffer.from(checkpoint).toString('base64')},saved.revision,principal);}else{await writeFile(checkpointPath + '.next',checkpoint);await rename(checkpointPath + '.next', checkpointPath);}}catch(error){await state.restore(before);throw error;}
      }
    } else output = compiled.module.callOwned(selected.name, nativeArgs);
    return { output: plain(output), entries: compiled.entries, selected: selected.name, digest: compiled.digest,
      elapsed: performance.now() - started, backend: 'Ink → JavaScript', sourceHash: compiled.module.metadata.core_sha256 };
  }
}
