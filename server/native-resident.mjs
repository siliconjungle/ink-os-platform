import { spawn } from 'node:child_process';
import { parseExactJSON } from '../shared/exact-json.mjs';
import { publicResult } from '../shared/ink-values.mjs';

export function nativeResident({ executable, compiled, timeout = 30000 }) {
  const artifact = compiled.artifact;
  const child = spawn(executable, ['--resident'], {
    env: {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending,
    failed,
    buffer = Buffer.alloc(0),
    stderr = '';
  const closed = new Promise((resolve) => child.once('close', resolve));
  const refs = (active) => {
    for (const stream of [child, child.stdin, child.stdout, child.stderr])
      stream[active ? 'ref' : 'unref']?.();
  };
  const fail = (error) => {
    failed = error;
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.reject(error);
    }
  };
  child.on('error', fail);
  child.on('exit', (code) =>
    fail(Error('Resident native Ink exited (' + code + '): ' + stderr)),
  );
  child.stdin.on('error', fail);
  child.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-8192);
  });
  child.stdout.on('data', (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    if (buffer.length > 64 * 1024 * 1024) {
      fail(Error('Native response exceeds its storage budget.'));
      child.kill();
      return;
    }
    const end = buffer.indexOf(10);
    if (end < 0) return;
    const line = buffer.subarray(0, end);
    buffer = buffer.subarray(end + 1);
    if (!pending) {
      fail(Error('Unexpected resident native response.'));
      child.kill();
      return;
    }
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    refs(false);
    try {
      const response = parseExactJSON(line.toString());
      if (response.error) throw Error(response.error);
      current.resolve(response.value);
    } catch (error) {
      current.reject(error);
    }
  });
  const raw = (message) => {
    if (failed) return Promise.reject(failed);
    if (pending)
      return Promise.reject(
        Error('Resident native requests must be serialized.'),
      );
    refs(true);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(Error('Native execution exceeded its execution time limit.'));
        child.kill();
      }, timeout);
      pending = { resolve, reject, timer };
      child.stdin.write(JSON.stringify(message) + '\n');
    });
  };
  const call = async (message) => {
    const selected = compiled.entries.find(
      (candidate) => candidate.name === message.entry,
    );
    if (!selected) throw Error('Select an exported native Ink entry.');
    const result = await raw({
      ...message,
      kind: selected.action
        ? selected.change
          ? 'change'
          : 'query'
        : 'function',
    });
    const visible = publicResult(result.output, selected, artifact.manifest);
    if (Buffer.byteLength(visible.wire) > 8 * 1024 * 1024)
      throw Error('Ink output exceeds 8 MiB.');
    return {
      ...visible,
      committed: !!selected.action && result.output.committed === true,
    };
  };
  refs(false);
  return {
    request: async (message) => {
      if (message.op === 'load') {
        await raw({
          op: 'load',
          ...(message.snapshot
            ? {
                snapshotHex: Buffer.from(message.snapshot, 'base64').toString(
                  'hex',
                ),
              }
            : {}),
        });
        for (const item of message.records || []) {
          const result = await call({ ...item, op: 'call' });
          if (!result.committed || result.wire !== item.wire)
            throw Error('Ink application journal replay mismatch.');
        }
        return true;
      }
      if (message.op === 'checkpoint') {
        const result = await raw(message);
        return Buffer.from(result.snapshotHex, 'hex').toString('base64');
      }
      return call(message);
    },
    close: async () => {
      fail(Error('Resident native Ink was evicted.'));
      refs(true);
      child.kill();
      await closed;
    },
  };
}
