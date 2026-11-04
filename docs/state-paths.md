# State paths, filtered views and cheaper copies

At 100,000 rows the remaining cost of a cross-app read was the provider query
itself: every read scanned every row, and every commit to a table woke every
reader of that table. This change adds three things to the JavaScript
lowering and uses them in the OS:

- maintained **filtered views** over state tables;
- per-declaration **dependency paths** and per-commit **change reports**;
- faster **snapshots** and record results.

## Filtered views (JavaScript lowering)

A filter over a table's rows whose predicate reads only its row reads a
maintained view instead of scanning:

```ink
let rows = Rows.values().filter(fn(row) => row.open);
```

- The predicate must be closed: no captured local, state root or keep, and no
  call into a query or change. Pure function calls and constants are fine.
  Identical predicates over one table share one view.
- Writes only mark the written key dirty. The next read tests just the dirty
  rows, merges them into the view in table order and copies the admitted
  rows out. Rollbacks, host transactions and restores mark or replace views
  the same way.
- A staged single-cell write and preflight bodies keep the scan. A test that
  throws leaves its keys dirty, so the same error recurs on the next read.
- Cached reads skip the predicate ticks of clean rows, as cached keeps
  already do. Fuel bounds work; it is not a semantic result.

Results are identical to the scan (tested against a scan through random puts,
removes, failed actions, host transactions and restores).

## State paths

The lowering's state metadata now lists each view (`filters`) and, for every
action and keep, the state paths it depends on (`deps`):

| Path | Means |
| --- | --- |
| `Rows` | any row of the root |
| `Rows#0` | the rows filtered view 0 admits, before or after a change |
| `Rows[0]` | the row keyed by the declaration's parameter 0 (`Rows.get(id)`) |
| `Rows[*]` | some row whose key was not listed |

Keeps resolve to their own paths; a call into another query widens its keyed
paths to the root. Anything the analysis cannot name exactly depends on the
whole root.

`state.trackChanges()` and `state.takeChanges()` report what each commit
changed: the roots whose rows actually differ (an identical rewrite changes
nothing), the views a changed row passes before or after (a failing test
counts as a change), and up to 64 changed keys per root. Restores report
everything.

## How the OS uses them

- **Commit hints** (`server/code.mjs`). The resident worker turns each
  commit's report into paths (`shared/ink-state-paths.mjs`). Without a report
  (an older compiler, a native artifact, a replayed receipt) a commit lists
  every path of its IR write roots, so readers stay correct.
- **Reader paths** (`readPaths` in `server/ink-footprints.mjs`). A cross-app
  read resolves its query's `deps` against its binding input: `Rows[0]` with
  input `[42]` becomes `Rows[42]` plus `Rows[*]`. Keys are named only for
  `u32`, `i32`, `u64` and `String` keys given as exact JSON integers or
  strings; anything else depends on the root.
- **Root versions** keep one version per path. Past 4,096 paths for one app
  they are all forgotten and advanced once.

So the dashboard (`Rows#0`, `Version`) stays current when a commit edits a
closed row, and a detail read of row 3 stays current when row 5 changes.
`tests/ink-links.test.mjs` checks both through the real cross-app read path.

## Row-level link upkeep

The link worker no longer converts every exported row to exact JSON and back
for each consumer call:

- Admission records which parameter fields each plan function reads
  (`paramFields` in `server/ink-link-plans.mjs`, from the consumer's checked
  core). A function that passes its whole row on, returns it or rebinds it
  reads everything.
- The worker keys each row by those fields and reuses the function's earlier
  result for rows that agree. Plan functions are proved pure at admission, so
  this is exact.
- Only the selected page is converted to exact JSON.

Aggregates are still summed over the matching rows, from reused results.

## Cheaper copies

- **Batched replay.** Commits that arrive while a link copy is busy are
  replayed in one request.
- **No header re-read.** The commit notification carries the journal header
  the commit wrote, so the copy records its position without reading storage.
- **Snapshots.** Checkpoints wrote one small array per byte into a JavaScript
  list; restores built a BigInt chain and a fresh UTF-8 decoder per value. The
  writer now fills a growable buffer and the reader decodes words directly.
  The bytes are unchanged (a differential test compares both writers).
- **Record results** are built with a loop instead of `Object.fromEntries`
  over entry arrays.
- **F32 captures** below 1,024 elements stay packed arrays: on Node 22 a
  `Float32Array` map costs about twice as much at 100 elements.

## Measurements

Both benchmarks ran on the same 2-vCPU sandbox (Node 22, headless Chromium 153)
with the rebuilt browser compiler (`bae346cd…`).

**Host-level link paths** (`scripts/benchmark-ink-links.mjs --rows 100000`,
[recorded run](benchmarks/ink-links-2026-11-05.json), against
[the earlier run](benchmarks/ink-links-2026-11-04.json)). The workload has
100,000 rows, 10,000 of them open; figures are medians after one write each.

| | Before | After |
| --- | ---: | ---: |
| Direct read after a write (provider worker) | 56.6 ms | 7.0 ms |
| Planned read after a write (link copy) | 43.6 ms | 5.9 ms |
| Consumer function calls over ten evaluations | ~130,000 | 27 |
| First planned read (loads the copy) | 722 ms | 528 ms |
| Writes with a copy following | 6.8 ms | 5.2 ms |
| Writes without a copy | 5.1 ms | 4.2 ms |

**End to end in the real desktop** (`scripts/benchmark-ink-scale-browser.mjs
--rows 100000 --edits 9`, [after](benchmarks/ink-scale-browser-2026-11-05.json),
[before, main 95593b1](benchmarks/ink-scale-browser-main-2026-11-05.json)).
A production host and the built desktop show Tables and the dashboard as
windows with live delivery. Each figure is the median time from just before
an edit's commit request until its new title appears in the window:

| | Before | After |
| --- | ---: | ---: |
| Tables (own read), dashboard reads directly | 75 ms | 38 ms |
| Dashboard, direct cross-app read | 66 ms | 31 ms |
| Tables (own read), dashboard has a plan | 77 ms | 36 ms |
| Dashboard, planned cross-app read | 161 ms | 46 ms |
| Both windows' first render, planned | 1,992 ms | 2,057 ms |

Inside one engine, without workers:
- a page of the open view reads in 0.64 ms, against 12.4 ms for the same
  filter as a scan;
- a query returning 10,000 records went from 10.6 to 3.8 ms;
- a 100,000-row checkpoint went from 617 to 156 ms, and its restore from 326
  to 207 ms.

What remains:

- A query that returns every matching row still builds every row it returns.
- The first load is dominated by restoring the base snapshot and replaying
  the journal tail, each record still through the compiler's `prepare`.
- A copy still adds about 1 ms to each write on this 2-vCPU host.
- The first render of a planned read still loads the copy (about 2 s here at
  100,000 rows).
- Fields within a row are not tracked; `Rows[k]` names whole rows.
