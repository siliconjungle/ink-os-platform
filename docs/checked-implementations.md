# Checked Ink release implementations

New Ink builds produce application contract version 3. They include the original
private source closure and `server/implementation.json`. The latter binds:

- the exact original source bytes/module graph and bundled compiler identity;
- the complete `ink-compiled-plan-v1` packet, including its embedded proof views;
- the checked original/selected core identities and canonical plan identity;
- literal JavaScript and native Rust source artifacts and target hashes;
- target availability, unsupported-target reasons and the native-to-JavaScript
  `auto` execution fallback;
- selection provenance, and search receipts, workload/profile inputs and referenced
  immutable cost observations when search uses them.

Build and deployment replay the complete plan through Ink's existing checker.
Deployment also compares the packaged artifacts with freshly checked emission;
rehashing changed code does not authorize it. Publication verifies the release
content digest and replays the implementation before deployment. Implementation
files remain private under `server/`, alongside the original Ink source.

Installed commands, views, host bindings, previews, migrations and native build
jobs use the selected implementation. Runtime never runs discovery or timing
probes. Exact-byte verification/compilation results have bounded process-local
caches. A restarted host independently replays the evidence without the planner
or a live knowledge store.

The logical checkpoint identity remains bound to the original source. Selecting
a different valid plan for the same original source does not require a migration.
Changing source bytes or any module dependency retains the existing source-change
and explicit migration requirements. Native artifact compatibility additionally
binds the complete implementation packet and the existing toolchain/host inputs.

## Build modes

The optional `ink-app.json` field is `optimisation`:

```json
{"optimisation":{"version":1,"mode":"auto","budget":2048,"timeSeconds":8}}
```

`auto` is the default. Without a configured planner it emits a checked empty plan
and records why the baseline was retained. Configured builds run bounded offline
search. A failed search retains a checked baseline and records the failure class.
An invalid selected proof or an unsupported selected host plan is rejected.
`baseline` explicitly selects the checked empty plan. `search` requires a configured
planner and reports search failures instead of retaining the baseline.

Build hosts configure these together:

```sh
export INK_OS_PLANNER_COMPILER=/path/to/pinned/ink
export INK_OS_KNOWLEDGE_ROOT=/path/to/private/ink-knowledge
export INK_OS_KNOWLEDGE_SNAPSHOT=/path/to/pinned/snapshot.json
```

Use an installed Ink distribution with its matching planner/knowledge packages.
Prepare the knowledge discovery index before enabling host search; first-time
index construction also counts against the OS subprocess deadline. Each build
captures its configured snapshot into private immutable build inputs.
The compiler is an administrator-selected executable; app manifests cannot supply
commands. Search uses the existing `ink compile --core --optimise ... --snapshot
...` interface on the exact core produced by the bundled compiler. The bundled
checker independently replays the result, so different checker versions cannot
silently authorize incompatible plans. Search publishes candidate/observation
objects into the configured private knowledge root, as the upstream planner does.

Builds share one search queue with at most eight admitted searches. Manifest
budgets are bounded to 16,384 proof attempts and 120 search seconds; the host also
bounds states, worker count, measurement work, output bytes and total subprocess
time. Search never happens during installation verification or request execution.

For existing lifecycle evidence, supply all three committed inputs:

```json
{"optimisation":{"version":1,"mode":"search","profile":"planning/profile.json","workload":"planning/workload.json","targetProfile":"planning/target.json"}}
```

They are passed to the existing profitability selector and retained in the private
release. Without supplied inputs the upstream planner may acquire bounded pure
workload probes during the build. Missing comparable evidence retains its baseline.
Cost receipts and observations explain selection; they grant no equality authority
and do not establish a general speedup.

To replay an already authored plan from committed application source:

```json
{"optimisation":{"version":1,"mode":"replay","plan":"planning/selected.plan.json"}}
```

The file must be an upstream compiled plan for this exact checked source. Both
`ink-os build DIRECTORY` and committed-source deployment include it. Replay needs
no external planner and is an explicit implementation choice, without an automatic
profitability claim. Source/individual planning inputs, aggregate compiler requests
and complete releases retain independent byte limits.

## Target scope and trust

The OS replay host admits source rewrites, function replacements, conservative
extensions and compatible checked properties, maintained views, state protocols
and JavaScript physical choices. JavaScript is required; native Rust is available
when its literal emitter supports the complete plan. A native-only physical choice
cannot silently disappear from the required JavaScript implementation.

Definition representations, placement/routing and resource host plans require
different execution adapters and currently reject explicitly. Planned GPU execution
is unavailable and is recorded as such; original-source GPU artifacts are never
presented as selected-plan artifacts. Legacy version 1/2 releases retain their
original compilation contract.

Proof checking does not formally verify codecs, lowerers, runtime hosts, storage,
Rust compilation or machine code. Those remain trusted implementations. The
integration adds no proof rules or optimizer-specific recognition to Ink's core.

The lifecycle tests use a source-bound helper-elimination proof, compare baseline
and selected checkpoint histories, exercise abort/event/restart behavior and
reject forged proof/code/source/target packets. `compiler/examples/plan-fixture.rs`
reproduces their plan from the pinned core's ordinary projection and proof APIs.
Native tests exchange selected-native and original-JavaScript snapshots.
