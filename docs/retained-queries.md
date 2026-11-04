# Retained exported queries and ordered view delivery

A live typed Ink interface retains its exported query on the host. The provider's own view and other apps bound to the same provider, release, checked result type and canonical exact arguments share one result and one in-flight evaluation. No application JavaScript is needed. The Tables system example uses this path without source or proof changes.

## Commit to query to view

The first `watch` request activates the mount's declared query subscriptions. A durable `ink-app:state` commit that writes a state root the query reads invalidates the provider's retained result; commits to other roots leave it current, and a recomputation with identical exact bytes keeps the snapshot and its sequence ([cross-app plans](cross-app-plans.md)). The existing checked implementation maintains its Ink keeps as part of that transaction. The broker evaluates the exported readonly query against committed resident state, validates the source stamp before publishing, and retains its page, aggregate, exact version and positional page splice together. Both views consume that same immutable snapshot.

Only exported readonly entries with the exact declared `UiData<Row>` result type qualify. Changes, host bindings and effect protocols remain excluded. Provider `code.execute`, consumer `apps.invoke`, active releases and mount ownership are checked at admission and delivery. Changing a provider release fences its consumers rather than retargeting their bindings.

This is a **latest-snapshot subscription**. A burst of commits may coalesce into one query evaluation; delivered snapshots cannot mix a page from one evaluation with an aggregate from another. Transaction events and every intermediate commit are not a view-stream guarantee; use the transaction/event protocols for those histories. Duplicate commit notifications and duplicate write receipts do not create a new result.

The current generic query still evaluates its filter and pagination before comparing results. Its maintained aggregates use the selected checked fold plan, while the broker computes a positional splice from the complete checked result. This does not add an indexed storage plan or authorize a new incremental query rewrite.

## Two independent clocks

Frames retain ordinary UI `revision` / `baseRevision`, and additionally expose:

```js
updates: { stream: "MOUNT_STREAM_ID", sequence: 12 }
snapshots: [{
  component: "results",
  id: "RETAINED_QUERY_ID",
  sequence: 8,
  appId: "PROVIDER_ID", releaseId: "PINNED_RELEASE_ID",
  stateRevision: 142,
  versionWire: "9007199254740993"
}]
```

`updates.sequence` orders that mount's delivery frames. `snapshots.sequence` orders observed results for that query identity. `stateRevision` identifies its authoritative state header, while `versionWire` preserves the Ink query's exact version without JavaScript number coercion. Neither delivery sequence is a substitute for the application version. A restoration starts a new query identity, so a deliberate restored application version is not presented as a backwards update within the old query generation.

A source-version change can yield a zero-operation view patch. It still advances delivery metadata so clients see the checked snapshot provenance. Full trees and patches retain stable widget identities within the mount, preserving local drafts, focus, selection and IME behavior through the existing DOM adapter.

## Delivery, duplicates and reconnection

`POST /api/v1/apps/APP/ink/ui/MOUNT/watch` accepts `{stream, sequence, revision}`. It waits for the next precomputed frame after the client's cursor, or returns a heartbeat within 15 seconds. This is bounded long-poll delivery, not periodic query evaluation. The server recomputes and composes on commits; a heartbeat does not execute the query. The SDK exposes `client.apps.ink.ui(appId).watch(id, cursor)`, and the desktop MessagePort bridge exposes the same operation.

The runtime uses `watch` only when both its transport and the server advertise delivery support. It consumes live patches immediately, bypassing the fallback 32 ms invalidation timer. Existing transports and previews retain explicit refresh behavior.

A mount retains up to 32 frames / 1 MiB. Reconnecting at an older cursor replays the exact next retained frame. If that history has been discarded, the host returns a complete current tree with `updates.reset: true`. The client ignores duplicate/older frames, detects gaps and mismatched bases, and requests a complete snapshot when needed. It never replays a write to repair a read stream.

Event acknowledgement sequences are independent. Incoming live frames wait behind the serialized event lane; an unconfirmed event keeps them deferred until its explicit retry or recovery resolves. If an event reply already contains a later view cursor, older queued live frames are discarded. A deliberately lost event acknowledgement is tested with two event RPCs but only one committed application change.

An expired mount or service restart requires fresh mount admission and a new stream identity. The application version comes from durable Ink recovery. Pending writes are not automatically resubmitted. Stable drafts through same-mount replay/reset are covered; persistence of local drafts across a new mount remains the existing interface lifecycle contract.

## Bounds and lifetime

There are at most 32 retained query bindings, at most 40 cached/in-flight bindings, and an 8 MiB budget for current retained result/splice bytes, with a 128 KiB query-output bound. Prior immutable results remain referenced only by bounded query work or UI caches; UI memory accounting now includes those references. The existing per-mount 4 MiB / aggregate 64 MiB UI budget remains enforced. Replay history has a separate 8 MiB global bound; discarding history changes a reconnect to snapshot recovery, not application state.

Each mount allows at most two outstanding watch requests. Disconnects cancel their waiters. Disposing or expiring the mount releases its retained query references; disconnected clients retain the existing 15-minute mount lifetime for reconnection. Readonly execution uses the shared host CPU/worker budgets. Query retries under contention and resource pressure back off; terminal query/release errors are delivered rather than replaced with a fabricated result.

Maintenance closes admission, pauses eager query work and wakes delivery waiters. In-flight query work participates in host drain tracking. Service shutdown releases subscriptions, waiters, retry timers, histories and caches.

## Validation and measurement

Server tests cover shared query execution, exact replay, source versions, duplicate notifications and write receipts, aborts, filter/page movement, aggregate consistency, burst coalescing, history overflow, ownership and release fences. Browser tests cover drafts/caret/focus, duplicate and gapped delivery, discarded query replies and lost event acknowledgements. Actual JavaScript/native runs compare the same retained-query history.

Run:

```sh
node --test tests/ink-retained.test.mjs tests/ink-ui-api.test.mjs
INK_TEST_NATIVE=1 node --test tests/native-retained.test.mjs
INK_TEST_UI_BROWSER=1 INK_UI_BROWSER_EXECUTABLE=/path/to/chrome \
  node --test tests/retained-browser.test.mjs tests/ui-browser.test.mjs
node scripts/benchmark-ink-system.mjs --live --rows 64,2048 \
  --modes javascript,native --edits 32 --output work/retained.json
# Omit --live for the matching explicit-refresh comparison.
```

The benchmark records query evaluation counts and completed RPC action counts. In live mode it accounts for request/response pairs completed in the window, including watch requests started before the first edit and excluding the next outstanding request. HTTP/body bytes still include the existing verbose write replies; retained delivery does not remove those descriptors. The latency remains a DOM/animation-frame proxy, with production authentication, desktop MessagePort and physical presentation outside that measurement.

[Measured refresh-versus-retained comparison](benchmarks/retained-query-2026-11-04.md) records execution counts, body bytes, latency and recovery outcomes.
