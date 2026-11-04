import { cpus } from 'node:os';
import assert from 'node:assert/strict';
import { buildDataPaths, DataPaths } from '../server/data-path-planning.mjs';
import {
  StorageFixture,
  fixtureNamespace,
  scopeStorageQuery,
} from '../server/data-path-workload.mjs';
import {
  describeRelational,
  queryRelational,
} from '../server/relational-query.mjs';
import { tableQuery } from '../sdk/src/relations.js';
const tableId = 'b'.repeat(32),
  source = 'module app;fn value()->u64{return 1;}';
const result = {
  version: 1,
  node: process.versions.node,
  icu: process.versions.icu,
  cpu: cpus()[0]?.model,
  scope:
    'Cold adapter setup, all query reads and derived-cache write maintenance; excludes fixture creation, durable journal sync, network and rendering.',
  runs: [],
};
const observe = ({ rows, total, nextCursor, version, schema }) => ({
  rows,
  total,
  nextCursor,
  version,
  schema,
});
for (const rows of [128, 512, 2048, 8192])
  for (const kind of ['read-heavy', 'write-heavy']) {
    const values = (i) => ({
      title: 'Row ' + i,
      score: i % 37,
      status: i % 2 ? 'open' : 'closed',
      payload: 'x'.repeat(256),
    });
    const workload = {
      version: 1,
      tables: [
        {
          id: tableId,
          columns: [
            { key: 'title', type: 'text' },
            { key: 'score', type: 'integer' },
            { key: 'status', type: 'text' },
            { key: 'payload', type: 'text' },
          ],
          rows: Array.from({ length: rows }, (_, i) => ({
            key: String(i),
            values: values(i),
          })),
        },
      ],
      history:
        kind === 'read-heavy'
          ? [
              ...Array.from({ length: 96 }, () => ({
                op: 'read',
                query: 'page',
              })),
              { op: 'put', tableId, key: '1', values: values(2) },
              { op: 'read', query: 'page' },
              { op: 'delete', tableId, key: '3' },
              { op: 'read', query: 'page' },
              { op: 'evict' },
              { op: 'read', query: 'page' },
            ]
          : [
              ...Array.from({ length: 192 }, (_, i) => ({
                op: 'put',
                tableId,
                key: String(i % rows),
                values: values(i + 1000),
              })),
              { op: 'read', query: 'page' },
            ],
    };
    const query = tableQuery('self', tableId, {
      where: { status: { contains: 'open' } },
      orderBy: { field: 'score', direction: 'desc' },
      select: ['title', 'score'],
      limit: 20,
      explain: true,
    });
    const packet = await buildDataPaths(
        source,
        { components: [{ name: 'page', query }] },
        {
          version: 1,
          mode: 'auto',
          workload: 'workload.json',
          milliseconds: 30000,
          candidates: 8,
          trials: 5,
        },
        [
          {
            path: 'workload.json',
            base64: Buffer.from(JSON.stringify(workload)).toString('base64'),
          },
        ],
      ),
      plan = packet.plans.page,
      world = new StorageFixture(workload),
      input = scopeStorageQuery(query, fixtureNamespace),
      runtime = new DataPaths(world, packet, fixtureNamespace);
    const cold = runtime.query('page', input),
      hot = runtime.query('page', input),
      baseline = queryRelational(world, input, {
        candidate: describeRelational(world, input).candidates[0],
      });
    assert.deepEqual(observe(hot), observe(baseline));
    // A held-out replacement changes predicate membership, keeping the measured row envelope.
    world.apply({
      op: 'put',
      tableId,
      key: '5',
      values: { ...values(5), status: 'closed', score: 999 },
    });
    const heldOut = runtime.query('page', input);
    assert.deepEqual(
      observe(heldOut),
      observe(
        queryRelational(world, input, {
          candidate: describeRelational(world, input).candidates[0],
        }),
      ),
    );
    const mean = (receipt, key) =>
      receipt.trials.reduce((sum, t) => sum + t[key], 0) /
      receipt.trials.length /
      1e6;
    result.runs.push({
      rows,
      kind,
      selected: plan.recipe.family,
      plan: plan.identity,
      reason: plan.selection.reason,
      strategies: plan.selection.receipts.map((receipt) => ({
        family: plan.contract.candidates.find((c) => c.id === receipt.candidate)
          .recipe.family,
        valid: receipt.valid,
        setupMS: mean(receipt, 'setupNS'),
        readMS: mean(receipt, 'readNS'),
        writeMS: mean(receipt, 'writeNS'),
        totalMS: mean(receipt, 'totalNS'),
        trials: receipt.trials,
      })),
      cold: cold.plan.stats,
      hot: hot.plan.stats,
      scan: baseline.plan.stats,
      heldOut: heldOut.plan.stats,
      responseBytes: Buffer.byteLength(JSON.stringify(observe(hot))),
      guards: plan.rows,
    });
  }
console.log(JSON.stringify(result, null, 2));
