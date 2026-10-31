import http from 'node:http';
import { extname } from 'node:path';
import { sign, verify } from '../server/platform.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

export class LocalProvider {
  constructor({ originTemplate = process.env.INK_OS_APP_ORIGIN_TEMPLATE } = {}) {
    if (originTemplate && !originTemplate.includes('{release}') && !originTemplate.includes('__RELEASE__')) throw Error('App origin template must contain a release placeholder.');
    this.servers = new Map(); this.originTemplate = originTemplate;
  }
  attach(platform) { this.platform = platform; }
  available(releaseId) { return this.servers.has(releaseId); }
  async deploy({ appId, releaseId, meta, key, origin }) {
    if (this.servers.has(releaseId)) return this.servers.get(releaseId).deployment;
    const bundle = await this.platform.bundle(releaseId);
    const cookieName = 'ink_app_' + releaseId;
    const authenticated = token => {
      const value = verify(token || '', key);
      return value?.appId === appId && value.releaseId === releaseId && value.exp > Date.now();
    };
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', `frame-ancestors ${origin}`);
        if (url.pathname === '/_ink/health') { res.writeHead(200); res.end('ready'); return; }
        if (url.pathname === '/_ink/launch') {
          const ticket = url.searchParams.get('ticket');
          if (!authenticated(ticket)) { res.writeHead(403); res.end('Launch denied'); return; }
          const session = sign({ appId, releaseId, exp: Date.now() + 12 * 3600000 }, key);
          res.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/${this.originTemplate?.startsWith('https:') ? '; Secure' : ''}`);
          url.searchParams.delete('ticket');
          res.writeHead(302, { Location: '/' + url.search }); res.end(); return;
        }
        const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => { const index = item.indexOf('='); return [item.slice(0, index).trim(), item.slice(index + 1)]; }));
        if (!authenticated(cookies[cookieName])) { res.writeHead(401); res.end('Open through Ink OS'); return; }
        if (url.pathname.startsWith('/backend/') || url.pathname.startsWith('/_ink/')) { res.writeHead(503); res.end('This local provider serves frontend releases; configure a backend execution provider for server handlers.'); return; }
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
        const path = decodeURIComponent(url.pathname).replace(/^\/+/, '') || bundle.entry;
        const file = bundle.files.find(item => item.path === path) || (!extname(path) ? bundle.files.find(item => item.path === bundle.entry) : undefined);
        if (!file || file.path === bundle.backend?.entry || file.path.startsWith('server/')) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', mime[extname(file.path)] || 'application/octet-stream');
        res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : Buffer.from(file.base64, 'base64'));
      } catch { res.writeHead(400); res.end('Invalid application request'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const internalURL = `http://127.0.0.1:${server.address().port}`;
    const publicURL = this.originTemplate ? this.originTemplate.replace('{release}', releaseId).replace('__RELEASE__', releaseId) : internalURL;
    const parsed = new URL(publicURL);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/') { server.close(); throw Error('Invalid app origin template.'); }
    const deployment = { provider: 'local', url: publicURL, appId, releaseId };
    this.servers.set(releaseId, { server, deployment, internalURL });
    return deployment;
  }
  route(req, res) {
    if (!this.originTemplate) return false;
    const hostname = new URL('http://' + req.headers.host).hostname;
    const runtime = [...this.servers.values()].find(value => new URL(value.deployment.url).hostname === hostname);
    if (!runtime) return false;
    const proxy = http.request(new URL(req.url, runtime.internalURL), { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(proxy);
    return true;
  }
  async stageEnvironment() { return {}; }
  async prepareEnvironment() {}
  async retire(deployment) {
    const runtime = this.servers.get(deployment.releaseId);
    if (!runtime) return;
    await new Promise((resolve, reject) => runtime.server.close(error => error ? reject(error) : resolve()));
    this.servers.delete(deployment.releaseId);
  }
  async close() { await Promise.all([...this.servers.values()].map(({ deployment }) => this.retire(deployment))); }
}
