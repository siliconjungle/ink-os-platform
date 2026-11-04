import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TransactionJournal,
  publishFile,
  durableDirectory,
} from './transaction-journal.mjs';

/** Private effect observations, continuation state and versioned virtual files.
 * A file mutation and its effect receipt share one durable transaction. */
export class InkEffectsStore {
  constructor(directory) {
    this.directory = directory;
    this.runs = new Map();
    this.files = new Map();
    this.tail = Promise.resolve();
    this.journal = new TransactionJournal(
      join(directory, 'effects.journal'),
      'ink-os-typed-effects-v1',
    );
    this.checkpointSequence = 0;
    this.bytes = 0;
    this.sizes = { runs: new Map(), files: new Map() };
  }
  apply(record) {
    for (const kind of ['runs', 'files'])
      for (const [key, value] of record[kind] || []) {
        this.bytes -= this.sizes[kind].get(key) || 0;
        if (value === null) {
          this[kind].delete(key);
          this.sizes[kind].delete(key);
        } else {
          const size = Buffer.byteLength(JSON.stringify(value));
          this[kind].set(key, value);
          this.sizes[kind].set(key, size);
          this.bytes += size;
        }
      }
  }
  async open() {
    await durableDirectory(this.directory);
    let saved;
    try {
      saved = JSON.parse(
        await readFile(join(this.directory, 'effects.json'), 'utf8'),
      );
      const { checksum, ...body } = saved;
      if (
        checksum !==
        createHash('sha256').update(JSON.stringify(body)).digest('hex')
      )
        throw Error('Effect checkpoint integrity mismatch');
      if (
        !saved.journal ||
        saved.format !== 'ink-os-typed-effects-v1' ||
        !Array.isArray(saved.runs) ||
        !Array.isArray(saved.files)
      )
        throw Error('Invalid effect checkpoint');
      this.apply(saved);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.journal.recover(saved?.journal, (record) => this.apply(record));
    this.checkpointSequence = saved?.journal.sequence || 0;
    return this;
  }
  transact(run) {
    const task = this.tail.then(() => {
      this.journal.check();
      return run();
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async commit(record) {
    if (Buffer.byteLength(JSON.stringify(record)) > 2 * 1024 * 1024)
      throw Object.assign(Error('Effect transaction exceeds 2 MiB'), {
        status: 413,
      });
    let bytes = this.bytes;
    for (const kind of ['runs', 'files'])
      for (const [key, value] of record[kind] || [])
        bytes +=
          (value === null ? 0 : Buffer.byteLength(JSON.stringify(value))) -
          (this.sizes[kind].get(key) || 0);
    if (bytes > 128 * 1024 * 1024)
      throw Object.assign(Error('Effect store exceeds its byte budget'), {
        status: 429,
      });
    await this.journal.append(record);
    this.apply(structuredClone(record));
    if (
      this.journal.sequence - this.checkpointSequence >= 128 ||
      this.journal.bytes >= 8 * 1024 * 1024
    )
      await this.persist();
  }
  async persist() {
    this.journal.check();
    try {
      const body = {
        format: 'ink-os-typed-effects-v1',
        runs: [...this.runs],
        files: [...this.files],
        journal: this.journal.position(),
      };
      await publishFile(
        join(this.directory, 'effects.json'),
        JSON.stringify({
          ...body,
          checksum: createHash('sha256')
            .update(JSON.stringify(body))
            .digest('hex'),
        }),
      );
      await this.journal.rotate();
      this.checkpointSequence = this.journal.sequence;
    } catch (error) {
      this.journal.error = error;
      throw error;
    }
  }
  read(id) {
    this.journal.check();
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }
  update(id, change) {
    return this.transact(async () => {
      const current = this.read(id);
      if (!current)
        throw Object.assign(Error('Effect run not found'), { status: 404 });
      const next = change(current);
      if (!next) return current;
      await this.commit({ runs: [[id, next]] });
      return structuredClone(next);
    });
  }
}
