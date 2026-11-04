import { hostBudget } from './execution-budget.mjs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn, fork } from 'node:child_process';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { durableDirectory } from './transaction-journal.mjs';
export const NONE = () => ({ None: null }),
  SOME = (value) => ({ Some: value });
export const optional = (value) =>
  Object.hasOwn(value || {}, 'Some') ? value.Some : undefined;
export const effectFailure = (code, message, certainty = 'not-applied') =>
  Object.assign(Error(message), { effectCode: code, certainty });
const interruption = (signal, message, dispatched) =>
  effectFailure(
    signal.reason?.effectCode ||
      (signal.reason?.name === 'TimeoutError' ? 'Timeout' : 'Cancelled'),
    message,
    dispatched ? 'unknown' : 'not-applied',
  );
export function textBytes(bytes) {
  try {
    return SOME(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return NONE();
  }
}
export function requestBytes(text, bytes, { required = false } = {}) {
  const value = optional(text),
    raw = optional(bytes);
  if (
    (value !== undefined && raw !== undefined) ||
    (required && value === undefined && raw === undefined)
  )
    throw effectFailure('Invalid', 'Choose exactly one text or byte payload');
  if (
    raw !== undefined &&
    (!Array.isArray(raw) ||
      raw.length > 65536 ||
      raw.some(
        (value) =>
          !(typeof value === 'bigint' || Number.isInteger(value)) ||
          value < 0 ||
          value > 255,
      ))
  )
    throw effectFailure(
      'Invalid',
      'Byte payloads require at most 65536 values in 0–255',
    );
  const result =
    raw !== undefined
      ? Buffer.from(raw.map(Number))
      : value !== undefined
        ? Buffer.from(value)
        : undefined;
  if (result && result.length > 65536)
    throw effectFailure('ResourceLimit', 'Payload exceeds 64 KiB');
  return result;
}
export async function httpEffect(
  profile,
  request,
  signal,
  markDispatched,
  owner = 'effects',
  { idempotencyKey } = {},
) {
  return hostBudget.run(
    {
      owner,
      resources: { network: 1, memoryMB: 8 },
      signal,
      label: 'HTTP effect',
    },
    () => dispatchHttpEffect(profile, request, signal, markDispatched, idempotencyKey),
  );
}
async function dispatchHttpEffect(profile, request, signal, markDispatched, idempotencyKey) {
  const base = new URL(profile.origin),
    url = new URL(request.path, base),
    expected = optional(request.expected),
    body = requestBytes(request.body, request.bytes);
  if (
    !request.path.startsWith('/') ||
    request.path.startsWith('//') ||
    request.path.includes('\\') ||
    /%(?:2e|2f|5c|25)/i.test(request.path.split('?')[0]) ||
    /[\x00-\x20]/.test(request.path) ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.pathname === profile.pathPrefix ||
      url.pathname.startsWith(
        profile.pathPrefix.endsWith('/')
          ? profile.pathPrefix
          : profile.pathPrefix + '/',
      )
    ) ||
    !profile.methods.includes(request.method) ||
    (body !== undefined && Buffer.byteLength(body) > 65536)
  )
    throw effectFailure(
      'Denied',
      'HTTP request is outside its fixed resource scope',
    );
  if (
    profile.requireVersion &&
    !['GET', 'HEAD'].includes(request.method) &&
    expected === undefined
  )
    throw effectFailure(
      'Conflict',
      'This HTTP write requires an observed version',
    );
  if (
    expected !== undefined &&
    (/[\r\n]/.test(expected) || Buffer.byteLength(expected) > 1024)
  )
    throw effectFailure('Invalid', 'Invalid HTTP version');
  const headers = {
    ...profile.headers,
    ...(expected !== undefined ? { 'If-Match': expected } : {}),
    // A write sent again after a restart carries the same key, so a server that
    // honours idempotency keys applies it once.
    ...(idempotencyKey && !['GET', 'HEAD'].includes(request.method) ? { 'Idempotency-Key': idempotencyKey } : {}),
    ...(body !== undefined
      ? { 'Content-Length': Buffer.byteLength(body) }
      : {}),
  };
  return new Promise((resolve, reject) => {
    let dispatched = false,
      settled = false,
      total = 0;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(
        error?.effectCode
          ? error
          : effectFailure(
              signal.aborted
                ? signal.reason?.effectCode ||
                    (signal.reason?.name === 'TimeoutError'
                      ? 'Timeout'
                      : 'Cancelled')
                : 'Transport',
              'HTTP request ended without a complete bounded response',
              dispatched ? 'unknown' : 'not-applied',
            ),
      );
    };
    const requestFunction =
      url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFunction(
      url,
      { method: request.method, headers, signal },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > 65536) {
            req.destroy();
            fail(
              effectFailure(
                'ResourceLimit',
                'HTTP response exceeds 64 KiB',
                dispatched ? 'unknown' : 'not-applied',
              ),
            );
          } else chunks.push(chunk);
        });
        res.on('aborted', () => fail());
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode,
            body: textBytes(Buffer.concat(chunks)),
            bytes: [...Buffer.concat(chunks)],
            etag:
              typeof res.headers.etag === 'string'
                ? SOME(res.headers.etag)
                : NONE(),
          });
        });
      },
    );
    req.on('error', fail);
    dispatched = true;
    markDispatched();
    req.end(body);
  });
}
export async function runEffectProcess(
  profile,
  request,
  signal,
  directory,
  markDispatched,
) {
  const inputBytes = requestBytes(request.input, request.bytes, {
    required: true,
  });
  const info = await stat(profile.executable),
    before = profile.identity;
  if (
    ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].some(
      (key) => info[key] !== before[key],
    )
  ) {
    const hash = createHash('sha256')
      .update(await readFile(profile.executable))
      .digest('hex');
    if (hash !== profile.sha256)
      throw effectFailure(
        'Denied',
        'Process executable changed since resource admission',
      );
  }
  if (signal.aborted)
    throw interruption(signal, 'Process cancelled before dispatch', false);
  await durableDirectory(directory);
  const cwd = await mkdtemp(join(directory, 'process-'));
  let child;
  try {
    if (signal.aborted)
      throw interruption(signal, 'Process cancelled before dispatch', false);
    return await new Promise((resolve, reject) => {
      let settled = false,
        spawned = false,
        stdout = [],
        stderr = [],
        size = 0;
      const kill = () => {
        if (!child?.pid) return;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const abort = () => kill();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      child = spawn(profile.executable, profile.args, {
        cwd,
        env: {},
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      child.once('spawn', () => {
        spawned = true;
        markDispatched();
        if (signal.aborted) kill();
      });
      child.once('error', () =>
        finish(
          effectFailure(
            'Process',
            'Process did not start',
            spawned ? 'unknown' : 'not-applied',
          ),
        ),
      );
      const collect = (target) => (chunk) => {
        size += chunk.length;
        if (size > 65536) kill();
        else target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.stdin.on('error', () => {});
      child.once('exit', kill);
      child.once('close', (code, name) => {
        kill();
        if (signal.aborted)
          return finish(
            interruption(
              signal,
              'Process was stopped; external changes are not rolled back',
              spawned,
            ),
          );
        if (size > 65536)
          return finish(
            effectFailure(
              'ResourceLimit',
              'Process output exceeds 64 KiB',
              spawned ? 'unknown' : 'not-applied',
            ),
          );
        finish(null, {
          stdout: textBytes(Buffer.concat(stdout)),
          stderr: textBytes(Buffer.concat(stderr)),
          stdoutBytes: [...Buffer.concat(stdout)],
          stderrBytes: [...Buffer.concat(stderr)],
          exitCode: code ?? -1,
          signal: name ? SOME(name) : NONE(),
        });
      });
      signal.addEventListener('abort', abort, { once: true });
      child.stdin.end(inputBytes);
    });
  } finally {
    if (child && !child.killed) child.kill('SIGKILL');
    await rm(cwd, { recursive: true, force: true });
  }
}

/** A separate supervisor owns the process group. IPC disconnect on host death
 * aborts it, so a killed broker does not leave its normal children running. */
async function dispatchProcessEffect(
  profile,
  request,
  signal,
  directory,
  markDispatched,
) {
  if (signal.aborted)
    throw interruption(signal, 'Process cancelled before dispatch', false);
  return new Promise((resolve, reject) => {
    const worker = fork(
      new URL('./ink-effect-process.mjs', import.meta.url),
      [],
      {
        execArgv: [],
        env: {},
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    let outcome,
      dispatched = false;
    const abort = () => {
      if (worker.connected)
        worker.send(
          {
            cancel: true,
            code:
              signal.reason?.effectCode ||
              (signal.reason?.name === 'TimeoutError'
                ? 'Timeout'
                : 'Cancelled'),
          },
          () => {},
        );
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', (message) => {
      if (message.dispatched) {
        dispatched = true;
        markDispatched();
      }
      if (message.result) outcome = message.result;
    });
    worker.once('error', () => {
      outcome = {
        error: {
          code: 'Process',
          message: 'Process supervisor did not start',
          certainty: dispatched ? 'unknown' : 'not-applied',
        },
      };
    });
    worker.once('exit', () => {
      signal.removeEventListener('abort', abort);
      if (outcome?.value) resolve(outcome.value);
      else
        reject(
          effectFailure(
            outcome?.error?.code || 'Interrupted',
            outcome?.error?.message ||
              'Process supervisor ended without a recorded result',
            outcome?.error?.certainty || 'unknown',
          ),
        );
    });
    worker.send({ profile, request, directory }, () => {});
    if (signal.aborted) abort();
  });
}

export async function processEffect(
  profile,
  request,
  signal,
  directory,
  markDispatched,
  owner = 'effects',
) {
  return hostBudget.run(
    {
      owner,
      resources: { cpu: 1, memoryMB: 512 },
      signal,
      label: 'process effect',
    },
    () =>
      dispatchProcessEffect(
        profile,
        request,
        signal,
        directory,
        markDispatched,
      ),
  );
}
