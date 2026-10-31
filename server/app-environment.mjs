import{parseEnv}from 'node:util';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const reserved = new Set(['PORT', 'PATH', 'HOME', 'HOSTNAME', 'PWD', 'SHELL', 'USER', 'ENV', 'BASH_ENV', 'NODE_OPTIONS', 'OPENSSL_CONF', 'SSLKEYLOGFILE']);
export function environmentName(name) {
  if (typeof name !== 'string' || name.length > 128 || !/^[A-Z_][A-Z0-9_]*$/.test(name) || reserved.has(name) || /^(INK_|FLY_|NODE_|LD_|DYLD_)/.test(name)) fail(400, 'Use an uppercase environment variable name outside the reserved runtime names.');
  return name;
}
export function environmentValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length || Object.keys(values).length > 100) fail(400, 'Provide 1–100 environment variables.');
  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    environmentName(name);
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 32768) fail(400, 'Environment values must be strings of at most 32 KiB without null bytes.');
    return [name, value];
  }));
}

// Values never enter the shared world, release bundles, or ordinary Machine config.env.
// The envelope key is provisioned separately as a Fly secret on the OS itself.
export class AppEnvironment {
  constructor(directory, key = process.env.INK_OS_ENV_KEY) {
    this.path = join(directory, 'app-environment.json');
    this.key = key && /^[A-Za-z0-9+/]{43}=$/.test(key) ? Buffer.from(key, 'base64') : null;
    this.records = {};
    this.tail = Promise.resolve();
  }
  async open() {
    try { this.records = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  requireKey() { if (this.key?.length !== 32) fail(503, 'App environment encryption is not configured.'); }
  values(appId) {
    const record = this.records[appId];
    if (!record) return {};
    this.requireKey();
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
      cipher.setAAD(Buffer.from('ink-os-env-v1:' + appId));
      cipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(record.ciphertext, 'base64')), cipher.final()]).toString());
    } catch { fail(503, 'App environment could not be decrypted with the configured key.'); }
  }
  list(appId) { return Object.entries(this.records[appId]?.metadata || {}).map(([name, metadata]) => ({ name, ...metadata })).sort((a, b) => a.name.localeCompare(b.name)); }
  remove(appId) {
    const task=this.tail.then(async()=>{const records={...this.records};delete records[appId];await writeFile(this.path+'.next',JSON.stringify(records),{mode:0o600,flush:true});await rename(this.path+'.next',this.path);this.records=records;});this.tail=task.catch(()=>{});return task;
  }
  mutate(appId, values, removed = []) {
    const task = this.tail.then(async () => {
      this.requireKey();
      const previous = this.values(appId), next = { ...previous, ...values }, metadata = { ...this.records[appId]?.metadata }, now = new Date().toISOString();
      for (const [name] of Object.entries(values)) metadata[name] = { createdAt: metadata[name]?.createdAt || now, updatedAt: now };
      for (const name of removed) { delete next[name]; delete metadata[name]; }
      if (Object.keys(next).length > 100 || Buffer.byteLength(JSON.stringify(next)) > 128 * 1024) fail(400, 'An app can have at most 100 variables and 128 KiB of environment data.');
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from('ink-os-env-v1:' + appId));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
      const records = { ...this.records, [appId]: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), metadata } };
      await writeFile(this.path + '.next', JSON.stringify(records), { mode: 0o600, flush: true });
      await rename(this.path + '.next', this.path);
      this.records = records;
      return this.list(appId);
    });
    this.tail = task.catch(() => {});
    return task;
  }
}

export function environmentInput(input){if(typeof input?.dotenv==='string'){if(Buffer.byteLength(input.dotenv)>256*1024)fail(413,'Environment request exceeds 256 KiB');return environmentValues(parseEnv(input.dotenv));}return environmentValues(input?.values);}
