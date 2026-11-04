# Typed, incremental Ink interfaces

An app can define its views, state, form logic and navigation in Ink. Version 1 adds a checked interface to the existing version 3 implementation release. The installed host executes the admitted implementation; it does not search for a new plan during rendering.

[Runnable example](../examples/typed-ui) · [Ink library](../sdk/ink/ui.ink) · [Portable adapter](../sdk/src/ui-model.js)

## Authoring

Copy `sdk/ink/ui.ink` into the app's committed module graph. Declare the library's explicit exports and the root's view and handler entries, as in the example. Add:

```json
{
  "ui": {
    "version": 1,
    "entry": "view",
    "event": "navigate",
    "components": [
      {"name":"editor","entry":"editor","event":"save"},
      {"name":"rows","entry":"rows","event":"remove"}
    ]
  },
  "exports": ["navigate", "save", "remove"]
}
```

A component returns `UiView<Action>`: a root ID and a flat list of `UiNode<Action>` records, linked by child IDs. Constructors cover flow groups, headings, text, buttons, fields, toggles, selects, lists, tables, forms and navigation. Use `ui_cell` and `ui_header` for table cells. `ui_events` attaches declared handlers; `ui_disabled`, `ui_invalid`, `ui_description` and `ui_field_kind` update typed properties.

IDs must be stable across updates. Use domain keys, not list positions. `ui_key` preserves all 64 bits of an integer ID. Each component uses local IDs; the host scopes them by its mount path, so two instances can safely reuse local names. Changing a widget's kind or a field's input kind remounts it. Removing it disposes its resources. A component definition is evaluated once per render even when mounted in several places. Its instances share view data but have distinct input drafts.

A readonly view can be a pure function or a query over app state. A `Component` slot names a declared child component. Component graphs cannot recurse. In version 1, slots are flow containers; place a list or table inside a slot rather than a slot inside a table's structural rows. Expensive view computation runs in the app's normal JavaScript or compatible native resident. The client applies the resulting keyed changes.

Handlers take exactly one `UiEvent<Action>` and return `Unit` or `Result<Unit,String>`:

```ink
change save(event:UiEvent<Unit>)->Result<Unit,String>
  reads(Items,Next) writes(Items,Next) {
  let title=ui_field_text(event.input,"title");
  if(title==""){return Err("Enter a title");}
  let key=Next;
  if(Items.contains(key)){Items.replace(key,Item{id:key,title:title});}
  else{Items.insert(key,Item{id:key,title:title});}
  Next=Next+1;
  return Ok(());
}
```

`Activate` carries the declared action. `Input` and `Change` additionally carry text or a Bool. `Submit` carries all enabled controls in its form as `{name,text,checked}`. Control names must be unique inside that form. `ui_submit` creates a button using native form submission, including Enter in a field. `Err` from an Ink change aborts its tentative local changes and events. External effects that already completed retain their protocol outcomes; a later domain error does not imply remote rollback.

The release checker compares the complete view and event schemas, including action types. It requires readonly views and exported compatible handlers. An event handler can be a checked external-effect protocol with the same public result type. Its capabilities, deadlines and uncertainty rules still apply. Disposable previews cannot dispatch external effects.

## Dependency maintenance

The host derives state-root dependencies from checked compiler entries. An app state commit supplies a source-bound conservative invalidation hint. Only components intersecting those roots are reevaluated; other cached component results are reused. Unknown state replacement invalidates every component. Dependencies currently include both reads and writes, so refresh can be conservative.

The renderer compares stable IDs and emits mount, property/event update, child reorder and dispose operations. The whole transaction is validated before adapter callbacks run. A no-change refresh retains the revision and causes no widget updates. This is incremental at component and widget boundaries; computations inside a changed component and the composed-tree diff still run as a whole. It is not general incremental evaluation of every Ink expression.

## Storage-backed views

A named component can declare a fixed `ink-relational-v1` query. Scans use namespace `self`, which the host binds to this app. The view takes exactly one `UiData<Row>` argument:

```ink
record Row {title:String,note:Option<String>,}
fn results(data:UiData<Row>)->UiView<Unit> { /* construct nodes */ }
```

`UiData` contains `rows`, `total:Option<u64>` and `version:u64`. Nullable storage values become Ink options; the exact Ink codec validates the projected row type before execution. Select columns matching that record. Requests use the existing checked relational executor, maintained indexes, ordering, pagination and counts. Version 1 uses fixed manifest queries without cursors, up to the storage API's 500-row page limit and a 128 KiB encoded component input.

Identical requests across mounts share a bounded cache. A private table dependency token changes on row/schema updates, deletion, reclassification or storage reset. Unrelated World edits leave cached snapshots valid. Each snapshot retains its original version until one of its tables changes; there is no implied common snapshot across different queries. Changes arriving during a render cause a bounded retry before publication. Query work uses the shared CPU admission budget. Preview data inputs are empty and never read production tables.

