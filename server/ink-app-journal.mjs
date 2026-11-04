import { createHash } from 'node:crypto';
import { hash } from './world.mjs';
import { inkOriginalSource } from './ink-compiler.mjs';

// Version 2 keeps every write proportional to what changed:
// - the header has a constant size: the base, the newest record descriptor
//   and counters. Records link backwards through their payloads;
// - record payloads reuse 64 slots (`r<seq % 64>`), so a steady stream of
//   commits overwrites keys instead of deleting them. A live chain spans at
//   most 32 consecutive sequence numbers, so a new slot is never referenced;
// - a compaction's base (program source, receipts and state snapshot) is
//   split into content-defined chunks keyed by their hash. Only chunks the
//   previous base lacks are written; a one-row edit rewrites a chunk or two.
// Version 1 journals remain readable and become version 2 on their next commit.
export const appJournalFormat = 'ink-os-app-journal-v2';
const LEGACY = 'ink-os-app-journal-v1';
export const isAppJournal = (value) =>
  value?.format === appJournalFormat || value?.format === LEGACY;
const chunkSize = 32768,
  maxParts = 2048,
  SLOTS = 64,
  TAIL = 31,
  TAIL_BYTES = 1024 * 1024;
// Content-defined chunking (gear hash) over raw bytes: boundaries depend on
// local content, so an insertion only changes the chunks around it. Chunks
// are 2–24 KiB (8 KiB average); base64 keeps each under one 32,768-unit value.
const CDC_MIN = 2048,
  CDC_MAX = 24576,
  CDC_MASK = (1 << 13) - 1,
  GEAR = Uint32Array.from({ length: 256 }, (_, i) =>
    createHash('sha256').update('ink-gear:' + i).digest().readUInt32LE(0),
  );
export function contentChunks(bytes) {
  const cuts = [];
  let start = 0,
    h = 0;
  for (let i = 0; i < bytes.length; i++) {
    h = ((h << 1) + GEAR[bytes[i]]) >>> 0;
    const length = i + 1 - start;
    if ((length >= CDC_MIN && (h & CDC_MASK) === 0) || length >= CDC_MAX) {
      cuts.push([start, i + 1]);
      start = i + 1;
      h = 0;
    }
  }
  if (start < bytes.length || !cuts.length) cuts.push([start, bytes.length]);
  return cuts;
}
function retainReceipts(receipts) {
  while (
    receipts.length > 64 ||
    (receipts.length > 1 && JSON.stringify(receipts).length > 1024 * 1024)
  )
    receipts.shift();
  return receipts;
}
const baseHash = (meta, snapshot) =>
  hash(JSON.stringify([meta.hash, snapshot?.hash ?? null]));

