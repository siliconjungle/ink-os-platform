# Typed Ink effects and protocols

Installed Ink apps can now express HTTP, virtual files, clocks, random bytes,
fixed host processes, World subscriptions and direct Ink app calls. The app's
control flow, continuation state and request/reply types are Ink. The host owns
capability checks, dispatch, durable observations and resource cleanup.

Use `sdk/ink/effects.ink` (package export `@ink-os/platform/ink/effects`) as an
explicit dependency in the committed module graph. The complete runnable source
and manifest are in [examples/typed-effects](../examples/typed-effects). That
example samples random bytes and writes them to a versioned file, entirely under
Ink control. The library copy in the example is checked against the SDK source.

## Checked boundary

A protocol has a public pure begin function and a private pure two-argument
continuation. Both return `Result<Output,EffectPending<State,AppInput>>`.
`Ok(output)` finishes; `Err({state,request})` suspends. The continuation receives
`(State,EffectReply<AppOutput>)`. Export both functions from the root module graph,
but expose only begin in the app manifest's `exports`. Begin cannot be a view or
a legacy host binding. Protocol transitions cannot be Ink actions or queries.
Other app entries can still use normal Ink state.

The compiler checks the full module closure and every transition's codecs on both
JavaScript and native backends. Release validation additionally checks the exact
version 1 boundary schema, finite continuation types, matching state/output types,
explicit operations and capabilities. The release binds this manifest alongside
its replayed implementation plan. External semantics are enforced by the trusted
broker and resource contracts; the Ink kernel does not prove a remote server's
behavior. Pure transition optimizations may run inside the existing checked
planner; the planner cannot reorder host dispatches.

```json
"effects": {
  "version": 1,
  "protocols": [{
    "entry": "save_nonce", "resume": "resume",
    "maxSteps": 2, "deadlineMs": 5000,
    "operations": [{
      "name": "sample", "kind": "random", "resource": "system",
      "effect": "volatile", "retry": "recorded", "deadlineMs": 1000
    }, {
      "name": "save", "kind": "file", "resource": "nonces",
      "effect": "write", "retry": "recorded", "deadlineMs": 1000
    }]
  }]
}
```

`EffectRequest` contains an operation name and one typed `Some` payload for the
chosen family; every other family is `None`. Names select the manifest's fixed
operation and resource, not arbitrary host functions. `EffectReply` contains the
operation, monotonic sequence, observed version, typed family result or
`EffectError {code,message,certainty,retryable}`. String error codes and operation
names are closed/validated by the broker where used; byte lists refine `u32` to
0–255 at dispatch. Text responses are `Option<String>` because binary data may
not be valid UTF-8. Exact JSON preserves all integer widths; SDK display values
and `valueWire` follow the existing Ink value conventions.

## Ordering, retry and recovery

Each protocol dispatches one operation at a time. Independent runs execute with
at most four active workers, sharing the existing bounded resident Ink pool.
At most 64 runs are admitted, with 16 per app. Each run has at most 32 operations,
a deadline of at most 30 seconds, 128 KiB arguments, 64 KiB continuation state,
512 KiB transition replies, and 64 KiB individual IO payloads. The manifest can
choose smaller deadlines and budgets. A per-operation timeout is a typed reply
that Ink may handle while the overall deadline remains; the overall deadline
ends the run. Cancellation aborts active transport/worker/process work and ends
the protocol, retaining the latest observation and conservative
`cancellation.mayHaveTakenEffect` information. It never promises rollback.

A private append-only journal records admission, the pending continuation, an
in-flight marker before dispatch, and the observed reply before resuming Ink.
Checkpoints compact this journal periodically. Virtual file changes and their
reply share one journal transaction. A crash before that transaction cannot have
committed the file change; a crash after it reuses its reply. Protocol state is
separate from ordinary Ink action state and World records. This is not a
transaction across remote effects, Ink action state and World. Compose such work
with explicit reconciliation/compensation in the protocol.

Clients should create an ID with `effectRequestId()` before their first attempt
and retain it across transport retries. IDs are `unixMilliseconds:UUIDv4`, scoped
to the app and bound to release, entry and exact argument bytes. A duplicate
returns the same run/result; reusing it for different arguments returns 409.
IDs expire after 24 hours, after which they return 410 and can never execute
again. Terminal receipts can then be pruned. The store admits at most 10,000
receipts/128 MiB, reserving space for active runs. This is bounded receipt
retention, not unlimited deduplication. SDK calls generate an ID if omitted;
explicit IDs are needed to retry after losing the first response.

Recovery replays a durable reply without redispatching it. An in-flight HTTP
write, process or app call without a reply becomes `Interrupted` with
`certainty: "unknown"`. It is never automatically repeated. A manifest may opt
an HTTP **read** into `retry: "observe-again"`; recovery then makes a fresh
observation (at most three attempts), retaining the same sequence. This is not
snapshot equality. Unobserved clock/random samples may be regenerated; recorded
samples are reused. Subscription recovery reports `Gap` and requires resync.

