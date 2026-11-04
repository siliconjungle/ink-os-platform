# Safe concurrent scheduling

Ink OS has an opt-in workflow DAG executor and a shared host resource governor.
It executes independently checked pure functions concurrently, batches bounded
World reads over a detached snapshot, and preserves the source order of writes,
stateful queries, effect protocols and unknown backend calls.

The [complete example](../examples/parallel-workflow) computes two values in
parallel in Ink, joins their exact JSON outputs, then publishes and reads the
result in order. No JavaScript application backend is required.

## Opt in and declare dependencies

Existing definitions without `scheduling` retain their sequential behavior.
New definitions can use the same SDK/CLI save/preview/run APIs:

```json
"scheduling": {"version": 1, "mode": "parallel", "maxConcurrent": 4}
```

The policy admits 1–4 concurrent steps within a run; the existing run concurrency
limit and the shared governor apply as well. This is a new explicit workflow
execution contract, `ink-os-workflow-frontier-v1`, not a proof that arbitrary
sequential workflows have indistinguishable error/timing observations in parallel.

Result bindings create dependency edges automatically. A step may additionally
specify `dependsOn: ["earlier-step-id"]`, for ordering that has no data binding.
References must name distinct earlier steps, so cycles and self/forward references
are rejected. A step becomes ready only after all its predecessors succeed.

At execution the host derives a plan from each pinned release:

| Work | Admission evidence | Execution |
| --- | --- | --- |
| Pure Ink function | Selected source/implementation is checked; exported entry is a pure function, without a host binding or effect protocol | Independent resident workers, preserving typed inputs and exact outputs |
| Host query command | Fixed host `query` handler, not arbitrary backend code | Ready query siblings share a detached World snapshot; identical effective queries reuse one physical result |
| Ink change/query, legacy binding, effect protocol, backend or polling command | No admitted contract preserving every observable concurrent execution outcome | Barrier: wait for every earlier step, and hold every later step |

An app-authored `effect: "read"`, repeat-safe/idempotent flag, access-analysis
report, different table key or commutation hint cannot remove a barrier. The
actual Code executor independently rejects a concurrent lane for an Ink action.
The per-state journal/serialization path remains authoritative for stateful work.

`run.schedulerPlan` records the checked classification/source identity, graph,
resource limits and snapshot receipts. The normal workflow release/command checks
also run immediately before dispatch; publication cannot turn a previously
classified pure call into an unchecked concurrent write. The workflow preview
fingerprint binds the definition's scheduling policy, dependencies, arguments and
release/command contracts. Detailed checked scheduling evidence appears on the
admitted run, after source verification.

## Read batches and transport

A ready frontier's compatible host query commands capture one version and the
public records synchronously, then query the detached snapshot. Workflow progress
projections and unrelated writers can continue without changing that view.
Private app-source/artifact records remain excluded. Snapshot capture is bounded
to 20,000 public records/32 MiB; oversized batches fail explicitly.

Equivalent effective queries within this snapshot share computation; their
results are detached for each consumer. The receipt records version, participating
steps, logical reads and physical query count. Snapshot memory is reserved until
every member finishes, including cancellation and failure cleanup. This is a
batch of host queries with shared physical work, not a new remote batching API.

Each ready frontier has its own snapshot. A writer barrier starts a later read
frontier; a resumed run may also capture a new version. The contract does not
claim one transaction or one snapshot across the entire workflow, remote effects,
Ink action state or all result-dependent frontiers. Ink state queries retain their
normal journal/version semantics and are currently barriers. Typed relational
storage continues to select its normal indexed plans on its own API; arbitrary
relational joins are not yet fused across workflow commands.

HTTP reads are not coalesced by matching bytes. The current typed effect protocol
does not supply a remote snapshot/batch equivalence contract, so such calls remain
ordered workflow steps. Typed local app effects retain their direct call path;
World subscriptions retain the shared underlying listener from the effect broker.

## Failure, cancellation and restart

A failure stops new step admission. Already admitted independent siblings settle
before the run becomes terminal; their successful outputs remain durable. Error
selection and artifact ordering follow definition order, not completion timing.
No write suffix is released after a failed prerequisite. Parallel policy can
therefore retain more independent results than the sequential failure path.

