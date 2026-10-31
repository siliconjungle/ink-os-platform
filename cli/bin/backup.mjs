#!/usr/bin/env node
import { createStoppedBackup, recoverBackup } from '../../server/backup-recovery.mjs';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';

// Canonicalize only explicitly selected roots/parents (including OS aliases
// such as /tmp). Never resolve archive entries or an existing restore target.
async function selectedPath(path) { const absolute = resolve(path); return join(await realpath(dirname(absolute)), basename(absolute)); }

export async function backupPassword({ options = {}, stdin = process.stdin, env = process.env } = {}) {
  if (options['password-stdin'] && options['password-env']) throw Error('Choose --password-stdin or --password-env NAME');
  if (options['password-stdin'] !== undefined && options['password-stdin'] !== true) throw Error('--password-stdin does not accept a value');
  if (options['password-env'] !== undefined && (typeof options['password-env'] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options['password-env']))) throw Error('Provide an environment variable name with --password-env');
  let password;
  if (options['password-stdin']) {
    const chunks = []; let size = 0;
    for await (const chunk of stdin) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 4098) throw Error('Backup password input exceeds limit'); chunks.push(bytes); }
    password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  } else password = env[options['password-env'] || 'INK_OS_BACKUP_PASSWORD'];
  if (typeof password !== 'string' || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 4096) throw Error('Backup password must contain 12–4096 bytes.');
  return password;
}

/** Offline recovery never claims to stop a running host. */
export async function backupCLI({ sub, options = {}, print = value => console.log(JSON.stringify(value, null, 2)), stdin = process.stdin, env = process.env } = {}) {
  const allowed = new Set(['directory', 'input', 'output', 'offline', 'password-stdin', 'password-env', ...(sub === 'restore' ? ['storage','runtime'] : [])]);
  for (const name of Object.keys(options)) if (!allowed.has(name)) throw Error('Unsupported backup option: --' + name);
  if (!['create', 'restore'].includes(sub)) throw Error('Use backup create --offline --directory DIR --output FILE or backup restore --offline --directory DIR --input FILE');
  if (options.offline !== true) throw Error('Stop the instance host, then specify --offline');
  if (typeof options.directory !== 'string' || typeof options[sub === 'create' ? 'output' : 'input'] !== 'string') throw Error('Provide --directory and ' + (sub === 'create' ? 'output' : 'input'));
  const password = await backupPassword({ options, stdin, env });
  const result = sub === 'create'
    ? await createStoppedBackup({ directory: await realpath(options.directory), archive: await selectedPath(options.output), password, offline: true })
    : await recoverBackup({ directory: await selectedPath(options.directory), archive: await selectedPath(options.input), password, offline: true, storage:options.storage,runtime:options.runtime });
  print(result); return result;
}

export async function main(args = process.argv.slice(2)) {
  const [sub, ...rest] = args, options = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw Error('Unexpected backup argument');
    const name = rest[i].slice(2);
    if (name in options) throw Error('Duplicate backup option');
    options[name] = ['offline', 'password-stdin'].includes(name) ? true : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return backupCLI({ sub, options });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
