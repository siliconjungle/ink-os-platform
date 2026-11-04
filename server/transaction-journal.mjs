import { open, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export const journalOrigin = (core) => hash('ink-os-journal-v1\0' + core);
export async function durableDirectory(path) {
  const first = await mkdir(path, { recursive: true });
  if (!first) return;
  const stop = dirname(resolve(first));
  for (let current = resolve(path); ; current = dirname(current)) {
    const directory = await open(current, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (current === stop) break;
  }
}
export async function publishFile(path, value) {
  await writeFile(path + '.next', value, { mode: 0o600, flush: true });
  await rename(path + '.next', path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// A checkpoint is published before rotating its log. Recovery accepts the old
// prefix only when its hash at the checkpoint position matches the checkpoint.
export class TransactionJournal {
  constructor(path, core) {
    Object.assign(this, {
      path,
      core,
      sequence: 0,
      head: journalOrigin(core),
      bytes: 0,
      error: null,
    });
  }
  check() {
    if (this.error)
      throw Object.assign(
        Error('Journal storage is unavailable; reopen to recover.'),
        { status: 503, cause: this.error },
      );
  }
  async recover(checkpoint, apply) {
    await durableDirectory(dirname(this.path));
    const saved = checkpoint || { sequence: 0, head: journalOrigin(this.core) };
    if (
      !Number.isSafeInteger(saved.sequence) ||
      saved.sequence < 0 ||
      !/^[a-f0-9]{64}$/.test(saved.head)
    )
      throw Error('Invalid journal checkpoint position.');
    let bytes;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (checkpoint)
        throw Error('World journal is missing; restore a complete backup.');
      // Legacy and fresh stores begin with a durable empty log.
      this.sequence = saved.sequence;
      this.head = saved.head;
      await this.rotate();
      return;
    }
    const end = bytes.lastIndexOf(10);
    if (end < 0) throw Error('Journal header is incomplete.');
    const lines = bytes.subarray(0, end).toString('utf8').split('\n');
    const header = JSON.parse(lines.shift());
    if (
      header.format !== 'ink-os-journal-v1' ||
      header.core !== this.core ||
      !Number.isSafeInteger(header.sequence) ||
      header.sequence < 0 ||
      header.sequence > saved.sequence ||
      !/^[a-f0-9]{64}$/.test(header.head)
    )
      throw Error('Journal checkpoint identity mismatch.');
    this.sequence = header.sequence;
    this.head = header.head;
    let matched = this.sequence === saved.sequence && this.head === saved.head;
    for (const line of lines) {
      const record = JSON.parse(line),
        { checksum, ...payload } = record;
      if (
        record.sequence !== this.sequence + 1 ||
        record.previous !== this.head ||
        checksum !== hash(JSON.stringify(payload))
      )
        throw Error('Journal transaction integrity check failed.');
      this.sequence = record.sequence;
      this.head = checksum;
      if (this.sequence === saved.sequence) matched = this.head === saved.head;
      if (this.sequence > saved.sequence) {
        if (!matched) throw Error('Journal checkpoint chain mismatch.');
        await apply(record.data);
      }
    }
    if (!matched) throw Error('Journal is missing its checkpoint prefix.');
    if (end + 1 !== bytes.length) {
      const file = await open(this.path, 'r+');
      try {
        await file.truncate(end + 1);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    this.bytes = end + 1;
  }
  async append(data) {
    this.check();
    const payload = { sequence: this.sequence + 1, previous: this.head, data },
      checksum = hash(JSON.stringify(payload));
    const bytes = Buffer.from(JSON.stringify({ ...payload, checksum }) + '\n');
    let file;
    try {
      file = await open(this.path, 'a', 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!bytesWritten) throw Error('Journal write made no progress.');
        offset += bytesWritten;
      }
      await file.sync();
    } catch (error) {
      this.error = error;
      throw error;
    } finally {
      await file?.close().catch((error) => {
        this.error = error;
      });
    }
    this.check();
    this.sequence++;
    this.head = checksum;
    this.bytes += bytes.length;
  }
  position() {
    return { sequence: this.sequence, head: this.head };
  }
  async rotate() {
    this.check();
    const header =
      JSON.stringify({
        format: 'ink-os-journal-v1',
        core: this.core,
        ...this.position(),
      }) + '\n';
    try {
      await publishFile(this.path, header);
      this.bytes = Buffer.byteLength(header);
    } catch (error) {
      this.error = error;
      throw error;
    }
  }
}
