# Cross-app plans, precise invalidation and Ink tasks

Apps stay separately compiled, separately upgraded and separately permitted.
What crosses an app boundary is either a value or code the compiler proves
pure, so no optimisation here lets authority cross a link it did not already
cross.

## IR footprints

The bundled compiler's `footprints` request lowers a checked source or module
graph to Ink's mid-level IR (`ink-footprints-v1`). For every declaration it
reports:

- the physical state roots read and written, with keeps resolved to the
  roots they are defined over;
- whether a function is pure: no read, write, emit, action or effect node
  in any region, and only pure callees.

Write roots come from IR nodes, so a change that declares `writes(B,C)` but
only ever assigns `B` writes `B`. Declarations the IR does not express keep
their checked declarations and are never pure. `server/ink-footprints.mjs`
caches results per program. With an older compiler, callers fall back to the
manifest's touched roots, which over-approximate.

## Precise invalidation

- **Commit hints.** Each commit's hint lists the [state paths](state-paths.md)
  it changed, as the runtime reports them: roots, filtered views and keyed
  rows. Without a report (an older compiler, a native artifact, a replayed
  receipt) it lists every path of the change's IR write roots.
- **Root versions.** `RootVersions` keeps per-root versions of each tracked
  provider. A hinted commit advances only its roots. Any unexplained state
  change advances every root: a restore, a migration, a replicated commit,
  or a missed event.
- **Currency.** A cross-app snapshot, retained or not, is current until a
  commit changes a state path its exported query reads. Its `stateRevision` then
  names the commit it was computed at; the value is unchanged since.
- **Identical results.** A recomputed result with identical exact bytes keeps
  its snapshot identity. Consumers do not recompute their views, and
  retained queries deliver no new sequence.
- **Desktop frames.** After a provider commit, the UI service announces
  `{type: 'ink-reads', provider, apps}`, listing the apps whose mounted reads
  became stale. Desktop frames refresh for another app's commit only when
  they are listed. Before, every frame holding `apps.invoke` refreshed on
  every commit of every app. Own-app commits still notify the app's own
  frames.

Granularity is the [state path](state-paths.md): a whole root, the rows a
filtered view admits, or the row a query parameter names. Fields within a row
are not tracked.

## Link plans

A system link, and the deployed read binding, may carry a plan:

```json
{"provider": "tables", "entry": "dashboard", "consumer": "dashboard", "component": "results",
 "input": "[0,100000]",
 "plan": {"version": 1, "where": "big", "limit": 20, "aggregate": {"op": "sum", "value": "amount"}}}
```

`where` (`Row -> Bool`) and `value` (`Row -> u64`) are consumer functions
exported by the consumer's root module. The meaning is fixed in
`shared/ink-link-plan.mjs`:

1. `data = provider.entry(input)`.
2. `kept = data.rows.filter(where)`.
3. `total` is `Some` of the count, sum, min or max over `kept`. Min and max of
   no rows are `None`. With `where` and no aggregate, it is the count. With
   neither, it is the provider's total.
4. `rows = kept.drop(offset).take(limit)`.
5. The result is `UiData {rows, total, version: data.version}`.

A plan without other fields still moves the read onto a copy.

### The footprint rule

Admission (`server/ink-link-plans.mjs`) derives the plan's footprint from the
IR facts of both exact releases. A plan may change how a declared link runs.
It may never add a link or let more authority cross one. It is admitted only
when:

- **Provider entry.** It is an exported readonly query, with no writes, emits
  or effects. The plan reads only the roots that query reads.
- **Consumer code.** Each function is IR-pure and takes the exact exported row
  type.
- **Capabilities.** The only ones used are those the link already needs: the
  consumer's `apps.invoke` and `code.execute`, and the provider's
  `code.execute`.
- **Declaration.** The consumer release declares the binding with exactly
  this plan.

System builds record each planned edge's `footprint` and `code` in the system
graph. Every read re-checks both releases and capabilities.

### Execution

Plans run in a **link worker** (`server/ink-link-worker.mjs`) that holds a
read-only copy of the provider release's state.

- **Loading.** The copy is restored from the provider's journal.
- **Following.** It replays committed records, the same deterministic replay
  recovery uses. Commits that arrive while the copy is busy are replayed
  together, and the commit's own journal header says where the copy stands.
  When a read arrives before a commit's announcement, the copy catches up
  from the journal tail instead. It follows compactions onto a new base, and
  any mismatch reloads it.
- **No provider authority.** The worker has no World, storage, host-binding
  or effect access. Consumer modules are loaded only to call the admitted
  pure functions.
- **Pushdown.** Only the selected page crosses to the consumer.
- **Isolation from the provider.** Reads never enter the provider's worker or
  wait for its state lock.
- **Sharing.** One result per binding and plan code serves every consumer
  whose plan code is identical. The code identity is its call closure and
  types.
- **Rows stay native.** Exported rows are not converted wholesale: consumer
  functions see only the fields they read, and only the selected page is
  converted to exact JSON.
