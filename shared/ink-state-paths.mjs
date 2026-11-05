// State paths: the parts of an Ink app's state a read depends on and a commit
// changes. Compilers whose JavaScript lowering maintains filtered views report
// them per declaration (manifest.state.actions[i].deps) and per commit
// (state.takeChanges()):
//
//   Root        any row of the root
//   Root#3      rows filtered view 3 admits, before or after a change
//   Root[k]     the row at key k (u32, i32, u64 or String keys only)
//   Root[*]     some row whose key was not listed
//
// A changed root is always reported by name as well, so readers that only
// know roots stay correct. Native executables report roots and keys with
// `filters: null` (they keep no views). Anything a report cannot describe
// changes every path of the roots involved.

const SCALAR_KEYS = new Set(['u32', 'i32', 'u64', 'string']);

/** The path naming one row, or null when the key cannot be named exactly. */
export function keyPath(root, kind, key) {
  if (!SCALAR_KEYS.has(kind)) return null;
  if (kind === 'string') return typeof key === 'string' ? root + '[' + JSON.stringify(key) + ']' : null;
  if (typeof key === 'bigint') return root + '[' + key + ']';
  if (typeof key === 'number' && Number.isSafeInteger(key)) return root + '[' + BigInt(key) + ']';
  return null;
}

/** Paths a commit changed, from a runtime change report; null to fall back. */
export function changedPaths(changes, state) {
  if (!changes || changes.all || !Array.isArray(changes.roots)) return null;
  const filters = state?.filters || [],
    paths = new Set(changes.roots);
  if (changes.filters === null) {
    // A report without views (native state keeps none): every view of a
    // changed root may have changed.
    for (const root of changes.roots)
      for (const filter of filters) if (state.roots[filter.root]?.name === root) paths.add(filter.path);
  } else
    for (const id of changes.filters || []) {
      const filter = filters[id];
      if (!filter?.path) return null;
      paths.add(filter.path);
    }
  for (const [name, keys] of Object.entries(changes.keys || {})) {
    const root = state.roots.find((r) => r.name === name);
    if (!root) return null;
    if (keys === null) {
      paths.add(name + '[*]');
      continue;
    }
    for (const key of keys) {
      const path = keyPath(name, root.key?.kind, key);
      if (!path) {
        paths.add(name + '[*]');
        break;
      }
      paths.add(path);
    }
  }
  return [...paths].sort();
}

/** Every path a write to these roots may change, for commits without a report. */
export function expandRoots(roots, state) {
  const paths = new Set();
  for (const root of roots) {
    paths.add(root).add(root + '[*]');
    for (const filter of state?.filters || []) if (state.roots[filter.root]?.name === root) paths.add(filter.path);
  }
  return [...paths].sort();
}
