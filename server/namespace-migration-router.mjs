import { isAdmin } from './api-keys.mjs';
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export async function namespaceMigrationRoute(platform, req, res, url, principal, { send, body }) {
  const path = url.pathname.slice('/api/v1'.length);
  if (path === '/migrations/storage-aliases') {
    if (!isAdmin(principal)) fail(403, 'Only the administrator can migrate storage references');
    if (req.method !== 'POST') fail(405, 'Storage alias installation requires POST');
    if (!platform.storage?.installAliases) fail(503, 'Storage alias migration is unavailable');
    send(res, 200, await platform.storage.installAliases(await body(req, 8 * 1024 * 1024)));
    return true;
  }
  if (!path.startsWith('/migrations/namespaces')) return false;
  if (!isAdmin(principal)) fail(403, 'Only the administrator can migrate namespaces');
  const receipt = /^\/migrations\/namespaces\/([a-f0-9]{32})$/.exec(path);
  if (receipt && req.method === 'GET') {
    if (!platform.namespaceMigrations) fail(503, 'Namespace migrations are unavailable');
    send(res, 200, platform.namespaceMigrations.get(receipt[1]));
    return true;
  }
  const match = /^\/migrations\/namespaces\/(plan|apply)$/.exec(path);
  if (req.method !== 'POST' || !match) fail(404, 'Unknown namespace migration operation');
  if (!platform.namespaceMigrations) fail(503, 'Namespace migrations are unavailable');
  const input = await body(req, 64 * 1024 * 1024);
  send(res, 200, await platform.namespaceMigrations[match[1]](input));
  return true;
}