Source release identity, operation contract, current app capabilities and the
private resource policy are checked before dispatch. App publication drains
active protocol writers before switching releases; queued old runs are fenced.
Policy changes fence recovered runs. Maintenance closes admission, drains
accepted runs, counts their tasks and journal writes, and checkpoints effects
before backup/shutdown. Private backups include the effects directory. Remote
services, process side effects and external policy/secret files remain outside
that local consistency boundary. Virtual effect files are currently separate from
World app-data export/duplication; copy them explicitly in a protocol when
forking an app.

## Resources and capabilities

| Kind | Capability | Contract |
| --- | --- | --- |
| `http` | `effects.http` | Fixed private profile: HTTPS origin, method allowlist, path prefix and private environment-backed headers. No redirects. Optional observed ETag becomes `If-Match`; a profile can require it for writes. HTTP status (including 4xx/5xx) is a normal response. |
| `file` | `effects.files` | App/resource/name-scoped virtual binary files. `read`, `write`, `remove`; writes/removes require an expected version, including version 0 for creation. Tombstones preserve versions. No ambient host filesystem access. 512 files and 32 MiB contents per host. |
| `clock` | `effects.clock` | Resource `wall-clock`: optional bounded delay, then Unix milliseconds. Wall time is not monotonic and is not a snapshot token. |
| `random` | `effects.random` | Resource `system`: cryptographic random bytes, at most 1024 per request. |
| `process` | `effects.process` | Fixed private executable/digest/arguments, empty inherited environment, disposable cwd, bounded stdin/stdout/stderr. Executable changes are checked before spawn. A supervisor kills the ordinary process group on cancellation, deadline or broker IPC disconnect. |
| `subscription` | `effects.subscribe` | Resource `world`: `open`, `next`, `close`. Own app namespace event metadata, opaque run/release-bound handles, 128 queued events per handle. Shared underlying World listener; overflow/restart yields `Gap`. Handles close at run end, cancellation or expiry. |
| `app` | `apps.invoke` | Manifest-pinned `{appId,releaseId,entry}`. Direct host call to an exported non-protocol/non-legacy Ink entry. Input/output ABI checked before dispatch. A two-argument entry may receive broker-injected `{appId,releaseId}` caller identity followed by the typed input. Zero-argument targets require Unit; otherwise one typed input. Read operations cannot call changes. |

HTTP/process resources are denied unless an operator provides a private policy
through `INK_OS_EFFECTS_POLICY_FILE`. Applications cannot choose origins,
credentials, executables, argument vectors or namespace grants. Example policy
(the resource namespace should normally be a specific app ID, not `*`):

```json
{
  "version": 1,
  "resources": {
    "inventory": {
      "kind": "http", "namespaces": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      "origin": "https://inventory.example.invalid", "pathPrefix": "/v1/items",
      "methods": ["GET", "PUT"], "requireVersion": true,
      "headersFromEnv": {"Authorization": "INVENTORY_AUTHORIZATION"}
    },
    "image-metadata": {
      "kind": "process", "namespaces": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      "executable": "/opt/ink-tools/image-metadata", "args": ["--stdin"]
    }
  }
}
```

The process profile is a privileged operator grant, not an OS sandbox for
untrusted executables. A tool can access files/network allowed to the host user
and must enforce its own input contract. Process-group cleanup cannot contain a
tool that deliberately escapes its group. An HTTP allowlist is an operator trust
boundary; DNS and the remote service's interpretation remain external concerns.

## API

- `POST /api/v1/apps/:appId/ink/effects` with `{entry,input,requestId,backend?}`
  durably admits a run and returns 202.
- `GET /api/v1/apps/:appId/ink/effects/:runId` returns status, last receipt and
  final value or terminal observation. Another app/account cannot inspect it.
- `POST /api/v1/apps/:appId/ink/effects/:runId/cancel` requests cancellation.
- Existing `/ink/run` executes a protocol to completion and returns its final
  output plus `effectRun`. All these routes require `apps:invoke` for API keys.
- Server SDK: `client.apps.ink.effects(appId).start/get/cancel`; browser SDK:
  `client.ink.effects.start/get/cancel`. Installed-app frame calls require
  `code.execute`, and temporary/disposable previews cannot dispatch effects.
- CLI: `ink-os ink run APP_ID ENTRY --input JSON --request-id ID`.

## Optimization scope

This establishes explicit types, resources, versions, ordering and lifetimes at
the compiler/host boundary. It immediately removes HTTP serialization from typed
local app calls and shares World subscription listeners. It does **not** yet
batch HTTP reads, memoize observations, reorder protocol operations, share
subscription cursors, or optimize a protocol jointly with relational queries.
Those rewrites need checked rules for snapshot equivalence, error/timeout
behavior and dependencies. Identical request bytes alone never authorize them.
