# Checked storage recipes and bounded planning

Ink app builds can now select the physical data path for declared typed UI queries. Predicates, ordering, projection and paging remain in `ink-relational-v1` through the World Tables adapter. The release carries the complete query, schema and column dependencies, fixed physical recipe, workload and measurement receipts, applicability guards and a scan fallback. Deployment rederives the recipe from the original module closure and typed query. UI mounts execute that admitted recipe and share the existing retained query snapshots; requests do not run a profitability search or measurement worker.

This is an opt-in extension of the **trusted host storage interpreter**. Its checker only admits a finite set of implementations of the same operator tree. It does not provide an Ink kernel equality certificate for the JavaScript adapter. Hashes bind provenance; output comparisons validate experiments; neither grants authority to rewrite arbitrary Ink programs. The existing Ink implementation planner and its proof closure remain separate and required. In particular, `examples/tables-system` uses Ink state `Table`, not World Tables records: this change does not silently substitute one storage model for the other or change Ink integer semantics.

## Authoring

Add a bounded workload file and this manifest section alongside version 1 typed UI components with `query` sources:

```json
{
  "storagePlanning": {
    "version": 1,
    "mode": "auto",
    "workload": "storage-workload.json",
    "milliseconds": 8000,
    "candidates": 8,
    "trials": 3
  }
}
```

The CLI includes that file in local and system builds and source deployments. The checked private artifact is `server/data-paths.json`; public app metadata and system graphs contain only its summary. It is bound to the original complete module graph, not merely a generated target. Workload data is private release data: use synthetic fixtures or reviewed samples without secrets. Installed execution caches retain the plans and schemas, not the sample rows or history.

Use `mode: "baseline"` to select scanning explicitly without profiling. To replay an existing packet, use `{"version":1,"mode":"replay","plan":"data-paths.json"}`. Replay validates evidence and selection arithmetic without running measurements. A different source closure or logical query requires a new packet. An upgrade that changes the derivable recipe inventory also requires rebuilding; unchanged recipes can fall back on a backend/target guard. Normal, unplanned relational API requests retain their existing adapter behavior; this version consumes plans for declared UI component queries, not every SDK request or arbitrary Ink state query.

Workload format:

```json
{
  "version": 1,
  "tables": [{
    "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "columns": [{"key":"title","type":"text"}],
    "rows": [{"key":"first","values":{"title":"First"}}]
  }],
  "history": [
    {"op":"read","query":"page"},
    {"op":"put","tableId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","key":"first","values":{"title":"Changed"}},
    {"op":"delete","tableId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","key":"first"},
    {"op":"evict"},
    {"op":"read","query":"page"}
  ]
}
```

`query` names a component. All source namespaces are `self`; they bind to the installed app, including joins. Only relational source edges are rebound: JSON literals and their object-key order are preserved. Row IDs can be specified to exercise duplicate keys or record moves. Columns use the existing Tables schema contract.

## What is selected and checked

* **Scan:** enumerate rows in deterministic key/ID order, apply the complete predicate and projection, sort as declared, then page. No secondary index or maintained result is required.
* **Index:** a fixed, rederived equality prefix plus order/range/key access. Candidate generation is bounded and independent of timing. Complete residual predicates still execute; an index only supplies exact counts or ordered pages when the typed analysis establishes those conditions. No alternative index probes run in an admitted request.
* **Maintained result:** retain membership for the complete predicate and a rank tree in declared mixed-direction order with stable key/ID ties. Commits remove the old row and insert the new membership; page and count reads avoid full re-evaluation. Eligible count/sum/average groups use the existing exact numeric maintenance. General operators, including joins, still execute their complete logical tree; the planner does not invent join reorderings or drop operators.

Every candidate is compared against scan observations over the full history, including rows, count, page, cursor, snapshot version, output schema and errors. Code warms for all candidates; every timed trial starts with a **cold adapter**. Trial order rotates. Selection includes first read/cache construction, all query reads and derived-cache write maintenance. A choice needs a mean lifecycle cost at least 10% below scan and a win in at least two thirds of trials; otherwise scan wins. Replay rechecks the candidate inventory, receipt shape, arithmetic and winner. Measurements are producer-supplied workload evidence, not authenticated independent performance attestations or semantic proofs.

