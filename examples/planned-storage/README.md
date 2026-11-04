# Planned World Tables in an Ink UI

This app defines its view and event contract in Ink. Its manifest declares a typed query over World Tables: filter open rows, order by score, project just stable ID/title, and request twenty rows plus count. A bounded build compares scan, index and maintained-result recipes using the committed synthetic workload. It retains the chosen result through the existing UI query cache.

From the platform repository:

```sh
node cli/bin/ink-os.mjs build examples/planned-storage
node --test tests/data-path-planning.test.mjs
node scripts/benchmark-data-paths.mjs
INK_UI_BROWSER_EXECUTABLE=/path/to/chrome node scripts/verify-data-path-ui.mjs
INK_UI_BROWSER_EXECUTABLE=/path/to/chrome node scripts/verify-data-path-ui.mjs --native
```

The workload is **measurement input**, not installation data. The integration test installs the release, creates its authoritative World table and rows under the app namespace, mounts two views and verifies shared planned execution and invalidation after a durable change. In a deployed app, provision the table and rows using the normal authorized World/Tables API. The fixed table ID is `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`.

Build output contains the private `server/data-paths.json` packet. Set `storagePlanning.mode` to `baseline` for explicit scanning, or copy the packet into the source and use `{"version":1,"mode":"replay","plan":"data-paths.json"}` to replay it. A different target or out-of-envelope row count uses scanning, with an explanation, until a new measured release is built.

This example uses the trusted World Tables relational interpreter. It does not claim a kernel proof replacing Ink state storage, and it does not migrate the Ink state in the separate Tables/dashboard system. [Contract, evidence and remaining boundaries](../../docs/data-path-planning.md).
