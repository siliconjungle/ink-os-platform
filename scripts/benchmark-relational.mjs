import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { World, hash } from '../server/world.mjs';
import { platformRouter } from '../server/platform-router.mjs';
import { createClient } from '../sdk/src/server.js';
import {
  createTableReader,
  decodeTable,
  selectTable,
} from '../sdk/src/tables.js';
import { tableQuery } from '../sdk/src/relations.js';

const directory = await mkdtemp(join(tmpdir(), 'ink-query-benchmark-')),
  world = await new World(directory).open();
const namespace = 'a'.repeat(32),
  tableId = 'b'.repeat(32),
  tag = 'ink-table:' + tableId,
  iterations = 20;
const samples = [],
  rows = 400,
  columns = [
    { key: 'title', type: 'text' },
    { key: 'score', type: 'integer' },
    { key: 'status', type: 'text' },
    { key: 'payload', type: 'json' },
  ];
const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const route = platformRouter(
  { world },
  {
    send,
    body: async (req) => {
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      return JSON.parse(Buffer.concat(chunks).toString());
    },
  },
);
const server = createServer(async (req, res) => {
  try {
    if (
      req.url !== '/api/v1/query' ||
      req.method !== 'POST' ||
      req.headers.authorization !== 'Bearer benchmark-local'
    )
      return send(res, 403, { error: 'Read-only local benchmark' });
    await route(req, res, new URL(req.url, 'http://fixture'), {
      owner: true,
      keyId: 'benchmark',
      scopes: ['world:read'],
    });
  } catch (error) {
    send(res, error.status || 500, { error: error.message });
  }
});
try {
  const setup = performance.now();
  await world.create({
    id: tableId,
    namespace,
    kind: 'ink-table',
    title: 'Benchmark',
    tags: [tag],
    body: JSON.stringify({ format: 'ink-table', version: 1, columns }),
  });
  for (let index = 0; index < rows; index++)
    await world.create({
      id: hash('benchmark-row:' + index).slice(0, 32),
      namespace,
      kind: 'ink-table-row',
      tags: [tag],
      body: JSON.stringify({
        format: 'ink-table-row',
        version: 1,
        tableId,
        key: String(index).padStart(6, '0'),
        values: {
          title: 'Item ' + index,
          score: index % 100,
          status: index % 2 ? 'open' : 'closed',
          payload: { body: 'x'.repeat(1024) },
        },
      }),
    });
  const setupMs = performance.now() - setup;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let bytes = 0;
  const client = createClient({
      url: 'http://127.0.0.1:' + server.address().port,
      token: 'benchmark-local',
      fetch: async (...args) => {
        const response = await fetch(...args);
        const text = await response.text();
        bytes += Buffer.byteLength(text);
        return {
          ok: response.ok,
          status: response.status,
          json: async () => JSON.parse(text),
        };
      },
    }),
    reader = createTableReader(client, { namespace, tableId });
  const query = {
    where: { status: 'open' },
    orderBy: { field: 'score', direction: 'desc' },
    limit: 20,
  };
  const baseline = async () =>
      selectTable(
        decodeTable(
          await client.data.query({ namespace, tag, limit: 1000 }),
          tableId,
        ),
        query,
      ),
    optimized = async () => reader.query(query);
  let at = performance.now();
  const cold = await optimized(),
    coldMs = performance.now() - at;
  assert.deepEqual(cold.rows, (await baseline()).rows);
  for (let index = 0; index < iterations; index++) {
    for (const [name, read] of index % 2
      ? [
          ['typed', optimized],
          ['legacy', baseline],
        ]
      : [
          ['legacy', baseline],
          ['typed', optimized],
        ]) {
      bytes = 0;
      at = performance.now();
      const result = await read();
      const ms = performance.now() - at;
      assert.equal(result.total, 200);
      assert.deepEqual(result.rows, cold.rows);
      samples.push({ name, ms, bytes });
    }
  }
  const summaries = Object.fromEntries(
    ['legacy', 'typed'].map((name) => {
      const selected = samples.filter((value) => value.name === name),
        times = selected.map((value) => value.ms).sort((a, b) => a - b);
      return [
        name,
        {
          medianMs: times[Math.floor(times.length / 2)],
          responseBytes: selected[0].bytes,
        },
      ];
    }),
  );
  const planned = await client.data.query(
    tableQuery(namespace, tableId, {
      ...query,
      select: ['title', 'score'],
      explain: true,
    }),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        backend: planned.plan.backend,
        backendHash: planned.plan.backendHash,
        queryHash: planned.plan.queryHash,
        cpu: cpus()[0]?.model,
        rows,
        iterations,
        setupMs,
        coldMs,
        summaries,
        projectedPageBytes: planned.plan.stats.wireBytes,
        hotWork: planned.plan.stats,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
