import { Collaboration } from '../server/collaboration.mjs';
import { fixture, owner } from './ink-effects-fixture.mjs';
import { loadInkSystem } from '../cli/bin/ink-system.mjs';
import { buildInkSystem, installInkSystem } from '../server/ink-system.mjs';
import { InkViews } from '../server/ink-ui.mjs';
import { runInstalledInk, inkExecutionSource } from '../server/ink-apps.mjs';
import { NativeInk } from '../server/native-ink.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export { owner };
export const example = fileURLToPath(
  new URL('../examples/tables-system/', import.meta.url),
);
export async function systemFixture(
  t,
  { native = false, baseline = false, collaborative = false, edit } = {},
) {
  const f = await fixture(t),
    p = f.platform,
    input = await loadInkSystem(example);
  if (collaborative) {
    p.collaboration = new Collaboration({
      directory: f.directory,
      world: p.world,
    });
    await p.collaboration.index();
  }
  if (baseline) {
    input.apps[0].manifest.optimisation = { version: 1, mode: 'baseline' };
    input.apps[0].files = input.apps[0].files.filter(
      (f) => f.path !== 'selected.plan.json',
    );
  }
  edit?.(input);
  const start = performance.now(),
    packet = await buildInkSystem(input),
    buildMs = performance.now() - start,
    deployStart = performance.now(),
    deployed = await installInkSystem(p, packet, owner),
    deployMs = performance.now() - deployStart;
  p.inkViews = await new InkViews({ platform: p }).open();
  t.after(() => p.inkViews.close());
  const artifacts = new Map(),
    nativeStart = performance.now();
  if (native) {
    const driver = new NativeInk(join(f.directory, 'native'), {
      offline: process.env.INK_NATIVE_OFFLINE === '1',
    });
    for (const [name, { appId, releaseId }] of Object.entries(deployed.apps)) {
      const bundle = await p.bundle(releaseId),
        source = await inkExecutionSource(bundle.ink, bundle.files),
        artifact = await driver.build(source, { namespace: appId });
      artifacts.set(appId, artifact.id);
    }
    p.code.nativeJobs = {
      native: driver,
      readyFor: async (appId) => artifacts.get(appId),
    };
  }
  return {
    ...f,
    p,
    input,
    packet,
    deployed,
    artifacts,
    buildMs,
    deployMs,
    nativeBuildMs: native ? performance.now() - nativeStart : 0,
    call: (entry, args = [], { appId, ...options } = {}) =>
      runInstalledInk(
        p,
        appId || deployed.apps.tables.appId,
        {
          entry,
          input: typeof args === 'string' ? args : JSON.stringify(args),
          ...options,
        },
        owner,
      ),
  };
}
export async function logicalHistory(f) {
  const outputs = [],
    row = (id, amount, open = true) => ({
      id,
      title: 'Item ' + id,
      amount,
      open,
    });
  for (let i = 0; i < 8; i++)
    outputs.push(
      await f.call('put', [i, row(i + 1, i + 1, i % 3 !== 0)], {
        requestId: 'put-' + i,
      }),
    );
  const once = await f.call('put', [8, row(9, 9)], { requestId: 'lost-reply' });
  outputs.push(
    once,
    await f.call('put', [8, row(9, 9)], { requestId: 'lost-reply' }),
  );
  outputs.push(
    await f.call('put', [8, row(99, 99)]),
    await f.call('abort_edit', [row(100, 100)]),
    await f.call('dashboard', [0, 3]),
    await f.call('dashboard', [3, 3]),
  );
  outputs.push(await f.call('remove', [9, 2]));
  outputs.push(
    ...(await Promise.all(
      [1, 2, 3, 4].map((i) =>
        f.call('put', [10, row(200 + i, i)], { requestId: 'concurrent-' + i }),
      ),
    )),
  );
  outputs.push(await f.call('dashboard', [0, 20]));
  return outputs.map((output) => ({
    valueWire: output.valueWire,
    committed: output.output?.committed,
    events: output.wire && JSON.parse(output.wire).events,
  }));
}

// Tables gains a root its exported dashboard query never reads, a change that
// reads Rows but writes only that root, and a change that rewrites a row.
const EXTRA = `
state Notes:u64=0;
change note(x:u64)->Result<Unit,String> reads(Rows,Notes) writes(Notes){Notes=x+sum(Rows.values().map(fn(row)=>row.amount));return Ok(());}
change touch(row:Row)->Result<Unit,String> reads(Rows) writes(Rows){Rows.put(row.id,row);return Ok(());}
`;
export function extendTables(input, source = EXTRA, exports = ['note', 'touch']) {
  const app = input.apps.find((a) => a.name === 'tables'),
    main = app.files.find((f) => f.path === 'main.ink');
  main.base64 = Buffer.from(
    Buffer.from(main.base64, 'base64').toString() + source,
  ).toString('base64');
  app.manifest.exports.push(...exports);
  app.manifest.modules.modules
    .find((m) => m.path === 'main.ink')
    .exports.push(...exports);
  app.files.find((f) => f.path === 'ink-app.json').base64 = Buffer.from(
    JSON.stringify(app.manifest),
  ).toString('base64');
}


// The dashboard gains pure plan functions; a second, identical dashboard
// shares results with it.
const PLAN_CODE = `
fn big(row:Item)->Bool{return row.amount>=5;}
fn amount(row:Item)->u64{return row.amount;}
fn wrong(n:u64)->Bool{return n>3;}
`;
function source(app, path, extra) {
  const file = app.files.find((f) => f.path === path);
  file.base64 = Buffer.from(Buffer.from(file.base64, 'base64').toString() + extra).toString('base64');
}
function manifest(app) {
  app.files.find((f) => f.path === 'ink-app.json').base64 = Buffer.from(JSON.stringify(app.manifest)).toString('base64');
}
export function planned(plan, { twin = true, input: query = '[0,1000]' } = {}) {
  return (input) => {
    const dashboard = input.apps.find((a) => a.name === 'dashboard');
    source(dashboard, 'main.ink', PLAN_CODE);
    dashboard.manifest.modules.modules.find((m) => m.path === 'main.ink').exports.push('big', 'amount', 'wrong');
    manifest(dashboard);
    input.links[0].input = query;
    input.links[0].plan = plan;
    if (twin) {
      const copy = structuredClone(dashboard);
      copy.name = 'dashboard2';
      copy.manifest.slug = 'system-dashboard-two';
      manifest(copy);
      input.apps.push(copy);
      input.links.push({ ...input.links[0], consumer: 'dashboard2' });
    }
  };
}
