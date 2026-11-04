import { hostBudget } from './execution-budget.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, World } from './world.mjs';
import { InkResidents, javascriptResident } from './ink-residents.mjs';
import { InkAppJournal, appJournalFormat } from './ink-app-journal.mjs';
import { withWriteAccess } from './runtime-credentials.mjs';
import { stateObjectId } from './app-data.mjs';
import {
  compileInkProgram,
  normalizeInkProgram,
  inkProgramKey,
  inkProgramIdentity,
  inkOriginalSource,
} from './ink-compiler.mjs';
import { inkEntries } from '../shared/ink-app.mjs';
import { stringifyExactJSON } from '../shared/exact-json.mjs';

export class Code {
  constructor(root, directory = join(root, '.data/code'), world, options = {}) {
    Object.assign(this, { root, directory, world });
    this.tasks = new Map();
    this.pureTasks = new Set();
    this.commitHints=new Map();
    this.budget = options.budget || hostBudget;
    this.compilations = new Map();
    this.residents = new InkResidents(options);
    this.storage = {
      read: (...args) => this.readState(...args),
      batch: (...args) => this.writeStates(...args),
      keys: (...args) => this.stateKeys(...args),
    };
  }
  async compile(source) {
    source = normalizeInkProgram(source);
    if (typeof source === 'string' && !/^\s*module\s/m.test(source))
      source = 'module app;\n' + source;
    const key = inkProgramKey(source);
    if (!this.compilations.has(key)) {
      const task = compileInkProgram(source).then((artifact) => ({
        digest:
          artifact.module_graph?.identity ||
          inkProgramKey(inkOriginalSource(source)),
        artifact,
        source,
        sourceIdentity: inkProgramIdentity(artifact),
        entries: inkEntries(artifact.manifest, artifact.module_graph),
      }));
      this.compilations.set(key, task);
      task.catch(() => this.compilations.delete(key));
      if (this.compilations.size > 16)
        this.compilations.delete(this.compilations.keys().next().value);
    }
    return this.compilations.get(key);
  }
  run(input) {
    if (this.closing)
      return Promise.reject(
        Object.assign(Error('Ink execution is stopping.'), { status: 503 }),
      );
    let source, wire;
    try {
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal))
        throw Object.assign(Error('Invalid execution cancellation signal'), {
          status: 400,
        });
      source = normalizeInkProgram(input.source);
      wire = input.input ?? stringifyExactJSON(input.args || []);
      if (typeof wire !== 'string' || Buffer.byteLength(wire) > 1024 * 1024)
        throw Error('Ink input exceeds 1 MiB.');
      if (
        input.requestId !== undefined &&
        (typeof input.requestId !== 'string' ||
          !input.requestId.length ||
          input.requestId.length > 128)
      )
        throw Error('Invalid Ink request identity.');
    } catch (error) {
      return Promise.reject(error);
    }
    if (input.parallelPure) {
      const task = (async () => {
        const compiled = await this.compile(source),
          entry = compiled.entries.find((entry) => entry.name === input.entry);
        if (!entry || entry.action)
          throw Object.assign(
            Error(
              'Concurrent Ink calls require a compiler-checked pure function',
            ),
            { status: 403 },
          );
        const signal = AbortSignal.any([
          ...(input.signal ? [input.signal] : []),
          AbortSignal.timeout(30000),
        ]);
        for (;;) {
          try {
            return await withWriteAccess(input.principal?.writeAccess, () =>
              this.execute({ ...input, source, wire, signal }),
            );
          } catch (error) {
            if (error.status !== 429 || signal.aborted) throw error;
            await delay(5, undefined, { signal });
          }
        }
      })();
      this.pureTasks.add(task);
      task.finally(() => this.pureTasks.delete(task)).catch(() => {});
      return task;
    }
    return this.serializeState(
      input.namespace || input.instance || 'preview',
      input.stateKey || inkProgramKey(source),
      () =>
        withWriteAccess(input.principal?.writeAccess, () =>
          this.execute({ ...input, source, wire }),
        ),
    );
  }
  serializeState(namespace, stateKey, run) {
    const key = stateKey + ':' + namespace;
    const task = (this.tasks.get(key) || Promise.resolve())
      .catch(() => {})
      .then(run);
    this.tasks.set(key, task);
    task
      .finally(() => {
        if (this.tasks.get(key) === task) this.tasks.delete(key);
      })
      .catch(() => {});
    return task;
  }
  async store() {
    if (this.world) return this.world;
    if (!this.localStore)
      this.localStore = new World(join(this.directory, 'state')).open();
    return this.localStore;
  }
  async readState(namespace, key, principal) {
    const world = await this.store();
    if (world.collaboration)
      return world.collaboration.state(
        principal || { namespace },
        key,
        namespace,
      );
    const object = world.get(stateObjectId(namespace, key));
    return {
      value: object && !object.archived ? JSON.parse(object.body) : null,
      revision: object?.revision || 0,
    };
  }
  async writeStates(namespace, key, expected, changes, principal) {
    const world = await this.store();
    if (world.collaboration)
      return world.collaboration.stateBatch(
        principal || { namespace },
        namespace,
        key,
        expected,
        changes,
      );
    return world.stateBatch(
      namespace,
      key,
      expected,
      changes,
      principal?.writeAccess,
    );
  }
  async stateKeys(namespace, prefix) {
    const world = await this.store();
    if (world.collaboration)
      return world.collaboration.stateKeys(namespace, prefix);
    return world
      .query('in_namespace', [namespace])
      .filter(
        (object) =>
          object.kind === 'state' &&
          !object.archived &&
          object.title.startsWith(prefix),
      )
      .map((object) => object.title);
  }
  async loadCheckpoint(namespace, key, principal) {
    const saved = await this.readState(namespace, key, principal);
    if (saved.value?.format !== appJournalFormat) return saved;
    const journal = new InkAppJournal(this.storage, namespace, key, principal),
      recovery = await journal.recover(saved),
      compiled = await this.compile(recovery.source);
    if (
      compiled.digest !== saved.value.digest ||
      JSON.stringify(compiled.sourceIdentity || undefined) !==
        JSON.stringify(saved.value.sourceIdentity)
    )
      throw Error('Ink journal source identity mismatch.');
    const session = await this.residents.acquire(
      'checkpoint:' + hash(JSON.stringify([namespace, key, compiled.digest])),
      (options) => javascriptResident(compiled, options),
    );
    const endpoint = {
      request: (message) =>
        this.budget.run(
          {
            owner: namespace,
            resources: { cpu: 1 },
            label: 'checkpoint replay',
          },
          () => session.endpoint.request(message),
        ),
    };
    try {
      await endpoint.request({
        op: 'load',
        snapshot: recovery.snapshot,
        records: recovery.records,
      });
      return {
        revision: saved.revision,
        value: {
          digest: compiled.digest,
          snapshot: await endpoint.request({ op: 'checkpoint' }),
          ...(compiled.sourceIdentity
            ? { sourceIdentity: compiled.sourceIdentity }
            : {}),
        },
      };
    } finally {
      await this.residents.drop(session);
    }
  }
  async saveCheckpoint(namespace, key, value, expected, principal) {
    const saved = await this.writeStates(
      namespace,
      key,
      expected,
      [{ key, value }],
      principal,
    );
    await new InkAppJournal(this.storage, namespace, key, principal).collect(
      saved,
    );
    return saved;
  }
  async execute(input) {
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal))
      throw Object.assign(Error('Invalid execution cancellation signal'), {
        status: 400,
      });
    if (
      input.backend &&
      !['javascript', 'auto', 'native'].includes(input.backend)
    )
      throw Object.assign(
        Error('Choose javascript, auto or native execution.'),
        { status: 400 },
      );
    const started = performance.now(),
      compiled = await this.compile(input.source);
    const nativeArtifact =
      input.backend !== 'javascript' && input.namespace && this.nativeJobs
        ? await this.nativeJobs.readyFor(
            input.namespace,
            compiled.source,
            compiled.artifact,
          )
        : null;
    if (input.backend === 'native' && !nativeArtifact)
      throw Object.assign(
        Error(
          'Build the native target for this app before requesting native execution.',
        ),
        { status: 409 },
      );
    const selected = input.entry
      ? compiled.entries.find((fn) => fn.name === input.entry)
      : compiled.entries[0];
    if (!selected)
      throw Error('Select an exported function, query, or change.');
    if (
      input.input === undefined &&
      selected.params.length !== (input.args || []).length
    )
      return {
        entries: compiled.entries,
        needsArguments: true,
        selected: selected.name,
        digest: compiled.digest,
      };
    const namespace =
        input.namespace || hash(input.instance || 'preview').slice(0, 32),
      stateKey = input.stateKey || 'ink-program:' + compiled.digest,
      journal = new InkAppJournal(
        this.storage,
        namespace,
        stateKey,
        input.principal,
      );
    let saved = { value: null, revision: 0 },
      recovery;
    if (selected.action) {
      saved = await journal.read();
      if (!saved.value && !this.world) {
        try {
          saved.value = JSON.parse(
            await readFile(
              join(
                this.directory,
                hash((input.instance || 'preview') + ':' + compiled.digest) +
                  '.json',
              ),
              'utf8',
            ),
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (saved.value && saved.value.digest !== compiled.digest)
        throw Object.assign(
          Error(
            'Ink state belongs to a different source revision. Migrate or explicitly reset it before running this revision.',
          ),
          { status: 409 },
        );
      if (
        saved.value &&
        compiled.sourceIdentity &&
        JSON.stringify(saved.value.sourceIdentity) !==
          JSON.stringify(compiled.sourceIdentity)
      )
        throw Object.assign(
          Error('Ink state module graph identity mismatch.'),
          { status: 409 },
        );
    }
    const key = hash(
      JSON.stringify([
        namespace,
        stateKey,
        inkProgramKey(compiled.source),
        nativeArtifact || 'javascript',
        input.principal?.releaseId || null,
      ]),
    );
    const session = await this.residents.acquire(
      key,
      (options) =>
        nativeArtifact
          ? this.nativeJobs.native.resident(nativeArtifact, {
              namespace: input.namespace,
              compiled,
              ...options,
            })
          : javascriptResident(compiled, options),
      {
        owner: namespace,
        signal: input.signal,
        pooled: !!input.parallelPure && !selected.action,
      },
    );
    const endpoint = session.endpoint;
    const scheduledEndpoint = {
      request: (message) =>
        this.budget.run(
          {
            owner: namespace,
            resources: { cpu: 1 },
            signal: input.signal,
            label: 'Ink execution',
          },
          () => endpoint.request(message),
        ),
    };
    const abort = () => {
      void this.residents.drop(session).catch(() => {});
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal?.aborted)
        throw input.signal.reason || Error('Ink execution cancelled');
      if (selected.action) {
        if (session.revision !== saved.revision) {
          recovery = await journal.recover(saved);
          await journal.collect(saved);
          await scheduledEndpoint.request({
            op: 'load',
            snapshot: recovery.snapshot,
            records: recovery.records,
          });
          session.recovery = recovery;
          session.revision = saved.revision;
        } else recovery = session.recovery;
      }
      const requestHash = hash(
          JSON.stringify([compiled.digest, selected.name, input.wire]),
        ),
        requestId = input.requestId || crypto.randomUUID();
      const previous =
        input.requestId &&
        recovery?.receipts.find((receipt) => receipt.id === input.requestId);
      if (previous && previous.hash !== requestHash)
        throw Object.assign(
          Error(
            'Ink request identity was already used for different arguments.',
          ),
          { status: 409 },
        );
      const result = previous
        ? previous.reply
        : await scheduledEndpoint.request({
            op: 'call',
            entry: selected.name,
            input: input.wire,
          });
      if (result.committed && !previous) {
        const receipt = { id: requestId, hash: requestHash, reply: result },
          record = {
            entry: selected.name,
            input: input.wire,
            wire: result.wire,
            receipt,
          };
        const hintKey=namespace+'\0'+stateKey;this.commitHints.set(hintKey,{source:inkProgramKey(compiled.source),roots:(selected.roots||[]).map(index=>compiled.artifact.manifest.state.roots[index]?.name).filter(Boolean)});let committed;
        try{
        committed = await journal.commit(
          saved,
          recovery,
          compiled,
          record,
          () => scheduledEndpoint.request({ op: 'checkpoint' }),
        );
        }finally{this.commitHints.delete(hintKey);}
        session.revision = committed.revision;
        // Only receipts are needed while the state is resident. Recovery reads
        // the immutable base and tail again after eviction or an external write.
        session.recovery = { ...recovery, receipts: committed.receipts };
      }
      input.principal?.writeAccess?.check();
      return {
        output: result.output,
        wire: result.wire,
        entries: compiled.entries,
        selected: selected.name,
        digest: compiled.digest,
        elapsed: performance.now() - started,
        backend: nativeArtifact ? 'native' : 'javascript',
        sourceHash: compiled.artifact.manifest.core_sha256,
        ...(compiled.sourceIdentity
          ? { sourceIdentity: compiled.sourceIdentity }
          : {}),
      };
    } catch (error) {
      await this.residents.drop(session);
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', abort);
      this.residents.release(session);
    }
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.tasks.values(), ...this.pureTasks]);
    await this.residents.close();
  }
}
