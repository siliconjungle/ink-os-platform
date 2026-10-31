import { pipeline } from 'node:stream/promises';
import { isAdmin } from './api-keys.mjs';
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export const backupControlPath = path => /^\/api\/v1\/backups(?:\/|$)/.test(path);

export async function backupRoute(backups, req, res, url, principal, { send, body }) {
  if (!backupControlPath(url.pathname)) return false;
  if (!principal) fail(401, 'Sign in to Ink OS.');
  if (!isAdmin(principal)) fail(403, 'Only the administrator can manage private backups.');
  if (url.search) fail(400, 'Backup controls do not accept URL parameters.');
  if (url.pathname === '/api/v1/backups') {
    if (req.method === 'GET') { send(res, 200, backups.list()); return true; }
    if (req.method === 'POST') {
      const input = await body(req, 32768);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['operation', 'password', 'timeoutMs', 'remoteAssets'].includes(key))) fail(400, 'Invalid backup request.');
      send(res, 202, await backups.create(input)); return true;
    }
    fail(405, 'Unsupported backup operation.');
  }
  const match = /^\/api\/v1\/backups\/([a-f0-9]{32})(?:\/(download|cancel))?$/.exec(url.pathname);
  if (!match) fail(404, 'Unknown backup operation.');
  const [, operation, action] = match;
  if (!action && req.method === 'GET') { send(res, 200, backups.get(operation)); return true; }
  if (!action && req.method === 'DELETE') { send(res, 200, await backups.remove(operation)); return true; }
  if (action === 'cancel' && req.method === 'POST') { send(res, 200, await backups.cancel(operation)); return true; }
  if (action !== 'download' || !['GET', 'HEAD'].includes(req.method)) fail(405, 'Unsupported backup operation.');
  const { file, job } = await backups.openArchive(operation);
  try {
    const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment; filename="' + operation + '.inkbak"', 'Accept-Ranges': 'bytes', ETag: '"' + job.sha256 + '"', 'X-Ink-Backup-Sha256': job.sha256 };
    let start = 0, end = job.bytes - 1, status = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || !range[1] && !range[2]) { res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + job.bytes }); res.end(); return true; }
      if (!range[1]) start = Math.max(0, job.bytes - Number(range[2]));
      else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= job.bytes) { res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + job.bytes }); res.end(); return true; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${job.bytes}`;
    }
    res.writeHead(status, { ...headers, 'Content-Length': String(end - start + 1) });
    if (req.method === 'HEAD') res.end();
    else await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
    return true;
  } finally { await file.close(); }
}
