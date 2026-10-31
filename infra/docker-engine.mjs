import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';

const failure = (status, message, dockerStatus) => Object.assign(Error(message), { status, dockerStatus });
export class DockerEngine {
  constructor({ socket = process.env.INK_OS_DOCKER_SOCKET } = {}) { this.socket = socket; }
  async socketPath() {
    if (this.socket) return this.socket;
    const candidates = process.platform === 'win32' ? ['//./pipe/docker_engine'] : ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock')];
    for (const path of candidates) { try { await access(path); this.socket = path; return path; } catch {} }
    throw failure(503, 'Docker Engine is unavailable. Start an engine or configure INK_OS_DOCKER_SOCKET.');
  }
  async request(path, { method = 'GET', body, missing = false } = {}) {
    const socketPath = await this.socketPath();
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath, path: '/v1.45' + path, method, headers: { 'Content-Type': 'application/json' } }, response => {
        const chunks = []; let size = 0;
        response.on('data', bytes => { size += bytes.length; if (size > 8 * 1024 * 1024) response.destroy(failure(502, 'Docker response exceeded its limit.')); else chunks.push(bytes); });
        response.on('error', () => reject(failure(502, 'Docker response was interrupted.')));
        response.on('end', () => {
          if (missing && response.statusCode === 404) return resolve(null);
          if (response.statusCode < 200 || response.statusCode >= 300) return reject(failure(502, 'Docker request failed (' + response.statusCode + ').', response.statusCode));
          const text = Buffer.concat(chunks).toString('utf8');
          try { resolve(text ? JSON.parse(text) : null); } catch { reject(failure(502, 'Invalid Docker response.')); }
        });
      });
      request.setTimeout(30000, () => request.destroy());
      request.on('error', () => reject(failure(503, 'Docker Engine could not be reached.')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async image(reference) {
    const image = await this.request('/images/' + encodeURIComponent(reference) + '/json', { missing: true });
    if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id || '')) throw failure(503, 'The configured container image is unavailable. Build or load it into Docker Engine first.');
    return image.Id;
  }
}
