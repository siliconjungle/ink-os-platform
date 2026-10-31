import { DockerEngine } from './docker-engine.mjs';

const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DockerCompute {
  constructor({ engine = new DockerEngine(), runtimeImage = process.env.INK_OS_DOCKER_RUNTIME_IMAGE || 'ink-os-runtime:local', network = process.env.INK_OS_DOCKER_NETWORK || 'bridge', connection = process.env.INK_OS_DOCKER_CONNECTION || 'host', origin = process.env.INK_OS_DOCKER_OS_URL } = {}) {
    if (!['host', 'network'].includes(connection) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(network)) throw Error('Invalid Docker network configuration.');
    Object.assign(this, { engine, runtimeImage, network, connection, origin });
  }
  attach(platform) {
    const id = platform.instanceId || process.env.INK_OS_INSTANCE_ID;
    if (!/^[a-f0-9]{32}$/.test(id || '')) fail(503, 'Docker hosting requires a private instance identity.');
    this.platform = platform; this.instanceId = id; this.instance = 'ink-' + id.slice(0, 12);
  }
  name(slot, backend = false) { return this.instance + '-' + slot.id + (backend ? '-backend' : ''); }
  labels(slot) { return { 'ink.os.instance': this.instanceId, 'ink.os.slot': slot.id, 'ink.os.lease': slot.leaseId }; }
  scoped(container, slot, { oldLease = false } = {}) {
    const labels = container.Config?.Labels;
    if (labels?.['ink.os.instance'] !== this.instanceId || labels?.['ink.os.slot'] !== slot.id || labels?.['ink.os.lease'] !== slot.leaseId && (!oldLease || labels?.['ink.os.lease'] !== slot.deployment?.leaseId)) fail(409, 'Container ownership differs from the saved compute lease.');
    return container;
  }
  async inspect(slot, backend = false, options) {
    const container = await this.engine.request('/containers/' + this.name(slot, backend) + '/json', { missing: true });
    return container && this.scoped(container, slot, options);
  }
  async poolStopped(slot) {
    for (const backend of slot.kind === 'oci' ? [false, true] : [false]) {
      const container = await this.inspect(slot, backend);
      if (container && (container.State.Running || container.State.Paused || container.State.Restarting)) return false;
    }
    return true;
  }
  async networkFor(slot) {
    const name = this.name(slot) + '-net';
    const existing = await this.engine.request('/networks/' + name, { missing: true });
    if (existing) {
      if (existing.Labels?.['ink.os.instance'] !== this.instanceId || existing.Labels?.['ink.os.slot'] !== slot.id) fail(409, 'Container network has another owner.');
    } else await this.engine.request('/networks/create', { method: 'POST', body: { Name: name, Driver: 'bridge', Labels: { 'ink.os.instance': this.instanceId, 'ink.os.slot': slot.id } } });
    return name;
  }
  async removeStopped(slot) {
    for (const backend of [false, true]) {
      const container = await this.inspect(slot, backend, { oldLease: true });
      if (!container) continue;
      if (container.State.Running || container.State.Paused || container.State.Restarting) fail(409, 'Existing container work was preserved; it must finish before reassignment.');
      await this.engine.request('/containers/' + container.Id, { method: 'DELETE' });
    }
  }
  async create(slot, { image, environment, command, network, port, backend = false, memoryMb = 256 }) {
    const name = this.name(slot, backend);
    const host = { NetworkMode: network, Init: true, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], PidsLimit: 128, Memory: memoryMb * 1024 * 1024, NanoCpus: 1000000000, Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=268435456,mode=1777' }, ExtraHosts: ['host.docker.internal:host-gateway'], LogConfig: { Type: 'local', Config: { 'max-size': '5m', 'max-file': '2' } } };
    if (!backend && this.connection === 'host') host.PortBindings = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] };
    const result = await this.engine.request('/containers/create?name=' + name, { method: 'POST', body: { Image: image, Labels: this.labels(slot), Env: Object.entries(environment).map(([name, value]) => name + '=' + value), ...(command ? { Cmd: command } : {}), ExposedPorts: { [String(port) + '/tcp']: {} }, HostConfig: host } });
    if (!/^[a-f0-9]{64}$/.test(result?.Id || '')) fail(502, 'Docker did not return a container identity.');
    return result.Id;
  }
  async assignPoolSlot({ slot, appId, releaseId, meta, key, origin, environment }) {
    const runtimeImage = await this.engine.image(meta.backend?.runtimeImage || this.runtimeImage);
    const backendImage = slot.kind === 'oci' ? await this.engine.image(meta.backend.image) : null;
    await this.removeStopped(slot);
    const privateNetwork = await this.networkFor(slot);
    const internalOrigin = this.origin || origin;
    let backendId;
    if (backendImage) {
      backendId = await this.create(slot, { backend: true, image: backendImage, network: privateNetwork, port: meta.backend.port, command: meta.backend.command, memoryMb: meta.backend.memoryMb, environment: { ...environment, PORT: String(meta.backend.port), INK_OS_URL: internalOrigin, INK_OS_APP_TOKEN: key, INK_OS_APP_ID: appId, INK_OS_RELEASE_ID: releaseId, INK_OS_NAMESPACE: appId } });
      await this.engine.request('/containers/' + backendId + '/start', { method: 'POST' });
    }
    const containerId = await this.create(slot, { image: runtimeImage, network: this.network, port: 8080, memoryMb: meta.backend?.memoryMb, environment: { ...(!backendImage ? environment : {}), PORT: '8080', INK_OS_POOL: '1', INK_OS_URL: internalOrigin, INK_OS_APP_TOKEN: key, INK_OS_APP_ID: appId, INK_OS_NAMESPACE: appId, INK_OS_RELEASE_ID: releaseId, INK_OS_LEASE_ID: slot.leaseId, ...(backendImage ? { INK_OS_BACKEND_URL: 'http://' + this.name(slot, true) + ':' + meta.backend.port } : {}) } });
    if (privateNetwork !== this.network) await this.engine.request('/networks/' + privateNetwork + '/connect', { method: 'POST', body: { Container: containerId } });
    await this.engine.request('/containers/' + containerId + '/start', { method: 'POST' });
    const container = await this.inspect(slot);
    const deployment = this.deployment(slot, container, { runtimeImage, backendImage, backendId, privateNetwork });
    return this.ready(slot, deployment, key);
  }
  deployment(slot, container, { runtimeImage = container.Config.Image, backendImage, backendId, privateNetwork = this.name(slot) + '-net' } = {}) {
    const port = container.NetworkSettings?.Ports?.['8080/tcp']?.find(item => item.HostIp === '127.0.0.1')?.HostPort;
    if (this.connection === 'host' && !/^\d+$/.test(port || '')) fail(502, 'Docker did not publish the runtime on loopback.');
    return { provider: 'docker', containerId: container.Id, ...(backendId ? { backendContainerId: backendId } : {}), runtimeImage, ...(backendImage ? { backendImage } : {}), leaseId: slot.leaseId, network: privateNetwork, url: this.connection === 'network' ? 'http://' + this.name(slot) + ':8080' : 'http://127.0.0.1:' + port };
  }
  async ready(slot, deployment, key) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { const status = await this.poolStatus({ ...slot, deployment }, key); if (status.appId === slot.appId && status.releaseId === slot.releaseId && status.leaseId === slot.leaseId && !status.draining) return deployment; } catch {}
      if (!((await this.inspect(slot))?.State.Running)) fail(502, 'Container runtime exited before becoming ready.');
      await pause(250);
    }
    fail(503, 'Container runtime is not ready. Existing work was preserved; inspect the lease before retrying.');
  }
  async resumePoolSlot({ slot, key }) {
    const container = await this.inspect(slot), backend = slot.kind === 'oci' ? await this.inspect(slot, true) : null;
    if (!container?.State.Running || slot.kind === 'oci' && !backend?.State.Running) fail(503, 'Incomplete container assignment was preserved for inspection.');
    return this.ready(slot, this.deployment(slot, container, { backendId: backend?.Id, backendImage: backend?.Config.Image }), key);
  }
  async call(slot, key, path, input) {
    if (!slot.deployment?.url) fail(503, 'Container assignment has not been confirmed.');
    const response = await fetch(slot.deployment.url + '/_ink/' + path, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(path === 'invoke' ? 60000 : 10000) });
    const result = await response.json();
    if (!response.ok) fail(response.status, result.error || 'Container request failed.');
    return result;
  }
  async poolStatus(slot, key) {
    const container = await this.inspect(slot);
    if (!container?.State.Running) fail(503, 'Container runtime is stopped.');
    if (slot.kind === 'oci' && !(await this.inspect(slot, true))?.State.Running) fail(503, 'OCI backend is stopped.');
    return this.call(slot, key, 'status');
  }
  poolInvoke(slot, key, input) { return this.call(slot, key, 'invoke', input); }
  drainPoolSlot(slot, key, input) { return this.call(slot, key, 'drain', input); }
  async stopPoolSlot(slot) {
    for (const backend of slot.kind === 'oci' ? [false, true] : [false]) {
      const container = await this.inspect(slot, backend);
      if (!container) continue;
      if (container.State.Running) await this.engine.request('/containers/' + container.Id + '/kill?signal=SIGTERM', { method: 'POST' });
    }
    for (let attempt = 0; attempt < 60; attempt++) { if (await this.poolStopped(slot)) return true; await pause(250); }
    return false;
  }
}
