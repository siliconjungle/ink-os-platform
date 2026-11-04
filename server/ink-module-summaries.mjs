import { createHash } from 'node:crypto';
import {
  compilerRequest,
  compilerInfo,
  inkProgramKey,
} from './ink-compiler.mjs';
export const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const digest = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || ArrayBuffer.isView(value)
        ? value
        : canonical(value),
    )
    .digest('hex');
function typeClosure(values, named) {
  const found = {};
  let work = 0;
  const visit = (value) => {
    if (++work > 100000) throw Error('Module type summary work limit');
    if (!value || typeof value !== 'object') return;
    if (value.kind === 'ref' && !Object.hasOwn(found, value.name)) {
      if (!named[value.name]) throw Error('Missing checked named type');
      found[value.name] = named[value.name];
      visit(found[value.name]);
    }
    for (const item of Object.values(value))
      if (item && typeof item === 'object')
        Array.isArray(item) ? item.forEach(visit) : visit(item);
  };
  values.forEach(visit);
  return found;
}
/** Compiler/parser ownership plus checked types/effects. Summaries never grant
 * rewrite, commutation, profitability or checkpoint migration authority. */
export async function moduleSummaries(
  source,
  artifact,
  { compilerBinding } = {},
) {
  const metadata = await compilerInfo();
  const compiler = compilerBinding || metadata.sha256;
  if (
    ![metadata.sha256, ...(metadata.replayCompatible || [])].includes(compiler)
  )
    throw Error('Unknown module summary compiler');
  const core = JSON.parse(artifact.core).program,
    manifest = artifact.manifest;
  const graph = typeof source === 'string' ? null : source;
  const descriptions = graph
    ? await compilerRequest({ op: 'describeModules', graph })
    : {
        core: manifest.core_sha256,
        modules: [
          {
            path: 'main.ink',
            declarations: [
              ...core.functions.map((f) => f.name),
              ...core.actions.map((a) => a.name),
              ...Object.keys(core.records || {}),
              ...Object.keys(core.enums || {}),
            ],
            templates: [],
          },
        ],
      };
  if (
    descriptions.core !==
      (artifact.original_core_sha256 || manifest.core_sha256) ||
    (graph && descriptions.graph !== artifact.module_graph.identity)
  )
    throw Error('Module description is not bound to this checked source');
  const modules = graph
    ? graph.modules
    : [
        {
          path: 'main.ink',
          name: core.module,
          source,
          dependencies: [],
          exports: [
            ...core.functions.map((f) => f.name),
            ...core.actions.map((a) => a.name),
          ],
        },
      ];
  const entries = [
      ...manifest.functions.map((f) => ({
        ...f,
        action: false,
        change: false,
      })),
      ...(manifest.state?.actions || []).map((a) => ({ ...a, action: true })),
    ],
    summaries = new Map(),
    definitions = new Map(modules.map((m) => [m.path, m]));
  const visit = (path) => {
    if (summaries.has(path)) return summaries.get(path);
    const module = definitions.get(path),
      description = descriptions.modules.find((m) => m.path === path),
      dependencies = module.dependencies
        .map(visit)
        .map((m) => ({ path: m.path, identity: m.identity }));
    const exports = module.exports.map((name) => {
      const entry = entries.find((e) => e.name === name);
      if (entry)
        return {
          name,
          kind: entry.action ? (entry.change ? 'change' : 'query') : 'function',
          params: entry.params,
          result: entry.result,
          precondition: entry.precondition || null,
          roots: (entry.roots || []).map(
            (index) => manifest.state.roots[index].name,
          ),
        };
      const type = manifest.named_types?.[name];
      return {
        name,
        kind: description.templates.includes(name)
          ? 'template'
          : type
            ? 'type'
            : 'declaration',
        ...(type ? { type } : {}),
      };
    });
    const types = typeClosure(exports, manifest.named_types || {}),
      identity = digest({
        schema: 1,
        compiler,
        path: module.path,
        name: module.name,
        source: digest(module.source),
        dependencies,
        exports,
        types,
      });
    const result = {
      schema: 1,
      path: module.path,
      name: module.name,
      source: digest(module.source),
      identity,
      dependencies,
      exports,
      types,
      guarantees:
        module.path === (graph?.root || 'main.ink')
          ? ['checked-entry-effects']
          : ['pure-library', 'templates-checked-at-instantiation'],
    };
    summaries.set(path, result);
    return result;
  };
  modules.forEach((m) => visit(m.path));
  return {
    schema: 1,
    format: 'ink-module-summaries-v1',
    compiler,
    source: inkProgramKey(source),
    core: descriptions.core,
    modules: [...summaries.values()].sort((a, b) =>
      a.path<b.path?-1:a.path>b.path?1:0,
    ),
    authority:
      'source-derived contracts; optimization still requires complete proof replay',
  };
}
