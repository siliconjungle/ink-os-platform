# Reusable checked proof units

The Tables/dashboard demonstration now carries 180 independently admitted mathematical declarations in an `ink-proof-plan-v1` envelope. Its proof plan shrinks from 8,377,091 to 2,957,372 UTF-8 bytes. Each declaration has its own bounded compressed payload and explicit dependency list. Snapshot-membership witnesses share a dictionary. The release remains self-contained: a fresh host needs no catalogue service or previously trusted disk cache.

## Full verification and reuse

A cold compiler session decompresses one missing unit at a time, verifies its canonical content identity, and passes it to `ink_core::proof_units::Checker`. The existing first-order checker validates interfaces, declared imports, types, totality and theorem proofs. Only successful checks install an opaque logic entry. The theorem's proof body is then discarded; checked conclusions and their immutable dependencies survive. Hashes, compression and producer flags cannot create those entries.

Every application admission still reconstructs and checks the complete original Ink module graph. Unit-scope admission validates the exact reachable dependency closure and current pinned snapshot membership. It re-derives source definitions and fixed fold meanings, then replays the source-specific factorisation, group, insertion, deletion and replacement equations. Unrelated cached entries cannot become premises. Full generated artifacts, target inventories and module summaries are compared during release verification as before. Source/release fences and state migration rules are unchanged.

A second admission can reuse the mathematical entries even under a new snapshot, provided current membership and complete applicability checks pass. The example's changed heading requires one new source-definition unit and reuses 180 existing units. Changing the keep's meaning fails the old factorisation even after source observations are regenerated. This is checked reuse of immutable mathematical dependencies, not separate compilation of arbitrary Ink code or a new equality rule.

The kernel API and independently validated package are documented in [Ink's proof-unit contract](https://github.com/siliconjungle/ink-lang/blob/90c8b522/docs/proof-units.md). The [standalone core check](https://github.com/siliconjungle/ink-lang/blob/90c8b522/docs/proof-units-core-check.json) binds its exact source and package trees. There are no new optimisation laws in this change.

## Lifetime and bounds

One serialized compiler worker retains the checked unit session. It holds at most 16,384 units and 32 MiB of original canonical declaration provenance; proof bodies are not retained in the kernel. Each admitted OS closure remains bounded to 12 MiB expanded unit data. Compressed transport is also bounded, canonical base64 is checked, and Brotli expansion has an explicit output limit. Unit loading hints never replace the actual dependency checks in the kernel.

The host permits sixteen outstanding requests, one active CPU lane, a 256 MiB worker old-generation limit and the existing 512 MiB maximum Wasm memory. Its conservative **1 GiB host memory reservation remains unchanged** from large complete-plan admission. Idle sessions expire after ten seconds and can be reclaimed earlier by the shared resource budget. Deadlines stop the worker before releasing active resource claims. Resource retirement failures close further host admission. Eviction, compiler replacement or process restart loses all unit witnesses; the next uncached compilation must replay its complete closure. Ordinary checked compilation/artifact caches can still reuse their own immutable results.

Malformed proofs and source-specific failures do not authorize a fallback to unchecked code. They reject admission. Valid units checked before a later failure remain valid dependencies; a failed declaration is never installed. Changed wire encodings replay in a fresh session. No serialized “already checked” flag is accepted.

## Authoring and reproduction

The committed `examples/tables-system/tables/selected.plan.json` now uses the unit envelope. Existing complete packets remain supported. To convert or inspect a packet:

```sh
node scripts/ink-proof-plan.mjs pack complete.plan.json units.plan.json
node scripts/ink-proof-plan.mjs unpack units.plan.json complete.plan.json
```

`pack` changes transport only and checks content identities; it is not proof admission. A normal Ink build/deployment performs the kernel checks. The Tables authoring script checks the producer's complete packet first, packs it, and checks the packed form before replacing the committed plan.

`rebindProofPlan(source, plan)` is an authoring API for a single maintained step. It obtains exact source observations from the compiler, preserves exact integer literals, refreshes the candidate scope and invokes the full checker. It cannot manufacture missing preservation or factorisation proofs. It retains the supplied proof basis; long edit histories may require a fresh producer closure to remove obsolete roots and remain within the finite transport bound. It does not migrate application state or bypass release publication rules. Current unitisation covers first-order maintained-fold knowledge; other proof domains retain complete replay.

The browser compiler uses the same opaque core API. Its locked compatibility lowering revisions preserve the previous lowering **source trees**, changing dependency pins only. The current independent package mains also use the new core. `compiler/replay-compatibility.json` permits trying known older compiler packets; that receipt grants no proof authority. Current full proof, module-summary, target-byte and artifact replay remains mandatory. Unknown compiler identities still reject.

## Measurements and validation

[The matched admission study](benchmarks/proof-admission-2026-11-04.json) runs three fresh Node processes per form in alternating order. It verifies a cold release, then admits a changed view with refreshed source observations. It includes kernel checking, source checking, emission and artifact comparison; excludes authoring, compaction, network transfer and application execution. No forced GC is used. Generated JavaScript and Rust source are byte-for-byte identical between proof formats for both source versions.

| Admission form | Implementation file | Cold verification median | Changed view median | High-water RSS median |
| --- | ---: | ---: | ---: | ---: |
| Complete packet | 9.45 MB | 2530 ms | 2450 ms | 659 MiB |
| Checked units | 3.80 MB | 672 ms | 279 ms | 331 MiB |

The report separates raw plan bytes from serialized implementation-file bytes. It records Node heap counters, sampled process RSS, OS high-water RSS and Wasm capacity. RSS includes the coordinator and its worker threads; Wasm capacity and reservation sizes are not interchangeable with RSS. These are local synthetic results, not an end-to-end latency or compressed HTTP transfer claim. Existing application RPC bodies are unaffected.

```sh
node --test tests/ink-proof-units.test.mjs
node scripts/benchmark-proof-admission.mjs
INK_TEST_NATIVE=1 node --test tests/native-system.test.mjs
```

Tests cover exact transport, cold replay, cross-release reuse, semantic view edits, incompatible keeps, corrupt units, rehashed false theorems, bad membership, forged equations, fresh-session recovery and deadline/resource release. Existing system histories preserve conflicts, rollback, duplicate/lost replies, events and recovery. The actual Chrome retained-query demonstration passes with JavaScript and compiled native execution.
