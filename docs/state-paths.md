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

**Counts and sums over a view.** `count(view)` reads the view's length, and
`sum(view.map(fn(row) => ...))` keeps its total in the view when the mapped
function also reads only its row:

```ink
keep OpenTotal:u64 = sum(Rows.values().filter(fn(row) => row.open).map(fn(row) => row.amount));
```

- Applying dirty rows to the view first adjusts each total by the row's old
  and new admitted contribution, so a read costs the changed rows.
- Totals are exact and wrap on read as the scan's additions do (`u64`,
  `u32`, `i32`) or stay exact (`Int`). `f32` sums depend on the order of
  addition and keep the scan.
- A staged single cell scans. A contribution that throws drops its total;
  the next read recomputes it by scanning and meets the same error.

`tests/view_aggregates.rs` in the lowering compares every maintained count
and sum with the same aggregate over a scanning filter. On the 100,000-row
Tables state (10,000 open rows) a 20-row page read after a write, with its
`OpenTotal` and `OpenCount` keeps, went from 0.90 to 0.07 ms inside the
engine; the keeps had been 85% of it.

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
- **Native executables.** Rust state built by this compiler reports the
  same changes (`take_changes`): the roots whose rows differ and up to 64
  changed keys per root, compared from each commit's undo log. It keeps no
  filtered views, so its reports say `filters: null` and every view of a
  changed root counts as changed. The resident driver turns tracking on
  after a load; an executable built from older generated state refuses
  `track`, and its commits list every path of their IR write roots as
  before. `tests/native-ink.test.mjs` checks the paths a native commit
  reports.
- **Exact headers.** A hint carries the journal header its commit writes. It
  explains only a state change to exactly that header. A replicated or
  migration write that lands while the commit is in flight advances every
  path instead.
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
- **Replay without the compiler.** Resident and link workers decode plainly
  typed action arguments in JavaScript (`fastArguments` in
  `server/ink-input.mjs`) and instantiate the compiler only for an input that
  needs its `prepare`. Anything not in its plainest form (an `Int` spelled
  `"+5"`, an integer token `-0`, a lone surrogate, `F32Bits`, nesting past 64
  levels) still goes to the compiler, whose answer or error stands.
  `tests/ink-fast-arguments.test.mjs` compares both on hand-written edge cases
  and 400 seeded values. Replaying a 100,000-row copy's five-record journal
  tail went from 223 to 72 ms, and the copy no longer instantiates the 8 MB
  compiler at all.
- **Idle copies stay resident for 10 minutes** instead of 30 seconds. They
  still give way to new sessions when the pool is full and to the host
  budget's memory reclaimer.

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
  A link plan's limit can only bound the provider's query when the plan
  neither filters nor aggregates rows, and then a direct read already pages at
  the provider; plans that filter and aggregate scan their provider's rows,
  reusing each consumer function's result per row.
- The maintained counts and sums, and native change reports, take effect
  in the OS once the browser compiler is rebuilt with the lowerings it now
  pins.
- Native state has no filtered views, so a native commit to a table still
  re-runs every view reader of that table.
- The first load is dominated by restoring the base snapshot (about 210 ms
  at 100,000 rows, 4.3 MB). A host-level first planned read now takes
  480–514 ms (from 528).
- A copy still adds about 1 ms to each write on this 2-vCPU host.
- The first render of a planned read still loads the copy. In the desktop
  benchmark both windows still take 2.1–2.2 s to show their data, the same
  as before within this host's noise. A server-side trace of one run
  showed both windows' server work finishing within about 1 s of the first
  open: the dashboard's copy loaded in 464 ms while Tables' window loaded on
  the other core. The rest is the browser and the benchmark's 100–200 ms
  polling.
- Fields within a row are not tracked; `Rows[k]` names whole rows.

