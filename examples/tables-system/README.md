# Tables and a connected dashboard

Both apps are authored in Ink. Tables owns typed rows, guarded writes, events and filtered sum/count keeps. Its UI and the dashboard use the same paginated exported query. The selected plan contains replayable maintained-fold proofs for `OpenTotal` and `OpenCount`.

From the platform repository:

```sh
node cli/bin/ink-os.mjs ink system-build examples/tables-system
```

Copy this directory into a new Git repository, add and commit its files, then deploy that clean root against your instance:

```sh
ink-os ink system-deploy APP_DIRECTORY
```

The command installs the exact graph in provider-first order and records resumable publication progress. Repeating it returns the same apps. It does not silently upgrade an existing different system or migrate state. `system-build` reuses unchanged checked units from `.ink/system-cache`; output is `.ink/system.json`.

Use the returned Tables app ID with its exported typed operations:

```sh
ink-os ink run TABLES_ID put --input '[0,{"id":1,"title":"First","amount":7,"open":true}]'
ink-os ink run TABLES_ID dashboard --input '[0,20]'
```

The first argument to `put`/`remove` is the expected logical version. A stale version conflicts; `abort_edit` returns an error after tentative writes and rolls them back. Supply a stable `--request-id` when checking a lost write reply. The interactive form also adds rows without application JavaScript.

Validation and measurement:

```sh
node --test tests/ink-system.test.mjs
INK_TEST_NATIVE=1 node --test tests/native-system.test.mjs
INK_UI_BROWSER_EXECUTABLE=/path/to/chrome node scripts/benchmark-ink-system.mjs
```

To regenerate the proof, explicitly configure `INK_COMPILER` and `PYTHONPATH` for the pinned Ink CLI and planner/knowledge source packages, then run `node scripts/author-tables-system-plan.mjs`. It authors ordinary fold proofs, shares duplicate self-contained certificates, and checks the complete resulting packet. No planner, catalogue download or Rust installation runs during an ordinary application request.

[Contracts, limits and remaining boundaries](../../docs/system-planning.md) · [Measured run](../../docs/benchmarks/tables-system-2026-11-04.json)
