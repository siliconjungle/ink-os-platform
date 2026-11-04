# Resident Ink execution and durable journals

Ink OS keeps compiled application modules, checked input schemas, bindings, and
working state resident. Successful state changes are acknowledged only after a
durable record binds the action, exact input, reply, emitted events, and retry
receipt. Evicting a worker never requires saving otherwise uncommitted state.

## Execution

`Code` owns an LRU pool shared by its JavaScript workers and native processes.
The default limit is four residents, with a 30-second idle timeout and a
30-second timeout per worker request. A busy resident is never evicted to admit
another call: full capacity returns HTTP 429. Constructor options `limit`
(1–8), `idleMs`, and `timeout` tune these bounds. JavaScript workers retain their
compiler Wasm instance and one checked immutable input schema; native services
retain their generated `State` and validate arguments through generated JSON
codecs. Workers have a 256 MiB V8 old-generation limit; native allocations have
a 256 MiB budget. These are not a complete OS process sandbox or a total host
memory limit.

Residents are keyed by namespace, state key, implementation, native artifact,
and release. Calls to one state instance serialize. Different instances can
execute concurrently, within the pool limit. Runtime write admission spans
execution and publication, so activation fences cannot allow an old release to
publish after activation. State source and complete module graph identities
remain checked across restarts and target/implementation changes. Exceptions,
timeouts, publication conflicts, and uncertain writes discard the tentative
resident; the next call recovers authoritative committed state.

One-shot workers remain available for compiler operations, previews, and explicit
migration helpers. Cached native executables are replaced atomically when
rebuilt, allowing existing processes to finish using their original executable.
This driver changes native compatibility keys: rebuild native targets to use the
resident service; `auto` uses JavaScript until a matching native build is ready.

## Application durability

The ordinary state field (`ink-app:state` for installed applications) becomes an
`ink-os-app-journal-v1` manifest. It references an immutable base checkpoint and
up to 31 committed action records. Hashes bind every payload and its predecessor.
Each record includes the exact result wire, including event commit identities.
Recovery restores the base, re-executes committed actions, and rejects any
result or event mismatch. Recovery never delivers those events as new actions.

Payloads are split into 32,768-code-unit chunks under internal `@ink:` state keys.
They use the existing namespace storage: the collaboration journal when present,
otherwise World's journal. Chunks are staged in bounded batches. Publication is
a compare-and-swap of the manifest revision after all referenced chunks are
durable. A crash during staging leaves the previous manifest authoritative.
Concurrent replacement invalidates the resident. Unreachable chunks are removed
on cold recovery, explicit checkpoint replacement, and periodic compaction.

Every 32nd committed change creates a new base; a tail exceeding the 1 MiB target
also triggers compaction on the next change. Payloads have a 2,048-chunk budget.
Portable checkpoint consumers materialize an ordinary complete Ink snapshot on
demand, preserving migration APIs. Older stored snapshots are accepted and
converted on their next committed change. Namespace duplication preserves the
payload bytes rather than remapping identifiers inside opaque journal data.
Complete namespace captures, OS Versions, and host backups carry the recovery
closure. Scoped imports must include all referenced internal state fields.
Collaboration continues to retain its causal operation history for sync; live
payload garbage collection does not discard that history.

Installed Ink calls accept `requestId` through the existing SDK options:

```js
await client.apps.ink.run(appId, 'add', '[7]', {
  requestId: operationId,
  backend: 'auto',
});
```

Retry with the same identity, entry, and exact JSON input text to receive the
original committed reply without executing again. Reusing an identity with
different arguments returns 409. Receipt retention is bounded to the newest 64
replies with a 1 MiB target, always retaining the newest reply. A retry after its
receipt expires can execute again. Explicit migration/reset replaces the retry
history. Failed actions and queries do not publish new state. This contract
covers Ink state transactions; external host bindings and network side effects
retain their own CAS/idempotency contracts.

## World durability

World's serialized transaction queue now appends to `world.journal`. Each record
binds checked Ink actions and exact outcomes, history changes, mutation receipts,
blob retention changes, and notification/event data. Validation uses an Ink host
transaction that is rolled back before awaiting I/O, keeping tentative rows
invisible. Only after append and file sync does World apply and publish the
validated transition. Ordinary edits do not create full-store rollback snapshots
or rewrite `world.json`.

World checkpoints after 128 transactions or an 8 MiB journal. A checkpoint is
synced and atomically published before replacing the log with a header anchored
to its sequence/hash. Recovery accepts either the old log prefix or the rotated
log only when it matches the checkpoint. Only an incomplete final line is
truncated; complete corrupt records, gaps, foreign cores, and missing required
journals fail closed. An uncertain append/checkpoint failure blocks further
World reads and writes until recovery. Permanent deletion immediately checkpoints
to remove purged payloads from the current checkpoint and journal. Explicit
backup, maintenance, migration, and shutdown checkpoints remain supported.

A host backup must include **both `world.json` and `world.journal`** from a
quiescent capture, plus existing collaboration storage. Copying only the most
recent checkpoint can omit acknowledged commits. This remains a single-writer
host design: the global queue and fsync serialize World commits. Resident
execution removes reconstruction overhead; it does not introduce concurrent
writers or automatically optimize database/network plans. Checkpoint-only older
host versions cannot safely open this journaled directory; use a compatible host
or an explicit offline migration for a downgrade.

## Validation

`tests/resident-ink.test.mjs` exercises process death after durable publication,
lost acknowledgements, abandoned staged payloads, eviction, restart, portable
checkpoints, namespace copies, corruption, deterministic replay mismatches,
bounded pool admission, and visibility during delayed/failed appends.
`tests/native-ink.test.mjs` checks resident Rust/JavaScript switching, exact wide
values/events, retry receipts, invalid input, and rebuilding an executable while
a resident is alive. Compiler tests cover cached-schema identity enforcement.

A local 20-call counter-query microbenchmark measured a median 0.31 ms resident
call versus 27.61 ms through the preceding per-call compiler/worker path, with
compilation excluded from both. A small World edit appended about 1.9 KiB both
with an empty surrounding store and with 250 unrelated 8 KiB rows (a 4.97 MB
checkpoint). These measurements illustrate the removed startup and full-store
write costs; they are not production workload guarantees. Periodic checkpoints
still cost work proportional to retained state.