## Local input and event outcomes

The DOM adapter keeps existing elements, focus, selection and unsent drafts. Number fields retain unfinished text rather than forcing numeric conversion on each keystroke. Selects preserve draft choices during option reordering. IME composition defers subtree moves on engines without state-preserving DOM moves. Applications perform their parsing and validation in Ink.

Each draft carries the canonical value token from the view where editing began. If the canonical value changes remotely, the draft stays visible and offers **Use updated value**. Submitting the old token is rejected before dispatch. Acknowledgements clear only the submitted draft generation; typing during an outstanding event survives its reply. Queued input can advance tokens through this client's own acknowledgements, never through an unrelated remote change.

The server resolves an event against the mounted node, declared event kind and opaque binding token. Clients cannot supply replacement Ink actions or handler names. Exact action values remain on the host, preserving wide integers. Disabled ancestors and form membership are checked on the host as well as in the adapter.

Events use a strictly ordered sequence per mount. The broker retains bounded receipts before dispatch. Checking an identical sequence returns its recorded outcome; changing its payload fails. A receipt that has expired is never treated as a new event. A lost transport reply leaves the client pending: **Check action** resends exactly that event. **Reload interface** observes current state without replaying it. Server restart, eviction or lease expiry loses ephemeral UI receipts; there is no claim of exactly-once external effects across those failures. Durable effect protocols and app journals retain their own guarantees. `unknown` explicitly means an action may have taken effect. Unstarted queued actions are discarded on unknown outcomes.

## Host and adapter contract

Installed routes are `POST /api/v1/apps/:app/ink/ui`, `POST .../:mount/refresh`, `POST .../:mount/event` and `DELETE .../:mount`. Browser SDK: `client.ink.ui`. Server SDK: `client.apps.ink.ui(appId)`. They require `code.execute`, the correct app/release identity, and `world.read` for storage-backed components. Scoped owner API keys need `apps:invoke`. Previews have matching `/ink/previews/:preview/ui` routes with preview-owner checks and a sandboxed MessagePort bridge. Typed previews allow form events inside their opaque-origin sandbox; child and parent CSP prohibit network form submissions.

Sessions expire after 15 minutes without refresh, are limited to 16 per actor and 64 per host, and close on explicit disposal. Visible clients refresh their lease every minute. Hidden clients suspend refresh and rebase when reopened. The host bounds trees to 5,000 widgets, 64 levels and 1 MiB; encoded retained views are bounded to 4 MiB per mount and 64 MiB per host. These are UI cache bounds, separate from the execution governor's worker reservations. Query snapshots and receipts have additional bounds. Maintenance stops admission and drains accepted tasks; shutdown removes subscriptions, timers and caches.

`@ink-os/platform/ui` exports `mountInkUi`, `createDomUi` and the portable `createUiModel`. The model requires an adapter to declare:

| Contract | Version 1 requirement |
| --- | --- |
| Layout | `flow-v1`: rows, columns, panels and semantic list/table/form/navigation structure |
| Input | `controls-v1`: activation, text editing, change, submit, focus and draft preservation |
| Accessibility | `semantic-v1`: labels, descriptions, invalid/disabled state, table headers, current navigation and keyboard activation |
| Lifecycle | `explicit-v1`: mount once per identity/kind, ordered child updates, postorder disposal; idempotent cleanup after adapter failure |

The DOM adapter implements these using native HTML controls. Desktop packages use that same adapter inside Electron. **A native widget adapter is not included.** Hosts currently advertise `target: "dom"` and reject requests for native widgets. Native Ink computation and native UI widgets remain separate features. A future native adapter must implement these contracts, declare supported kinds and pass equivalent behavior tests before advertising support. Layout version 1 deliberately has no arbitrary CSS or native platform handles in Ink values.

## Validation

```sh
npm run build
node --test tests/ink-ui*.test.mjs
INK_TEST_NATIVE=1 node --test tests/native-ui.test.mjs
INK_TEST_UI_BROWSER=1 INK_UI_BROWSER_EXECUTABLE=/path/to/chrome node --test tests/ui-browser.test.mjs
```

The native test uses actual compiled Rust and shared checkpoints. The optional browser test uses an existing Chrome/Chromium installation through `playwright-core`; it does not download a browser. It exercises Ink-authored forms, keyed lists, focus/caret retention, remote draft conflicts, option reordering, composition, lost event acknowledgements and balanced disposal. Legacy record views remain supported; existing apps opt into this contract explicitly.

Connected systems can bind a `UiData<Row>` component to a pinned exported readonly entry in another app, with exact checked types and shared snapshots. See [system planning](system-planning.md) for data ports, release fences and deployment.

Typed app interfaces can use [retained query and view delivery](retained-queries.md), including ordered cursors, bounded replay, snapshot resynchronization and exact source versions.
