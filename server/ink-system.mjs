import { validateBundle } from './platform.mjs';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  lstat,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildInkApp,
  validateInkBundle,
  inkExecutionSource,
  inkSource,
} from './ink-apps.mjs';
import {
  compilerInfo,
  compileInkProgram,
  compilerRequest,
} from './ink-compiler.mjs';
import {
  inkEntries,
  inkPublicEntries,
  inkModuleGraph,
} from '../shared/ink-app.mjs';
import { inkUiComponents } from '../shared/ink-ui.mjs';
import { checkUiRead } from './ink-ui-reads.mjs';
import { inkLinkPlan } from '../shared/ink-link-plan.mjs';
import { admitLinkPlan } from './ink-link-plans.mjs';
import { inkFootprints } from './ink-footprints.mjs';
import { parseExactJSON, stringifyExactJSON } from '../shared/exact-json.mjs';
import { digest, canonical } from './ink-module-summaries.mjs';
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
const symbol = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const keys = (v, names) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => names.includes(k));
const packetLimit = 64 * 1024 * 1024;
async function toolIdentity() {
  const files = [
    'server/ink-system.mjs',
    'server/ink-apps.mjs',
    'shared/ink-app.mjs',
    'shared/ink-ui.mjs',
    ...[
      'ink-app.mjs',
      'ink-app.css',
      'sdk.js',
      'desktop-keys.mjs',
      'live-query.mjs',
      'ui.mjs',
    ].map((n) => 'cli/templates/' + n),
    ...[
      'ink.css',
      'base.css',
      'components.css',
      'tokens.css',
      'font.css',
      'fonts/inter-latin-wght-normal.woff2',
      'fonts/OFL.txt',
    ].map((n) => 'sdk/styles/' + n),
  ];
  return digest(
    await Promise.all(
      files.map(async (p) => [
        p,
        digest(await readFile(new URL('../' + p, import.meta.url))),
      ]),
    ),
  );
}
function implementation(bundle) {
  const file = bundle.files.find(
    (f) => f.path === bundle.ink?.implementation?.path,
  );
  if (!file) fail('System units require checked implementation releases');
  return JSON.parse(Buffer.from(file.base64, 'base64'));
}
async function describe(name, bundle) {
  await validateInkBundle(bundle, { allowUnboundUi: true });
  const saved = implementation(bundle);
  if (!saved.modules) fail('System units require checked module summaries');
  const artifact = await compileInkProgram(
      await inkExecutionSource(bundle.ink, bundle.files),
    ),
    entries = inkPublicEntries(
      bundle.ink,
      inkEntries(artifact.manifest, artifact.module_graph),
      artifact.manifest.named_types,
    ),
    components = inkUiComponents(
      bundle.ink,
      entries,
      artifact.manifest.named_types,
    );
  return {
    name,
    bundleHash: digest(bundle),
    source: saved.source,
    implementation: saved.checked,
    targets: saved.targets,
    modules: saved.modules,
    entries,
    namedTypes: artifact.manifest.named_types,
    components,
    capabilities: bundle.capabilities,
    storage: artifact.manifest.state?.roots || [],
    effects: bundle.ink.effects || null,
  };
}
function linkGraph(units, links) {
  if (!Array.isArray(links) || links.length > 128)
    fail('System links exceed 128');
  const byName = new Map(units.map((u) => [u.name, u])),
    ports = new Set(),
    edges = [];
  for (const link of links) {
    if (
      !keys(link, ['provider', 'entry', 'consumer', 'component', 'input', 'plan']) ||
      !byName.has(link.provider) ||
      !byName.has(link.consumer) ||
      typeof link.entry !== 'string' ||
      typeof link.component !== 'string' ||
      (link.input !== undefined &&
        (typeof link.input !== 'string' ||
          Buffer.byteLength(link.input) > 65536))
    )
      fail('Invalid system query connection');
    const p = byName.get(link.provider),
      c = byName.get(link.consumer),
      component = c.components.find((c) => c.name === link.component),
      port = link.consumer + '\0' + link.component;
    if (
      !component?.port ||
      !c.capabilities.includes('apps.invoke') ||
      ports.has(port)
    )
      fail('Connect a unique typed data port with apps.invoke');
    ports.add(port);
    const entry = checkUiRead(
      {
        spec: { exports: p.exportNames },
        entries: p.entries,
        namedTypes: p.namedTypes,
      },
      link.entry,
      component.data,
    );
    edges.push({
      ...link,
      input: link.input || '[]',
      ...(link.plan !== undefined ? { plan: inkLinkPlan(link.plan) } : {}),
      type: digest({ params: entry.params, result: component.data }),
      observes: {
        provider: link.provider,
        roots: entry.roots || [],
        replyVersions: 'preserved',
      },
      authority: 'readonly query; no write commutation claim',
    });
  }
  for (const u of units)
    for (const c of u.components)
      if (c.port && !ports.has(u.name + '\0' + c.name))
        fail('Unconnected system UI port');
  const active = new Set(),
    done = new Set(),
    order = [];
  const visit = (name) => {
    if (active.has(name)) fail('System deployment links must be acyclic');
    if (done.has(name)) return;
    active.add(name);
    for (const e of edges)
      if (e.consumer === name && e.provider !== name) visit(e.provider);
    active.delete(name);
    done.add(name);
    order.push(name);
  };
  for (const u of units) visit(u.name);
  return { edges, order };
}
async function graphFor(apps, links) {
  const units = [];
  for (const app of apps) {
    const u = await describe(app.name, app.bundle);
    u.manifest = digest(app.manifest);
    u.registration = {
      slug: app.manifest.slug,
      title: app.manifest.title || app.manifest.slug,
    };
    u.exportNames = app.bundle.ink.exports;
    for (const c of u.components) c.port = !!c.data && !c.query && !c.read;
    units.push(u);
  }
  const { edges, order } = linkGraph(units, links);
  // Plans are admitted here as at run time: the footprint of the exact
  // releases must stay within the declared link (server/ink-link-plans.mjs).
  const programs = new Map();
  const program = (name) => {
    if (!programs.has(name))
      programs.set(name, (async () => {
        const bundle = apps.find((a) => a.name === name).bundle,
          source = await inkExecutionSource(bundle.ink, bundle.files),
          artifact = await compileInkProgram(source);
        return { compiled: { artifact, entries: inkEntries(artifact.manifest, artifact.module_graph) }, footprints: await inkFootprints(source), capabilities: bundle.capabilities || [] };
      })());
    return programs.get(name);
  };
  for (const edge of edges.filter((e) => e.plan)) {
    const p = await program(edge.provider),
      c = await program(edge.consumer),
      unit = units.find((u) => u.name === edge.consumer),
      admitted = admitLinkPlan({
        binding: { appId: 'unit:' + edge.provider, releaseId: 'unit', entry: edge.entry, input: edge.input, plan: edge.plan },
        data: unit.components.find((x) => x.name === edge.component).data,
        provider: { ...p, capabilities: [...p.capabilities, 'code.execute'] },
        consumer: { ...c, appId: 'unit:' + edge.consumer, releaseId: 'unit', capabilities: [...c.capabilities, 'code.execute'] },
      });
    edge.footprint = admitted.footprint;
    edge.code = admitted.code;
  }
  for (const edge of edges) {
    const bundle = apps.find((a) => a.name === edge.provider).bundle,
      saved = implementation(bundle);
    await compilerRequest({
      op: 'prepare',
      core: saved.artifact.core,
      identity: saved.artifact.manifest.core_sha256,
      entry: edge.entry,
      input: edge.input,
    });
  }
  const value = {
    format: 'ink-system-graph-v1',
    version: 1,
    units,
    links: edges,
    order,
    budget: 'shared-host-execution-budget',
    checking: 'complete source and proof replay per independently compiled app',
  };
  return { ...value, identity: digest(value) };
}
function checkCacheInput(app, bundle) {
  const m = app.manifest,
    files = new Map(
      app.files.map((f) => [
        f.path,
        Buffer.from(f.base64, 'base64').toString('utf8'),
      ]),
    );
  const expected = m.modules
    ? inkModuleGraph(
        {
          ...m.modules,
          root: 'server/modules/' + m.modules.root,
          modules: m.modules.modules.map((x) => ({
            ...x,
            path: 'server/modules/' + x.path,
            dependencies: x.dependencies.map((p) => 'server/modules/' + p),
            source: files.get(x.path),
          })),
        },
        { sources: true },
      )
    : files.get(m.source || 'main.ink');
  if (canonical(expected) !== canonical(inkSource(bundle.ink, bundle.files)))
    fail('Cached unit belongs to different source');
  for (const [field, value] of Object.entries({
    view: m.ui?.entry || null,
    ui: m.ui?.version === 1 ? m.ui : undefined,
    host: m.host,
    effects: m.effects,
    exports: m.exports,
  }))
    if (
      value !== undefined &&
      canonical(bundle.ink[field]) !== canonical(value)
    )
      fail('Cached unit contract changed');
  if (
    canonical([...bundle.capabilities].sort()) !==
    canonical(
      [
        ...new Set([
          'code.execute',
          'world.read',
          'world.write',
          ...(m.capabilities || []),
        ]),
      ].sort(),
    )
  )
    fail('Cached capabilities changed');
  const sort = (v) =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  if (implementation(bundle).selection.mode !== m.optimisation.mode)
    fail('Cached planning provenance changed');
  const plan = implementation(bundle).plan;
  if (m.optimisation.mode === 'baseline' && JSON.parse(plan).steps.length)
    fail('A baseline unit cannot reuse a selected plan');
  if (
    m.optimisation.mode === 'replay' &&
    stringifyExactJSON(sort(parseExactJSON(plan))) !==
      stringifyExactJSON(sort(parseExactJSON(files.get(m.optimisation.plan))))
  )
    fail('Cached unit selected a different plan');
}
let cacheTail = Promise.resolve();
async function saveCache(directory, key, bundle) {
  const task = cacheTail
    .catch(() => {})
    .then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink())
        throw Error('Cache directory cannot be a symlink');
      const path = join(directory, key + '.json'),
        next = path + '.' + crypto.randomUUID();
      try {
        await writeFile(next, JSON.stringify(bundle), {
          mode: 0o600,
          flag: 'wx',
        });
        await rename(next, path);
      } finally {
        await rm(next, { force: true });
      }
      const files = [];
      for (const name of await readdir(directory))
        if (/^[a-f0-9]{64}\.json$/.test(name)) {
          const path = join(directory, name),
            s = await lstat(path);
          files.push({ path, time: s.mtimeMs, bytes: s.size });
        }
      files.sort((a, b) => b.time - a.time);
      let bytes = 0;
      for (let i = 0; i < files.length; i++) {
        bytes += files[i].bytes;
        if (i >= 32 || bytes > 128 * 1024 * 1024)
          await rm(files[i].path, { force: true });
      }
    });
  cacheTail = task;
  await task;
}
export async function buildInkSystem(input, { cacheDirectory } = {}) {
  if (
    !keys(input, ['version', 'apps', 'links']) ||
    input.version !== 1 ||
    !Array.isArray(input.apps) ||
    !input.apps.length ||
    input.apps.length > 16 ||
    Buffer.byteLength(JSON.stringify(input)) > packetLimit
  )
    fail('Provide a version 1 system with 1–16 bounded application units');
  const names = new Set(),
    apps = [],
    stats = { built: [], reused: [], cacheFailures: 0 },
    tool = await toolIdentity(),
    compiler = (await compilerInfo()).sha256;
  for (const app of input.apps) {
    if (
      !keys(app, ['name', 'manifest', 'files']) ||
      !symbol(app.name) ||
      names.has(app.name)
    )
      fail('System application names must be distinct');
    names.add(app.name);
    const key = digest({
        schema: 1,
        compiler,
        tool,
        manifest: app.manifest,
        files: app.files,
      }),
      cacheable = ['baseline', 'replay'].includes(
        app.manifest?.optimisation?.mode,
      );
    let bundle;
    if (cacheDirectory && cacheable)
      try {
        const path = join(cacheDirectory, key + '.json'),
          s = await lstat(path);
        if (s.isSymbolicLink() || s.size > 20 * 1024 * 1024)
          throw Error('Invalid cached unit');
        const candidate = JSON.parse(await readFile(path, 'utf8'));
        checkCacheInput(app, candidate);
        await describe(app.name, candidate);
        bundle = validateBundle(
          await buildInkApp(app.manifest, app.files, {
            cachedImplementation: implementation(candidate),
          }),
        );
        stats.reused.push(app.name);
      } catch (error) {
        if (error.code !== 'ENOENT') stats.cacheFailures++;
      }
    if (!bundle) {
      bundle = validateBundle(await buildInkApp(app.manifest, app.files));
      stats.built.push(app.name);
      if (cacheDirectory && cacheable)
        try {
          await saveCache(cacheDirectory, key, bundle);
        } catch {
          stats.cacheFailures++;
        }
    }
    apps.push({ name: app.name, manifest: app.manifest, bundle });
  }
  const graph = await graphFor(apps, input.links || []);
  const packet={format:'ink-system-release-v1',apps,graph,stats};if(Buffer.byteLength(JSON.stringify(packet))>packetLimit)fail('Compiled system release exceeds 64 MiB');return packet;
}
export async function verifyInkSystem(packet) {
  if (
    !keys(packet, ['format', 'apps', 'graph', 'stats']) ||
    packet.format !== 'ink-system-release-v1' ||
    !Array.isArray(packet.apps) ||
    !packet.apps.length ||
    packet.apps.length > 16 ||
    new Set(packet.apps.map((a) => a.name)).size !== packet.apps.length ||
    packet.apps.some((a) => !symbol(a.name)) ||
    Buffer.byteLength(JSON.stringify(packet)) > packetLimit
  )
    fail('Invalid bounded system release');
  const derived = await graphFor(
    packet.apps,
    packet.graph.links.map(
      ({ provider, entry, consumer, component, input, plan }) => ({
        provider,
        entry,
        consumer,
        component,
        input,
        ...(plan ? { plan } : {}),
      }),
    ),
  );
  if (canonical(derived) !== canonical(packet.graph))
    fail('System graph or summary differs from checked releases');
  return derived;
}
export async function installInkSystem(platform, packet, principal) {
  platform.owner(principal);
  const graph = await verifyInkSystem(packet);
  platform.systemDeployments ||= new Map();
  if (platform.systemDeployments.has(graph.identity))
    return platform.systemDeployments.get(graph.identity);
  const task = (async () => {
    const id = digest('ink-system-deployment:' + graph.identity).slice(0, 32),
      previous = platform.world.get(id);
    let record = previous
      ? JSON.parse(previous.body)
      : {
          identity: graph.identity,
          status: 'deploying',
          apps: {},
          atomic: false,
        };
    if (record.identity !== graph.identity || !record.apps)
      fail('Invalid system deployment receipt');
    const persist = () =>
      platform.world.put(
        {
          id,
          namespace: 'os',
          kind: 'ink-system-deployment',
          title: graph.identity.slice(0, 12),
          body: JSON.stringify(record),
        },
        {
          writer: 'os',
          actor: 'Deployment',
          action: 'recorded system rollout',
        },
      );
    for (const unit of packet.apps) {
      const existing = platform
        .apps()
        .find((app) => JSON.parse(app.body).slug === unit.manifest.slug);
      if (existing && record.apps[unit.name]?.appId !== existing.id)
        throw Object.assign(
          Error(
            'A system slug is already installed; choose a new system or explicitly migrate it',
          ),
          { status: 409 },
        );
    }
    if (!previous) await persist();
    for (const name of graph.order) {
      const unit = packet.apps.find((a) => a.name === name),
        current = record.apps[name];
      if (current?.releaseId) {
        if (
          JSON.parse(platform.app(current.appId).body).releaseId !==
          current.releaseId
        )
          throw Object.assign(
            Error('A deployed system release changed; reconcile it explicitly'),
            { status: 409 },
          );
        continue;
      }
      const bundle = structuredClone(unit.bundle);
      for (const link of graph.links.filter((l) => l.consumer === name)) {
        const provider = record.apps[link.provider];
        if (!provider?.releaseId)
          fail('System provider must deploy before its consumer');
        const component = bundle.ink.ui.components.find(
          (c) => c.name === link.component,
        );
        delete component.data;
        component.read = {
          appId: provider.appId,
          releaseId: provider.releaseId,
          entry: link.entry,
          input: link.input,
          ...(link.plan ? { plan: link.plan } : {}),
        };
      }
      const metadata = bundle.files.find((f) => f.path === 'app.json');
      if (metadata) {
        const m = JSON.parse(Buffer.from(metadata.base64, 'base64'));
        m.ink = bundle.ink;
        metadata.base64 = Buffer.from(JSON.stringify(m)).toString('base64');
      }
      await validateInkBundle(bundle);
      const app = current
        ? platform.app(current.appId)
        : await platform.createApp({
            slug: unit.manifest.slug,
            title: unit.manifest.title,
            capabilities: bundle.capabilities,
          });
      if (!current) {
        record.apps[name] = { appId: app.id };
        await persist();
      }
      const release = await platform.createRelease(app.id, bundle);
      await platform.publish(app.id, release.id);
      record.apps[name].releaseId = release.id;
      await persist();
    }
    if (record.status !== 'deployed') {
      record.status = 'deployed';
      await persist();
    }
    return {
      identity: graph.identity,
      apps: record.apps,
      atomic: false,
      status: record.status,
    };
  })();
  platform.systemDeployments.set(graph.identity, task);
  try {
    return await task;
  } finally {
    platform.systemDeployments.delete(graph.identity);
  }
}
