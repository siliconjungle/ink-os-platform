import { acceptsFile } from './file-types.mjs';
import { desktopFile } from './desktop-placements.mjs';
import { appManifest } from './app-desktop.mjs';

const token = /^[a-z][a-z0-9-]{0,63}$/;
const type = /^(\*|[a-z][a-z0-9-]{0,63}|\.[a-z0-9][a-z0-9.+_-]{0,20}|[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*))$/;
function shape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Declare a data shape');
  for (const [name, kind] of Object.entries(value)) if (!name || !['string','number','boolean','object','array','null'].includes(kind)) throw Error('Shape fields require JSON types');
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
}
export function adapterManifest(input) {
  if (!input || !token.test(input.operation) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw Error('An adapter needs an operation and method name');
  const from = input.input, to = input.output;
  if (!from || !to || typeof to.label !== 'string' || !to.label.trim() || to.label.length > 100) throw Error('Declare adapter input and output');
  const accepts = {};
  if (from.fileTypes !== undefined) {
    if (!Array.isArray(from.fileTypes) || !from.fileTypes.length || from.fileTypes.length > 64 || from.fileTypes.some(t => typeof t !== 'string' || !type.test(t))) throw Error('Declare supported file types');
    accepts.fileTypes = [...new Set(from.fileTypes)].sort();
  }
  if (from.kind !== undefined) { if (!token.test(from.kind)) throw Error('Invalid input kind'); accepts.kind = from.kind; }
  if (from.shape !== undefined) accepts.shape = shape(from.shape);
  if (!accepts.fileTypes && !accepts.kind && !accepts.shape) throw Error('Declare supported files or a data shape');
  if (typeof to.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(to.mime) || !/^\.[a-z0-9]{1,12}$/.test(to.extension || '')) throw Error('Declare an output MIME type and extension');
  return { operation: input.operation, name: input.name.trim(), description: String(input.description || '').slice(0, 500), input: accepts, output: { label: to.label.trim(), mime: to.mime, extension: to.extension, ...(to.shape ? { shape: shape(to.shape) } : {}) } };
}
export function matchesShape(value, fields) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(fields).every(([key, kind]) => Object.hasOwn(value,key) && (kind === 'null' ? value[key] === null : kind === 'array' ? Array.isArray(value[key]) : kind === 'object' ? value[key] !== null && typeof value[key] === 'object' && !Array.isArray(value[key]) : typeof value[key] === kind));
}
export function acceptsAdapter(adapter, object) {
  if (!object || object.archived) return false;
  const input = adapter.input;
  if (input.fileTypes && (!desktopFile(object) || !acceptsFile(input.fileTypes,object))) return false;
  if (input.kind && input.kind !== object.kind) return false;
  if (input.shape) { try { if (!matchesShape(JSON.parse(object.body),input.shape)) return false; } catch { return false; } }
  return true;
}
export function adapterOutput(adapter) {
  return { kind: 'file', namespace: 'os', source: 'result' + adapter.output.extension, body: JSON.stringify({ mime: adapter.output.mime }) };
}
export function publishedAdapters(objects) {
  return objects.filter(o => o.kind === 'app' && o.namespace === 'os' && !o.archived).flatMap(o => {
    const meta = appManifest(o);
    if (!meta.adapter || !meta.releaseId) return [];
    return [{ id: o.id, title: o.title, releaseId: meta.releaseId, installedAt: meta.installedAt || Number(o.created) || 0, ...meta.adapter }];
  }).sort((a,b) => a.installedAt-b.installedAt || a.id.localeCompare(b.id));
}
// Group only methods with the same operation AND the same input/output contract.
export function adapterGroup(adapter) { return JSON.stringify([adapter.operation,adapter.input,adapter.output]); }
export function defaultAdapters(adapters, defaults = {}) {
  const groups = new Map();
  for (const adapter of adapters) { const key = adapterGroup(adapter); if (!groups.has(key) || defaults[key] === adapter.id) groups.set(key,adapter); }
  return [...groups.values()];
}