export class InkAppJournal {
  constructor(storage, namespace, key, principal) {
    Object.assign(this, { storage, namespace, key, principal });
    this.prefix = '@ink:' + hash(key) + ':';
  }
  read(key = this.key) {
    return this.storage.read(this.namespace, key, this.principal);
  }
  batch(expected, changes) {
    return this.storage.batch(
      this.namespace,
      this.key,
      expected,
      changes,
      this.principal,
    );
  }
  async write(expected, changes) {
    for (let start = 0; start < changes.length; start += 8)
      await this.batch(expected, changes.slice(start, start + 8));
  }
  /** Version 1 payloads: JSON split across random-id parts. */
  async payload(descriptor) {
    if (
      !descriptor ||
      !descriptor.id?.startsWith(this.prefix) ||
      !Number.isInteger(descriptor.parts) ||
      descriptor.parts < 1 ||
      descriptor.parts > maxParts ||
      !/^[a-f0-9]{64}$/.test(descriptor.hash)
    )
      throw Error('Invalid Ink journal payload descriptor.');
    const chunks = [];
    for (let index = 0; index < descriptor.parts; index++) {
      const part = await this.read(descriptor.id + ':' + index);
      if (typeof part.value !== 'string')
        throw Error('Ink journal payload is missing.');
      chunks.push(part.value);
    }
    const text = chunks.join('');
    if (hash(text) !== descriptor.hash)
      throw Error('Ink journal payload integrity check failed.');
    return JSON.parse(text);
  }
  /** Store bytes as content-addressed chunks, writing only unknown ones. */
  async stageBlob(bytes, known, expected) {
    const chunks = [],
      changes = [];
    for (const [start, end] of contentChunks(bytes)) {
      const part = bytes.subarray(start, end),
        id = hash(part);
      chunks.push(id);
      if (!known.has(id)) {
        known.add(id);
        changes.push({ key: this.prefix + 'c:' + id, value: part.toString('base64') });
      }
    }
    if (chunks.length > maxParts)
      throw Error('Ink checkpoint exceeds its storage budget.');
    await this.write(expected, changes);
    return { chunks, hash: hash(bytes), bytes: bytes.length, written: changes.length };
  }
  async readBlob(descriptor) {
    if (!Array.isArray(descriptor?.chunks) || descriptor.chunks.length > maxParts || !/^[a-f0-9]{64}$/.test(descriptor.hash))
      throw Error('Invalid Ink journal blob descriptor.');
    const parts = [];
    for (const id of descriptor.chunks) {
      const part = await this.read(this.prefix + 'c:' + id);
      if (typeof part.value !== 'string') throw Error('Ink journal chunk is missing.');
      const bytes = Buffer.from(part.value, 'base64');
      if (hash(bytes) !== id) throw Error('Ink journal chunk integrity check failed.');
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    if (hash(bytes) !== descriptor.hash || bytes.length !== descriptor.bytes)
      throw Error('Ink journal blob integrity check failed.');
    return bytes;
  }
  async stageRecord(payload, seq, expected) {
    const text = JSON.stringify(payload),
      parts = Math.max(1, Math.ceil(text.length / chunkSize)),
      slot = seq % SLOTS;
    if (parts > maxParts)
      throw Error('Ink transaction exceeds its storage budget.');
    const changes = [];
    for (let index = 0; index < parts; index++)
      changes.push({
        key: this.prefix + 'r' + slot + ':' + index,
        value: text.slice(index * chunkSize, (index + 1) * chunkSize),
      });
    await this.write(expected, changes);
    return { slot, seq, index: payload.index, parts, hash: hash(text) };
  }
  async readRecord(descriptor) {
    if (
      !Number.isInteger(descriptor?.slot) ||
      descriptor.slot < 0 ||
      descriptor.slot >= SLOTS ||
      !Number.isInteger(descriptor.parts) ||
      descriptor.parts < 1 ||
      descriptor.parts > maxParts ||
      !/^[a-f0-9]{64}$/.test(descriptor.hash)
    )
      throw Error('Invalid Ink journal record descriptor.');
    const chunks = [];
    for (let index = 0; index < descriptor.parts; index++) {
      const part = await this.read(this.prefix + 'r' + descriptor.slot + ':' + index);
      if (typeof part.value !== 'string') throw Error('Ink journal record is missing.');
      chunks.push(part.value);
    }
    const text = chunks.join('');
    if (hash(text) !== descriptor.hash)
      throw Error('Ink journal record integrity check failed.');
    return JSON.parse(text);
  }
  /**
   * Records of a version 2 root from position `from` on, oldest first, with
   * the chain checked back to that position. Returns {records, previous}:
   * `previous` is the descriptor before `from` (null at the base).
   */
  async tail(root, from = 0) {
    if (!Number.isInteger(root.count) || root.count < 0 || root.count > TAIL + 1 || from < 0 || from > root.count)
      throw Error('Invalid Ink journal record count.');
    const records = [];
    let descriptor = root.head;
    for (let index = root.count - 1; index >= from; index--) {
      if (!descriptor || descriptor.index !== index) throw Error('Ink journal transaction chain mismatch.');
      const payload = await this.readRecord(descriptor);
      if (payload.index !== index || payload.base !== root.base.hash)
        throw Error('Ink journal transaction chain mismatch.');
      records.push(payload.record);
      descriptor = payload.previous;
    }
    if (from === 0 && descriptor !== null) throw Error('Ink journal transaction chain mismatch.');
    return { records: records.reverse(), previous: descriptor };
  }
  async recover(saved) {
    const root = saved.value;
    if (!isAppJournal(root))
      return {
        snapshot: root?.snapshot || null,
        records: [],
        receipts: [],
        source: null,
      };
    let base, records;
    if (root.format === LEGACY) {
      if (!Array.isArray(root.records) || root.records.length > 32)
        throw Error('Invalid Ink journal record count.');
      base = await this.payload(root.base);
      records = [];
      let head = root.base.hash;
      for (const descriptor of root.records) {
        if (descriptor.previous !== head)
          throw Error('Ink journal transaction chain mismatch.');
        records.push(await this.payload(descriptor));
        head = descriptor.hash;
      }
      if (head !== root.head) throw Error('Ink journal source or head mismatch.');
    } else {
      if (baseHash(root.base.meta, root.base.snapshot) !== root.base.hash)
        throw Error('Ink journal base mismatch.');
      const meta = JSON.parse((await this.readBlob(root.base.meta)).toString());
      base = {
        ...meta,
        snapshot: root.base.snapshot ? (await this.readBlob(root.base.snapshot)).toString('base64') : null,
      };
      records = (await this.tail(root)).records;
    }
    if (
      base.digest !== root.digest ||
      JSON.stringify(base.sourceIdentity) !== JSON.stringify(root.sourceIdentity)
    )
      throw Error('Ink journal source or head mismatch.');
    const latest = await this.read();
    if (latest.revision !== saved.revision)
      throw Object.assign(
        Error('Ink journal changed while recovering; retry the request.'),
        { status: 409 },
      );
    return {
      snapshot: base.snapshot,
      records,
      receipts: retainReceipts([
        ...(base.receipts || []),
        ...records.map((record) => record.receipt),
      ]),
      source: base.source,
    };
  }
  async commit(saved, recovery, compiled, record, checkpoint, { onHeader } = {}) {
    const previous = saved.value?.format === appJournalFormat ? saved.value : null;
    // The newest reply is always retained, even when it exceeds the target.
    const receipts = retainReceipts([...recovery.receipts, record.receipt]);
    // A version 1 journal compacts onto the current state, which includes its
    // tail records; a full tail compacts as before.
    const compact =
      saved.value?.format === LEGACY ||
      (!!previous && (previous.count >= TAIL || previous.bytes >= TAIL_BYTES));
    let base = previous?.base,
      written = 0;
    if (!previous || compact) {
      // A fresh, legacy or compacting journal starts a new base. Chunks the
      // previous base already holds are reused, not rewritten.
      const known = new Set(previous ? [...previous.base.meta.chunks, ...(previous.base.snapshot?.chunks || [])] : []),
        snapshot = compact ? await checkpoint() : recovery.snapshot,
        meta = {
          source: inkOriginalSource(compiled.source),
          digest: compiled.digest,
          ...(compiled.sourceIdentity ? { sourceIdentity: compiled.sourceIdentity } : {}),
          receipts: compact ? receipts : recovery.receipts,
        };
      const metaBlob = await this.stageBlob(Buffer.from(JSON.stringify(meta)), known, saved.revision),
        snapshotBlob = snapshot == null ? null : await this.stageBlob(Buffer.from(snapshot, 'base64'), known, saved.revision);
      written = metaBlob.written + (snapshotBlob?.written || 0);
      const strip = ({ written: _, ...blob }) => blob;
      base = { meta: strip(metaBlob), snapshot: snapshotBlob && strip(snapshotBlob) };
      base.hash = baseHash(base.meta, base.snapshot);
    }
    const count = compact || !previous ? 0 : previous.count,
      seq = (previous?.seq || 0) + 1,
      head = compact
        ? null
        : await this.stageRecord(
            { index: count, base: base.hash, previous: previous && !compact ? previous.head : null, record },
            seq,
            saved.revision,
          );
    const root = {
      format: appJournalFormat,
      digest: compiled.digest,
      ...(compiled.sourceIdentity ? { sourceIdentity: compiled.sourceIdentity } : {}),
      base,
      head,
      count: compact ? 0 : count + 1,
      seq,
      bytes: compact ? 0 : (previous && !compact ? previous.bytes : 0) + JSON.stringify(record).length,
    };
    // Observers learn the exact header before it lands, so they can tell this
    // commit's state change from any other write that arrives meanwhile.
    onHeader?.(root);
    const committed = await this.batch(saved.revision, [{ key: this.key, value: root }]);
    if (compact || saved.value?.format !== appJournalFormat) await this.collect(committed);
    return { ...committed, header: root, receipts, compacted: compact, chunksWritten: written };
  }
  /** Delete payloads the current journal no longer references. */
  async collect(saved) {
    const keep = new Set(),
      slots = new Map(),
      root = saved.value;
    if (root?.format === appJournalFormat) {
      for (const id of [...root.base.meta.chunks, ...(root.base.snapshot?.chunks || [])])
        keep.add(this.prefix + 'c:' + id);
      let descriptor = root.head;
      while (descriptor) {
        slots.set(descriptor.slot, Math.max(slots.get(descriptor.slot) || 0, descriptor.parts));
        descriptor = descriptor.index > 0 ? (await this.readRecord(descriptor)).previous : null;
      }
    } else if (root?.format === LEGACY)
      for (const descriptor of [root.base, ...root.records])
        for (let index = 0; index < descriptor.parts; index++)
          keep.add(descriptor.id + ':' + index);
    // Record slots outside the chain keep their first part: they are rewritten
    // in place, so deleting them would only leave tombstones behind.
    const slot = new RegExp('^' + this.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'r([0-9]+):([0-9]+)$');
    const garbage = (await this.storage.keys(this.namespace, this.prefix, this.principal)).filter((key) => {
      if (keep.has(key)) return false;
      const match = key.match(slot);
      if (!match) return true;
      const parts = slots.get(Number(match[1]));
      return parts === undefined ? Number(match[2]) > 0 : Number(match[2]) >= parts;
    });
    await this.write(saved.revision, garbage.map((key) => ({ key, delete: true })));
  }
}
