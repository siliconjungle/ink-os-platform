import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
const name = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function effectPolicy(
  input = { version: 1, resources: {} },
  { allowHttp = false, environment = process.env } = {},
) {
  if (
    !input ||
    input.version !== 1 ||
    Object.keys(input).some((key) => !['version', 'resources'].includes(key)) ||
    !input.resources ||
    Array.isArray(input.resources) ||
    Object.keys(input.resources).length > 64
  )
    fail('Invalid private effect resource policy');
  const resources = new Map();
  for (const [id, value] of Object.entries(input.resources)) {
    if (
      !name(id) ||
      !value ||
      !['http', 'process'].includes(value.kind) ||
      !Array.isArray(value.namespaces) ||
      !value.namespaces.length ||
      value.namespaces.some(
        (namespace) => namespace !== '*' && !/^[a-f0-9]{32}$/.test(namespace),
      )
    )
      fail('Effect resources require an explicit namespace allowlist');
    if (value.kind === 'http') {
      if (
        Object.keys(value).some(
          (key) =>
            ![
              'kind',
              'namespaces',
              'origin',
              'methods',
              'pathPrefix',
              'headersFromEnv',
              'requireVersion',
            ].includes(key),
        )
      )
        fail('Unknown HTTP policy field');
      const origin = new URL(value.origin);
      if (
        !['https:', ...(allowHttp ? ['http:'] : [])].includes(
          origin.protocol,
        ) ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        !Array.isArray(value.methods) ||
        !value.methods.length ||
        value.methods.some(
          (method) =>
            !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method),
        ) ||
        typeof value.pathPrefix !== 'string' ||
        !value.pathPrefix.startsWith('/') ||
        value.pathPrefix.startsWith('//') ||
        value.pathPrefix.includes('\\') ||
        !/^[A-Za-z0-9._~/-]+$/.test(value.pathPrefix) ||
        value.pathPrefix
          .split('/')
          .some((part) => part === '.' || part === '..') ||
        (value.requireVersion !== undefined &&
          typeof value.requireVersion !== 'boolean')
      )
        fail(
          'HTTP resources require a fixed secure origin, method set and path prefix',
        );
      const headers = {};
      for (const [header, key] of Object.entries(value.headersFromEnv || {})) {
        if (
          !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(header) ||
          [
            'host',
            'connection',
            'content-length',
            'transfer-encoding',
            'expect',
            'upgrade',
            'if-match',
          ].includes(header.toLowerCase()) ||
          typeof key !== 'string' ||
          !/^[A-Z_][A-Z0-9_]{0,99}$/.test(key) ||
          typeof environment[key] !== 'string' ||
          /[\r\n]/.test(environment[key])
        )
          fail('Invalid private HTTP header binding');
        headers[header] = environment[key];
      }
      resources.set(id, { ...value, origin: origin.origin, headers });
    } else {
      if (
        Object.keys(value).some(
          (key) =>
            !['kind', 'namespaces', 'executable', 'args', 'sha256'].includes(
              key,
            ),
        ) ||
        !isAbsolute(value.executable || '') ||
        !Array.isArray(value.args) ||
        value.args.length > 32 ||
        value.args.some(
          (arg) =>
            typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'),
        )
      )
        fail('Processes require a fixed executable and argument vector');
      const executable = await realpath(value.executable),
        info = await stat(executable);
      if (!info.isFile()) fail('Process executable is not a file');
      const sha256 = hash(await readFile(executable));
      if (value.sha256 !== undefined && value.sha256 !== sha256)
        fail('Process policy executable digest mismatch');
      resources.set(id, {
        ...value,
        executable,
        sha256,
        identity: {
          size: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          ino: info.ino,
          dev: info.dev,
        },
      });
    }
  }
  return { resources, hash: hash(JSON.stringify([...resources])), allowHttp };
}
export async function loadEffectPolicy(path, options) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 65536) fail('Effect policy exceeds 64 KiB');
    return effectPolicy(JSON.parse(bytes), options);
  } catch (error) {
    if (error.code === 'ENOENT') return effectPolicy(undefined, options);
    throw error;
  }
}