- **Row-level reuse.** A consumer function's result is reused for every row
  that agrees on the parameter fields it reads (`paramFields`, from the
  consumer's checked core). Purity, proved at admission, makes this exact.
- **Freshness.** Recently used results are recomputed after a commit that
  changes a path the provider query reads, so they are current before the
  next read.
- **Delivery.** Plan snapshots carry the same fields as retained queries:
  `id`, `sequence`, `stateRevision`, `versionWire`, `delta`.
- **Budget.** Worker memory is leased from the shared resident pool. It is
  charged to the consumer whose read started it, and the pool may reclaim it
  under memory pressure. Each evaluation's CPU is charged to the consumer it
  runs for.
- **Lifetime.** Results live in a bounded cache (64 results, 32 MiB), never in
  either app's state. They are dropped when their consumers or provider are
  deleted.

Aggregates are still summed over the matching rows on each relevant commit,
from reused per-row results. The provider query reads maintained filtered
views where its filters are closed ([state paths](state-paths.md)); it still
builds every row it returns. Running two apps in one process and fusing
writes across apps are deliberately not done.

## Ink tasks

An app's `tasks` contract (`shared/ink-tasks.mjs`) lists callable tasks and
binds every Ink `effect` its program declares to one driver:

| Kind | Resource | Effect type | Capability |
| --- | --- | --- | --- |
| `model` | operator model resource | any signature; replies checked by the step's accept query | `effects.model` |
| `http` | operator HTTP resource | `HttpEffectRequest -> Result<HttpEffectResponse, EffectError>` | `effects.http` |
| `app` | exact app release and exported entry | the entry's own parameters and result | `apps.invoke` |
| `clock` | `wall-clock` | `ClockEffectRequest -> Result<ClockEffectResponse, EffectError>` | `effects.clock` |
| `random` | `system` | `RandomEffectRequest -> Result<RandomEffectResponse, EffectError>` | `effects.random` |

Release admission checks four things:

- every effect is bound;
- bindings that write are `ordered effect`s;
- record-typed drivers match the effect library's types;
- the capabilities are declared.

Model resources are an operator policy kind:

```json
"assistant": {"kind": "model", "namespaces": ["*"], "origin": "https://api.anthropic.com",
              "model": "claude-sonnet-5-5", "maxTokens": 1024, "apiKeyFromEnv": "ANTHROPIC_API_KEY"}
```

Run a task with `POST /api/v1/apps/APP/ink/tasks/NAME {input, requestId}` or
`client.apps.ink.task(appId, name, input)`. `server/ink-tasks.mjs` runs it
with the runtime's vendored scheduler:

- **Concurrency.** Independent effects overlap, but the result is that of
  sequential execution.
- **State calls.** Only the running task's generated queries and named steps
  are callable. Changes carry stable request identities.
- **Model and app replies.** These must pass the generated accept query, or
  the step takes its authored fallback.
- **HTTP, clock and random.** Driver failures are typed `EffectError`
  values.
- **Traces.** Each run's trace is stored in World as `ink-task-run`, bound
  to its release. It replays offline without effects: `ink replay-task
  SOURCE TRACE --restore SNAPSHOT`.

Queries and changes a task calls must be root-module exports. A task runs
within its contract's deadline (at most 30 s). It does not survive a restart.

## Measurements

`node scripts/benchmark-ink-links.mjs --rows 100000 --reads 9`
([recorded run](benchmarks/ink-links-2026-11-04.json)).

The run covers 100,000 rows, of which 10,000 are open, measured as medians
after one write each. It used a 2-vCPU Xeon sandbox with Node 22. The paths
are host-level only: no browser, HTTP or view composition.

| | Direct read (provider worker) | Planned read (link copy) |
| --- | ---: | ---: |
| Read after a write | 56.6 ms | 43.6 ms (replay, scan of 10,008 open rows, filter, sum, page) |
| Rows the consumer chooses | none (provider's page) | own filter, page and sum |
| Bytes crossing to the consumer | 20-row page | 1,481 B (767,834 B without pushdown, beyond the 128 KiB UI bound) |
| Read after a write to an unrelated root | 0.30 ms, no evaluation | 0.28 ms, no evaluation |
| First read | – | 722 ms (loads the copy from the journal) |

Writes took 6.8 ms with a copy following them, against 5.1 ms without. The
copy loaded once and then followed all nine writes by replay.

The end-to-end browser path at 64–2,048 rows is dominated by commit, fsync
and invalidation scheduling rather than query work
([tables profile](benchmarks/tables-profile-2026-11-04.md)). The larger
effects of these changes are therefore:

- reads after unrelated commits cost nothing;
- far fewer bytes cross the link;
- consumers can filter and aggregate at all.

The query itself was not faster in this run. [State paths](state-paths.md)
records the later work that made it so: maintained filtered views, row-level
reuse and faster snapshots.

## Validation

- `compiler/src/footprints.rs` tests: write roots, keep resolution and
  purity.
- `tests/ink-links.test.mjs`:
  - footprints through the compiler;
  - unrelated commits leave reads current;
  - identical results keep their identity;
  - `ink-reads` announcements;
  - plans checked against their definition;
  - sharing between two consumers;
  - follow-by-replay with eager refresh;
  - reads that depend on filtered views and keyed rows stay current through
    commits that change neither (skipped when the compiler predates them);
  - undeclared plans refused;
  - impure or mistyped plans rejected at system build.
- `tests/ink-tasks.test.mjs`:
  - model, HTTP and cross-app effects against local stand-ins;
  - overlapping model calls;
  - typed fallbacks and typed HTTP denial;
  - stored traces;
  - admission rejections for unbound effects, unordered writes, mistyped
    drivers and missing capabilities.
