# Published adapters

The core includes no adapters. Independently published packages use the existing source, immutable release, encrypted environment and execution infrastructure. An adapter has a backend and no desktop entry; its internal runtime registration is excluded from the installed app list.

Publish a committed workspace with `ink-os adapters publish DIRECTORY --env-file /private/path/to/adapter.env`. An `ink-adapter.json` manifest declares an `adapter` with `operation`, method `name`, `description`, `input` and `output`. A portable local host accepts local Git source projects; hosted repositories follow the host's ordinary source policy.

`input.fileTypes` accepts extensions, MIME types, MIME families and kinds. Optional `input.kind` and `input.shape` constrain structured records. Shapes list required fields with JSON type names; extra fields are allowed. All declared constraints must match. `output` declares a human `label`, exact `mime`, `extension` and optional JSON `shape`.

Right-click a source → Open with → **Text Editor · Transcript via transcribe**. The selected default method runs directly. Only compatible published, enabled, configured methods appear, paired with apps that declare support for their outputs. Methods group only when their purpose and complete input/output contracts agree.

File → Adapters enables/disables methods and changes defaults. The first activated method becomes the default; installing another does not replace it. Adapter defaults are independent of file app defaults. A new release or changed environment configuration requires enabling that version again.

## Provider backend protocol

A self-contained module exports `fetch(request, { ink, namespace })`:

- `GET /adapter/health` returns `{ "configured": true }` when ready.
- `POST /adapter/run` receives a stable `requestId`, a source object snapshot and a revision-checked content path. Return `{ "status": "completed", "output": { "text": "..." } }`, or output with canonical `base64` bytes. Long jobs return `{ "status": "pending", "jobId": "..." }`.
- `GET /adapter/runs/JOB_ID` returns the same result contract, or `{ "status": "failed" }`.

Persist provider job identities in the adapter namespace. A repeated request identity must not resubmit paid work. Interrupted submissions with an unknown provider identity require explicit retry. Local modules execute one request per process, and hosted workers can restart; do not depend on process memory.

The OS preserves the original and creates an independent linked result. Provenance records source revision, adapter release, method and configuration fingerprint. Subsequent opens reuse the result, including edits. Source/configuration changes produce a new result. Reverse transformations are explicit. Outputs are limited to 24 MiB and checked against declared JSON shapes. Editing text preserves its provenance.

## Local, native desktop and web

Browser and native desktop use the shared interface and API. Hosted execution uses the configured runtime provider. Portable local hosts run self-contained adapter modules without Docker in bounded Node processes with app-scoped credentials and only the package's environment. Read access is limited to module/SDK code; child processes and worker threads are unavailable. OS admin/provider credentials are not inherited. Network access supports hosted APIs. This permission boundary is not an OS container sandbox. General app backends retain their existing execution policy.

## Owner API and CLI

- `GET /api/v1/adapters` lists methods and defaults; `?source=OBJECT_ID` returns compatible configured defaults.
- `PUT /api/v1/adapters/ID/activation` accepts `enabled`.
- `PUT /api/v1/adapters/default` accepts `adapterId`.
- `POST /api/v1/adapters/run` accepts `sourceId` and `adapterId`, or a discovered group contract.
- `POST /api/v1/adapter-runs/ID/poll` resumes a durable job.

CLI commands: `adapters list`, `publish DIRECTORY`, `default ID`, `enable ID`, `disable ID`, `run SOURCE_ID --adapter ID`, and `poll RUN_ID`. Scoped keys require read, deployment or invocation access as appropriate. Content apps receive ordinary files and need no adapter-specific implementation.
