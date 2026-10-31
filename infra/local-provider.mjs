import http from 'node:http';
import { extname } from 'node:path';
import { sign, verify } from '../server/platform.mjs';
import { httpConnections } from '../server/http-connections.mjs';
import { RuntimePool } from '../server/runtime-pool.mjs';
import { requestJSON } from '../server/request-body.mjs';
import { assetManifest, serveGameAsset } from './edge/game-assets.mjs';
import { managedArtifactBucket } from '../server/artifacts.mjs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };

export class LocalProvider {
  constructor({ originTemplate = process.env.INK_OS_APP_ORIGIN_TEMPLATE, compute } = {}) {
    if (originTemplate && !originTemplate.includes('{release}') && !originTemplate.includes('__RELEASE__')) throw Error('App origin template must contain a release placeholder.');
    this.servers = new Map(); this.originTemplate = originTemplate; this.compute = compute;
    this.requests = new Set(); this.responses = new Set(); this.admissionGate = null;
  }
  bindAdmission(gate) {
    if (typeof gate !== 'function' || this.admissionGate && this.admissionGate !== gate) throw Error('Local app admission already belongs to another host gate.');
    this.admissionGate = gate;
  }
  snapshotAdmissionClosed() {
    return !!this.admissionGate && this.admissionGate() === true && [...this.servers.values()].every(runtime => runtime.trackedAdmission === true);
  }
  async attach(platform) {
    this.platform = platform;
    if (!this.compute) return;
    this.compute.attach(platform);
    const idleMs = Number(process.env.INK_OS_DOCKER_IDLE_MS || 120000), machines = Number(process.env.INK_OS_DOCKER_MACHINES || 8);
    if (!Number.isInteger(idleMs) || idleMs < 1000 || !Number.isInteger(machines) || machines < 1 || machines > 1024) throw Error('Docker idle time must be at least 1000 ms and capacity must be 1–1024 containers.');
    this.pool = await new RuntimePool({ directory: platform.directory, provider: this.compute, runtime: platform.runtime, environment: platform.environment, origin: this.compute.origin || platform.origin, maxModuleSlots: machines, maxOCISlots: Math.floor(machines / 2), maxLeases: machines, maxMachines: machines, idleMs }).open();
    platform.runtime.leaseActive = (...args) => this.pool.active(...args);
  }
  async invokeBackend({ appId, releaseId, meta, input }) {
    if (!this.pool) throw Object.assign(Error('Enable Docker backends with INK_OS_BACKENDS=docker and a runtime image.'), { status: 503 });
    return this.pool.invoke(appId, releaseId, meta, input);
  }
  available(releaseId) { return this.servers.has(releaseId); }
  async deploy({ appId, releaseId, meta, key, origin }) {
    if (this.servers.has(releaseId)) return this.servers.get(releaseId).deployment;
    const platform = this.platform, bundle = await platform.bundle(releaseId);
    const assets = assetManifest(bundle);
    const cookieName = 'ink_app_' + releaseId;
    const authenticated = token => {
      const value = verify(token || '', key);
      return value?.appId === appId && value.releaseId === releaseId && value.exp > Date.now();
    };
    const server = http.createServer(async (req, res) => {
      let finish; const task = new Promise(resolve => finish = resolve);
      this.requests.add(task); this.responses.add(res); res.once('close', () => this.responses.delete(res));
      try {
        if (connections.closing) { res.writeHead(503, { Connection: 'close' }); res.end('This app host is stopping.'); return; }
        if (this.admissionGate?.()) { res.writeHead(503, { 'Retry-After': '2' }); res.end('This computer is preserving admitted work before a snapshot.'); return; }
        const url = new URL(req.url, 'http://127.0.0.1');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', `frame-ancestors ${origin}`);
        if (url.pathname === '/_ink/health') { res.writeHead(200); res.end('ready'); return; }
        if (url.pathname === '/_ink/invoke') {
          if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(403); res.end('Denied'); return; }
          const result = await this.invokeBackend({ appId, releaseId, meta: { ...meta, backend: bundle.backend }, input: await requestJSON(req) });
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
        }
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
        const path = decodeURIComponent(url.pathname).replace(/^\/+/, '') || bundle.entry;
        if (path === bundle.backend?.entry || path.startsWith('server/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) { res.writeHead(404); res.end(); return; }
        if (url.pathname.startsWith('/backend/')) {
          if (!bundle.backend) { res.writeHead(404); res.end(); return; }
          const result = await this.invokeBackend({ appId, releaseId, meta: { ...meta, backend: bundle.backend }, input: { path: url.pathname.slice(8) + url.search, method: req.method, ...(!['GET', 'HEAD'].includes(req.method) ? { body: await requestJSON(req) } : {}) } });
          res.writeHead(result.status, result.headers); res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body)); return;
        }
        if (url.pathname.startsWith('/_ink/')) { res.writeHead(404); res.end('Unknown runtime operation'); return; }
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
        if (path.startsWith('_ink/')) { res.writeHead(404); res.end(); return; }
        const asset = assets?.get(path) || (!extname(path) ? assets?.get(bundle.entry) : undefined);
        if (asset) {
          const request = new Request('http://127.0.0.1/', { method: req.method, headers: req.headers.range ? { Range: req.headers.range } : {} });
          const response = await serveGameAsset(request, managedArtifactBucket(platform, appId, asset), asset, res.getHeaders());
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); return; }
          await pipeline(Readable.fromWeb(response.body), res); return;
        }
        const file = bundle.files.find(item => item.path === path) || (!extname(path) ? bundle.files.find(item => item.path === bundle.entry) : undefined);
        if (!file || file.path === bundle.backend?.entry || file.path.startsWith('server/')) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', mime[extname(file.path)] || 'application/octet-stream');
        res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : Buffer.from(file.base64, 'base64'));
      } catch (error) { if (res.destroyed) return; if (res.headersSent) { res.destroy(); return; } res.writeHead(error.status || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message || 'Invalid application request' })); }
      finally { this.requests.delete(task); finish(); }
    });
    const connections = httpConnections(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const internalURL = `http://127.0.0.1:${server.address().port}`;
    const publicURL = this.originTemplate ? this.originTemplate.replace('{release}', releaseId).replace('__RELEASE__', releaseId) : internalURL;
    const parsed = new URL(publicURL);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/') { server.close(); throw Error('Invalid app origin template.'); }
    const deployment = { provider: 'local', url: publicURL, appId, releaseId };
    this.servers.set(releaseId, { server, connections, deployment, internalURL, trackedAdmission: true });
    return deployment;
  }
  route(req, res) {
    if (!this.originTemplate) return false;
    const hostname = new URL('http://' + req.headers.host).hostname;
    const runtime = [...this.servers.values()].find(value => new URL(value.deployment.url).hostname === hostname);
    if (!runtime) return false;
    if (!req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end('Use a local application path'); return true; }
    const proxy = http.request(new URL(req.url, runtime.internalURL), { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(proxy);
    return true;
  }
  async stageEnvironment() { return {}; }
  async prepareEnvironment() {}
  async retire(deployment, { preserveCompute = false } = {}) {
    if (!preserveCompute && this.pool) await this.pool.retireRelease(deployment.appId, deployment.releaseId);
    const runtime = this.servers.get(deployment.releaseId);
    if (!runtime) return;
    await runtime.connections.close();
    this.servers.delete(deployment.releaseId);
  }
  async close() {
    await Promise.all([...this.servers.values()].map(({ deployment }) => this.retire(deployment, { preserveCompute: true })));
    await this.pool?.close();
  }
}