Cancellation is recorded before queued resource requests are notified. It stops
new admissions and can abort queued/running pure calls. Already dispatched opaque
backend work is allowed to settle; cancellation never asserts that a write was
undone. Polling and typed effect runs retain their existing cancellation/deadline
and unknown-outcome rules. Resource claims remain held until their drivers stop,
including worker/process termination; a cancelled waiter cannot dispatch later.

Every step result still passes the existing output/size validation and is durably
published through the workflow store's serial queue. The executor waits for all
admitted branches before acknowledging terminal status. Restart marks each
unfinished running step interrupted, retains successful siblings, and requires
normal review/resume. Completed steps are not automatically repeated. Resumption
rechecks release identity and constructs a fresh checked schedule. Workflow store
updates/projections still serialize; this work does not replace that store with
a parallel transaction engine.

## Shared resource admission

`server/execution-budget.mjs` supplies one ledger per OS host process, shared by:

- Compiler and isolated preview/migration workers.
- JavaScript/native resident workers and their active CPU work.
- Native Cargo compilation and configured implementation search.
- Typed HTTP and fixed process effects.
- Workflow snapshot capture/query CPU work and snapshot memory.

Owners rotate through a bounded queue (256 total, 64 waiting per owner). Requests
claim CPU slots, memory reservations, active network requests and GPU slots
atomically. Oversized claims fail rather than waiting forever. Memory-blocked
requests cannot prevent CPU-only continuations from finishing and releasing
memory, including continuations queued by the same owner.

An idle resident still reserves memory. Under pressure the governor evicts idle
residents; active residents are not evicted for admission. Durable action journals
restore state after eviction. Memory is released after termination, not when an
eviction is merely requested. Uncertain retirement fences new resource admission
and quiescence until recovery. Pure calls use bounded pooled lanes; ordinary state
calls retain their one serialized resident and portable checkpoints.

Each host-managed Ink invocation currently reserves one CPU slot. Nested
`parallel_map` and owned parallel helpers use the literal one-worker path:
JavaScript calls `setParallelism(1)` and native children receive `INK_THREADS=1`.
Cargo receives `CARGO_BUILD_JOBS=1`; planner measurement uses one process. This
prevents every app from independently multiplying workers. Larger intra-call
allocations can be added when the host assigns and charges their complete worker
and scratch footprint; they are not enabled by an application hint.

Default limits are at most four available CPU slots, a memory reservation budget
of one quarter of physical RAM clamped to 1–4 GiB, eight network slots, and zero
GPU slots. The OS platform currently has no admitted GPU effect/execution driver;
a budget setting does not make an unsupported GPU implementation eligible.
An operator may set partial overrides with:

```sh
INK_OS_EXECUTION_BUDGET='{"cpu":2,"memoryMB":2048,"network":4,"gpu":0}'
```

Worker/compiler admission reserves 512 MiB per process/worker, snapshots reserve
128 MiB per active read batch, and typed HTTP requests reserve 8 MiB plus a network
slot. Existing worker heap, native allocator, payload, IO and time limits still
apply. These are conservative admission reservations, not a measurement or a hard
OS-wide RSS/CPU/network sandbox. Base host data, compiler artifact caches, unrelated
processes, deployment containers and opaque backend services are outside this
ledger and keep their existing limits. Fixed process profiles are privileged
operator grants and must not hide recursive host dependencies or unbounded child
work. Hard whole-machine enforcement requires container/OS resource controls.

Administrators can inspect aggregate limits/usage/waiting reservations with
`GET /api/v1/execution` (SDK `client.request('execution')`). Maintenance and backups
count active/queued governor work and concurrent pure tasks, drain accepted
workflow branches, and ignore idle memory-only reservations as execution activity.

## Proof and optimization boundary

The current action algebra checks equality for an augmented sequential pair, but
its documentation explicitly leaves per-call commit-version preservation open.
This scheduler does not consume that equality as concurrent-write authority.
Access descriptions also explicitly grant no reordering authority. Source purity
and the host's captured snapshot are the admitted contracts used here.

A future concurrent-write consumer must name a checked execution contract that
preserves individual replies, committed versions, failures, events, recovery and
publication. GPU placement, HTTP batching, cross-command query fusion and rendering
optimization likewise require their own admitted contracts and comparable cost
and resource evidence. This change unifies dependency and resource admission for
the supported host paths; it does not claim a globally optimal device/transport/
rendering plan or a performance win from conformance tests.
