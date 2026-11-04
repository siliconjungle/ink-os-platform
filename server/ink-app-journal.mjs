import { randomBytes } from 'node:crypto';
import { hash } from './world.mjs';
import { inkOriginalSource } from './ink-compiler.mjs';

export const appJournalFormat = 'ink-os-app-journal-v1';
const chunkSize = 32768,
  maxParts = 2048;
function retainReceipts(receipts) {
  while (
    receipts.length > 64 ||
    (receipts.length > 1 && JSON.stringify(receipts).length > 1024 * 1024)
  )
    receipts.shift();
  return receipts;
}
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
  async stage(value, expected) {
    const text = JSON.stringify(value),
      parts = Math.max(1, Math.ceil(text.length / chunkSize)),
      id = this.prefix + randomBytes(16).toString('hex');
    if (parts > maxParts)
      throw Error('Ink checkpoint or transaction exceeds its storage budget.');
    for (let start = 0; start < parts; start += 8) {
      const changes = [];
      for (let index = start; index < Math.min(parts, start + 8); index++)
        changes.push({
          key: id + ':' + index,
          value: text.slice(index * chunkSize, (index + 1) * chunkSize),
        });
      await this.batch(expected, changes);
    }
    return { id, parts, hash: hash(text) };
  }
  async recover(saved) {
    const root = saved.value;
    if (root?.format !== appJournalFormat)
      return {
        snapshot: root?.snapshot || null,
        records: [],
        receipts: [],
        source: null,
      };
    if (!Array.isArray(root.records) || root.records.length > 32)
      throw Error('Invalid Ink journal record count.');
    const base = await this.payload(root.base),
      records = [];
    let head = root.base.hash;
    for (const descriptor of root.records) {
      if (descriptor.previous !== head)
        throw Error('Ink journal transaction chain mismatch.');
      const record = await this.payload(descriptor);
      records.push(record);
      head = descriptor.hash;
    }
    if (
      head !== root.head ||
      base.digest !== root.digest ||
      JSON.stringify(base.sourceIdentity) !==
        JSON.stringify(root.sourceIdentity)
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
  async commit(saved, recovery, compiled, record, checkpoint) {
    let root = saved.value?.format === appJournalFormat ? saved.value : null;
    // The newest reply is always retained, even when it exceeds the target.
    const receipts = retainReceipts([...recovery.receipts, record.receipt]);
    const compact =
      !!root && (root.records.length >= 31 || root.bytes >= 1024 * 1024);
    let base = root?.base;
    if (!base || compact) {
      base = await this.stage(
        {
          source: inkOriginalSource(compiled.source),
          digest: compiled.digest,
          ...(compiled.sourceIdentity
            ? { sourceIdentity: compiled.sourceIdentity }
            : {}),
          snapshot: compact ? await checkpoint() : recovery.snapshot,
          receipts: compact ? receipts : recovery.receipts,
        },
        saved.revision,
      );
    }
    const descriptor = compact
      ? null
      : {
          ...(await this.stage(record, saved.revision)),
          previous: root?.head || base.hash,
        };
    const records = compact ? [] : [...(root?.records || []), descriptor];
    root = {
      format: appJournalFormat,
      digest: compiled.digest,
      ...(compiled.sourceIdentity
        ? { sourceIdentity: compiled.sourceIdentity }
        : {}),
      base,
      records,
      head: descriptor?.hash || base.hash,
      bytes: compact ? 0 : (root?.bytes || 0) + JSON.stringify(record).length,
    };
    const committed = await this.batch(saved.revision, [
      { key: this.key, value: root },
    ]);
    if (compact || saved.value?.format !== appJournalFormat)
      await this.collect(committed);
    return { ...committed, receipts };
  }
  async collect(saved) {
    const keep = new Set();
    if (saved.value?.format === appJournalFormat)
      for (const descriptor of [saved.value.base, ...saved.value.records])
        for (let index = 0; index < descriptor.parts; index++)
          keep.add(descriptor.id + ':' + index);
    const garbage = (
      await this.storage.keys(this.namespace, this.prefix, this.principal)
    ).filter((key) => !keep.has(key));
    for (let index = 0; index < garbage.length; index += 8)
      await this.batch(
        saved.revision,
        garbage.slice(index, index + 8).map((key) => ({ key, delete: true })),
      );
  }
}
