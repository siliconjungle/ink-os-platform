// State footprints of checked Ink programs, from the compiler's mid-level IR.
//
// For every declaration the compiler reports the physical state roots it reads
// and writes (keeps resolved to the roots they are defined over) and whether a
// function is pure. The OS uses these facts to invalidate cross-app reads only
// when a commit writes a root the read depends on, and to admit cross-app
// plans. A compiler without the `footprints` request yields null; callers then
// keep the coarser manifest roots, which are a sound over-approximation.
import { compilerRequest, normalizeInkProgram, inkOriginalSource, inkProgramKey } from './ink-compiler.mjs';
import { keyPath } from '../shared/ink-state-paths.mjs';
import { parseExactJSON } from '../shared/exact-json.mjs';

export const FOOTPRINTS_FORMAT = 'ink-footprints-v1';
const cache = new Map();
const names = value => Array.isArray(value) && value.every(name => typeof name === 'string');

function validate(value) {
  if (value?.format !== FOOTPRINTS_FORMAT || !names(value.states) || !Array.isArray(value.graphs)) throw Error('Invalid Ink footprints.');
  const graphs = new Map();
  for (const g of value.graphs) {
    if (typeof g?.name !== 'string' || !names(g.roots?.read) || !names(g.roots?.write) || typeof g.pure !== 'boolean' || graphs.has(g.name)) throw Error('Invalid Ink footprints.');
    if ([...g.roots.read, ...g.roots.write].some(root => !value.states.includes(root))) throw Error('Ink footprints name an unknown state root.');
    graphs.set(g.name, Object.freeze({ ...g, roots: Object.freeze({ read: Object.freeze([...g.roots.read]), write: Object.freeze([...g.roots.write]) }) }));
  }
  return Object.freeze({ format: value.format, module: value.module, states: Object.freeze([...value.states]), graphs });
}

/** Footprints of a program (planned programs use their original source), or null. */
export function inkFootprints(source) {
  const original = inkOriginalSource(normalizeInkProgram(source)), key = inkProgramKey(original);
  if (!cache.has(key)) {
    const task = compilerRequest(typeof original === 'string' ? { op: 'footprints', source: original } : { op: 'footprints', graph: original })
      .then(validate, error => {
        if (/Unknown compiler request/.test(error.message)) return null;
        throw error;
      });
    cache.set(key, task);
    task.catch(() => cache.delete(key));
    while (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

/** Roots an entry may change when it commits: IR write roots, else every root it touches. */
export function writeRoots(footprints, compiled, entry) {
  const precise = footprints?.graphs.get(entry.name);
  if (precise) return [...precise.roots.write];
  return (entry.roots || []).map(index => compiled.artifact.manifest.state.roots[index]?.name).filter(Boolean);
}

/** Roots an entry's result can depend on. */
export function readRoots(footprints, compiled, entry) {
  const precise = footprints?.graphs.get(entry.name);
  if (precise) return [...new Set([...precise.roots.read, ...precise.roots.write])].sort();
  return (entry.roots || []).map(index => compiled.artifact.manifest.state.roots[index]?.name).filter(Boolean).sort();
}

/**
 * State paths an exported query's result depends on for one input: views and
 * parameter-keyed rows when the compiler reports them (shared/ink-state-paths.mjs),
 * otherwise its roots.
 */
export function readPaths(footprints, compiled, entry, input) {
  if (!Array.isArray(entry?.deps)) return readRoots(footprints, compiled, entry);
  const state = compiled.artifact.manifest.state,
    paths = new Set();
  let args;
  for (const dep of entry.deps) {
    const keyed = /^(.+)\[(\d+)\]$/.exec(dep);
    if (!keyed) {
      paths.add(dep);
      continue;
    }
    if (args === undefined)
      try {
        args = parseExactJSON(input || '[]');
      } catch {
        args = null;
      }
    const root = state.roots.find((r) => r.name === keyed[1]),
      path = root && Array.isArray(args) ? keyPath(keyed[1], root.key?.kind, args[Number(keyed[2])]) : null;
    if (path) paths.add(path).add(keyed[1] + '[*]');
    else paths.add(keyed[1]);
  }
  return [...paths].sort();
}
