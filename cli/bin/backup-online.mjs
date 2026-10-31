import { randomBytes } from 'node:crypto';
import { open, realpath, link, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { backupPassword } from './backup.mjs';
import { createBackups } from '../../sdk/src/backups.js';

export async function onlineBackupCLI({ sub, id, options, request, download, print, stdin = process.stdin, env = process.env }) {
  const allowed = { create: ['operation', 'timeout-ms', 'local-only', 'password-stdin', 'password-env'], list: [], status: [], cancel: [], delete: [], download: ['output'] };
  if (!allowed[sub]) throw Error('Use backup create/list/status/cancel/download/delete, or backup restore --offline.');
  for (const key of Object.keys(options)) if (key !== 'url' && !allowed[sub].includes(key)) throw Error('Unsupported backup option: --' + key);
  const backups = createBackups({ request: (path, init = {}) => request(path, init.method, init.body), download });
  let result;
  if (sub === 'create') {
    const operation = options.operation || randomBytes(16).toString('hex');
    if (!/^[a-f0-9]{32}$/.test(operation)) throw Error('Provide a 32-character hexadecimal --operation.');
    const timeoutMs = options['timeout-ms'] === undefined ? 300000 : Number(options['timeout-ms']);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000 || options['local-only'] !== undefined && options['local-only'] !== true) throw Error('Provide --timeout-ms 1–3600000; --local-only is a flag.');
    const password = await backupPassword({ options, stdin, env });
    try { result = await backups.create({ operation, password, timeoutMs, remoteAssets: options['local-only'] !== true }); }
    catch (error) { throw Object.assign(Error('Backup request did not return a receipt' + (error.status ? ' (HTTP ' + error.status + ')' : '') + '. Inspect operation ' + operation + ' with backup status before retrying.'), { cause: error, status: error.status, operation }); }
  } else if (sub === 'list') result = await backups.list();
  else if (sub === 'status') result = await backups.get(id);
  else if (sub === 'cancel') result = await backups.cancel(id);
  else if (sub === 'delete') result = await backups.delete(id);
  else {
    if (typeof options.output !== 'string') throw Error('Provide --output FILE for the encrypted archive.');
    const selected = resolve(options.output), parent = await realpath(dirname(selected)), destination = join(parent, basename(selected)), temporary = join(parent, '.ink-backup-download-' + randomBytes(12).toString('hex'));
    const archive = await backups.download(id); let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      for await (const bytes of archive.chunks) { let offset = 0; while (offset < bytes.length) { const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset); if (!bytesWritten) throw Error('Backup download write stopped.'); offset += bytesWritten; } }
      await file.sync(); await file.close(); file = null;
      await link(temporary, destination); await unlink(temporary);
      const directory = await open(parent, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      result = { id, output: destination, bytes: archive.bytes, sha256: archive.sha256 };
    } finally { await archive.cancel(); await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  print(result); return result;
}