The isolated build worker has a 512 MiB host reservation and 384 MiB old-generation limit. The deadline covers queue admission, execution and cancellation; its lease remains until worker termination. Bounds: 1–16 queries, 1–8 tables, 10,000 initial rows, 256 history operations, 4 MiB workload, 8 MiB packet, 1–30,000 ms, 1–8 candidates and 3–7 trials. Failed, timed-out or non-comparable searches publish the explicit scan baseline. Existing storage read/row/byte/intermediate budgets still apply. Heap-growth receipts are samples affected by GC, not a complete peak-memory guarantee.

## Runtime and recovery

A sealed host handle binds the recipe to the exact typed query, schema, backend source digest, ICU/collation and Node/platform/CPU identity. Row bounds are rederived from the committed workload history. Query changes, schema changes, host/backend changes or rows outside that envelope select scan and report the reason in `plan.admission` when `explain` is requested. A failed derived cache is discarded and scanning is retried; malformed data, snapshot conflicts and resource-limit errors remain errors. No request widens guards, recollects evidence or launches planning. A known cache can be rebuilt after eviction; cold setup was part of the measured cost.

World durability and retry authority are unchanged. Caches see mutations after the journal append is durable. They can be discarded on failures, schema replacement, image restore or restart and rebuilt from authoritative records. Existing cursor rules still bind exact World versions: a commit requires a new snapshot; an unrelated commit also invalidates a cursor. UI invalidation uses table dependency tokens, shares snapshots across mounts and preserves release fences. This adds two bounded maintained result trees per loaded table, alongside four indexes and two aggregate views; all obey the existing decoded-table cache bounds.

The row envelope is a coarse profitability guard. It does not prove that changed value distributions, cache contention or concurrent application workloads will retain the measured advantage. Current planning evaluates each declared query independently under the host budget. Joint multi-query index selection, remote storage lowering, incremental joins, workload refresh and Ink-kernel proofs for new storage lowerings remain further work.

## Evidence

`node --test tests/data-path-planning.test.mjs` checks complete strategy observations through writes and eviction, joins/groups/distinct, cursor pages, forged contracts/receipts/guards, timeout baseline, stale host/schema/row fallback, JSON literals, pre-sync invisibility, malformed-data repair, restart and installed Ink UI release execution with shared snapshots. Existing relational tests supply independent legacy-reader and adversarial numeric/range comparisons.

Run `node scripts/benchmark-data-paths.mjs` to reproduce [the recorded local workload](benchmarks/data-paths-2026-11-04.json). It compares 128, 512, 2,048 and 8,192 rows, five rotated trials, read-heavy and write-heavy histories, full cold setup and held-out predicate membership changes. The selected read-heavy paths used maintenance at every size. At 8,192 rows, mean lifecycle cost was approximately 57 ms maintained versus 1,179 ms scan; warm pages visited 21 versus 8,192 rows. These are local synthetic measurements, not end-to-end latency claims. Source-fixture construction, durable journal sync, network and UI rendering are excluded because this experiment isolates the physical data-path decision. Projection and response payload stay equal across strategies; this optimization reduces storage work, not the logical response size.

[Runnable Ink UI example](../examples/planned-storage/README.md) · [Underlying typed storage semantics](typed-storage-queries.md)

The [browser verification](benchmarks/data-path-ui-2026-11-04.json) renders two panes from the installed example through actual JavaScript and native Ink computation. Each target rendered forty list items, shared one initial query evaluation, then shared one further evaluation after a durable held-out edit; the warm physical path visited twenty-one rows without decoding or scanning. Run `INK_UI_BROWSER_EXECUTABLE=/path/to/chrome node scripts/verify-data-path-ui.mjs` and again with `--native`. This verifies the host/DOM adapter, not a packaged desktop or physical paint.
