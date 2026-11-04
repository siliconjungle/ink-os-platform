// Host-level costs of cross-app reads with and without link plans, on large tables.
//
//   node scripts/benchmark-ink-links.mjs [--rows 100000] [--reads 9] [--output FILE]
//
// One fresh process: the Tables/dashboard system (baseline JavaScript) with
// `seed` and `note` changes added to Tables and a planned dashboard link
// (pure filter `amount >= 5`, page of 20, sum of amounts). It measures, as
// medians over --reads repetitions after a Tables write each time:
//   - direct: the existing read path (provider worker evaluates its exported
//     query; the provider's own 20-row page crosses);
//   - plan: the link worker follows the write by replay and evaluates the plan
//     on its copy (the whole open set is scanned; 20 rows cross);
//   - the bytes the plan's consumer would have needed without pushdown;
//   - precise invalidation: a write to an unrelated root, then a read;
//   - write latency with and without a live link copy following it.
// No browser, HTTP or UI composition is included; see benchmark-ink-system.mjs.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus, platform as os, arch } from 'node:os';
import { systemFixture, owner, extendTables, planned } from '../tests/ink-system-fixture.mjs';

const args = process.argv.slice(2),
  option = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  },
  rows = Number(option('--rows', '100000')),
  reads = Number(option('--reads', '9'));
if (!Number.isInteger(rows) || rows < 100 || rows > 200000 || !Number.isInteger(reads) || reads < 3 || reads > 50)
  throw Error('Use 100–200000 rows and 3–50 reads');
const SEED = `
state Notes:u64=0;
change seed(keys:List<u64>,rows:List<Row>)->Result<Unit,String> reads(Rows,Version) writes(Rows,Version){Version=Version+1;return Rows.put_many(keys,rows);}
change note(x:u64)->Result<Unit,String> reads(Notes) writes(Notes){Notes=x;return Ok(());}
`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = async (fn) => {
  const start = performance.now(),
    value = await fn();
  return [performance.now() - start, value];
};
const cleanups = [];
const f = await systemFixture(
  { after: (fn) => cleanups.push(fn) },
  {
    baseline: true,
    edit: (input) => {
      extendTables(input, SEED, ['seed', 'note']);
      planned({ version: 1, where: 'big', limit: 20, aggregate: { op: 'sum', value: 'amount' } }, { twin: false, input: JSON.stringify([0, rows]) })(input);
    },
  },
);
const { p, deployed } = f,
  links = p.inkViews.reads.links;

// Seed in bulk commits; one row in ten is open with an amount of at least 5.
let version = 0;
const seedStart = performance.now();
for (let start = 1; start <= rows; start += 2000) {
  const keys = [],
    values = [];
  for (let id = start; id < Math.min(start + 2000, rows + 1); id++) {
    keys.push(id);
    values.push({ id, title: 'Item ' + id, amount: id % 7, open: id % 10 === 0 });
  }
  const out = await f.call('seed', [keys, values]);
  if (out.valueWire !== '{"Ok":null}') throw Error('seed failed: ' + out.valueWire);
  version++;
}
const seedMs = performance.now() - seedStart;
const put = async (id, amount) => {
  const [ms, out] = await time(() => f.call('put', [version, { id, title: 'Edit ' + id, amount, open: true }]));
  if (!JSON.parse(out.valueWire).Ok) throw Error('put failed: ' + out.valueWire);
  version++;
  return ms;
};

// Read paths, resolved from each app's checked program as the UI service does.
const consumerOf = (name) => {
  const appId = deployed.apps[name].appId;
  return { appId, releaseId: JSON.parse(p.app(appId).body).releaseId };
};
const tables = consumerOf('tables'),
  direct = (await p.inkViews.program(tables, owner)).components.get('results'),
  directBinding = { ...direct.read, ...tables },
  directRead = () => p.inkViews.reads.read(directBinding, direct.data, undefined, tables);
const dashboard = consumerOf('dashboard'),
  port = (await p.inkViews.program(dashboard, owner)).components.get('results'),
  planRead = () => p.inkViews.reads.read(port.read, port.data, undefined, dashboard);
// The first planned read loads the provider copy from its journal.
const [firstPlanMs, first] = await time(planRead);
// Wait until the copy has applied every commit and refreshed its results.
const settle = async () => {
  for (const link of links.links.values()) await link.chain;
  for (const entry of links.results.values()) await entry.pending?.catch(() => {});
};
const fullWire = (await f.call('dashboard', [0, rows])).valueWire;

const samples = { directMs: [], planMs: [], writeWithCopyMs: [] };
for (let i = 0; i < reads; i++) {
  samples.writeWithCopyMs.push(await put(5 + i, 50 + i));
  samples.directMs.push((await time(directRead))[0]);
  // A read right after the write: it waits for the copy to replay the commit.
  samples.planMs.push((await time(planRead))[0]);
  await settle();
}
const plan = await planRead();

// Precise invalidation: a write to Notes leaves both reads current.
const before = { direct: p.inkViews.reads.reads, plan: links.stats().evaluations };
await f.call('note', [1]);
const [unrelatedDirectMs] = await time(directRead),
  [unrelatedPlanMs] = await time(planRead);
const after = { direct: p.inkViews.reads.reads, plan: links.stats().evaluations };

// Writes when no copy follows them (the link worker is dropped).
for (const link of links.links.values()) if (link.session) await p.code.residents.drop(link.session);
links.links.clear();
links.results.clear();
const writeAloneMs = [];
for (let i = 0; i < reads; i++) writeAloneMs.push(await put(100 + i, 1));

const report = {
  schema: 1,
  recordedAt: new Date().toISOString(),
  host: { platform: os(), arch: arch(), node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length },
  scope:
    'One fresh process; baseline JavaScript Tables/dashboard system; host-level read paths only (no browser, HTTP or view composition). Medians of --reads samples, each after one Tables write. Exploratory single-host measurement.',
  workload: { rows, openRows: Math.floor(rows / 10), reads, seedMs: Math.round(seedMs) },
  direct: { readMs: median(samples.directMs), rowsCrossing: 20, note: 'provider-defined page; the consumer cannot filter' },
  plan: {
    firstReadMs: Math.round(firstPlanMs),
    readAfterWriteMs: median(samples.planMs),
    scanned: plan.scanned,
    matched: plan.matched,
    bytesCrossing: Buffer.byteLength(plan.wire),
    bytesWithoutPushdown: Buffer.byteLength(fullWire),
    total: String(plan.value.total.Some),
    firstMatches: first.matched,
  },
  unrelatedWrite: {
    directReadMs: unrelatedDirectMs,
    planReadMs: unrelatedPlanMs,
    directEvaluations: after.direct - before.direct,
    planEvaluations: after.plan - before.plan,
  },
  writes: { withFollowingCopyMs: median(samples.writeWithCopyMs), withoutCopyMs: median(writeAloneMs) },
  links: links.stats(),
};
const path = option('--output');
if (path) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
for (const fn of cleanups.reverse()) await fn();
process.exit(0);
