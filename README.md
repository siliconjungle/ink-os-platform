# Ink OS

Shared web desktop, application API, SDK, and CLI. A new instance contains zero apps.

Requires Node.js 24+ and Git.

```sh
npm ci
npm run build
npm start
```

The server listens on loopback port 4318. Its private `.data/client.json` contains the generated local account credential. Set `INK_OS_CONFIG=.data/client.json` when using `node cli/bin/ink-os.mjs`. Keep the entire data directory outside Git.

```sh
INK_OS_CONFIG=.data/client.json node cli/bin/ink-os.mjs projects create --title "My project"
INK_OS_CONFIG=.data/client.json node cli/bin/ink-os.mjs projects list
```

Source projects, execution providers, and persistent storage are independent. Local source repositories can have optional remotes; GitHub settings belong to each project. Hosted services receive release bundles rather than laptop filesystem paths.

For GitHub publishing, configure a project using a JSON file:

```json
{"source":{"provider":"github","github":{"owner":"YOUR-OWNER","repository":"YOUR-REPOSITORY","visibility":"private"}},"branch":"main"}
```

```sh
node cli/bin/ink-os.mjs projects configure PROJECT_ID --file settings.json
node cli/bin/ink-os.mjs projects credentials PROJECT_ID --from-env GITHUB_TOKEN
node cli/bin/ink-os.mjs projects publish PROJECT_ID --create
node cli/bin/ink-os.mjs projects publication PROJECT_ID
```

`--stdin` also accepts a piped token. Tokens are encrypted using the private instance key, bound to the project/repository, and never returned by the API. Keep the instance identity with its private data when backing up. A GitHub token needs repository contents write access; creating repositories also needs the corresponding account/organization permission. Existing repositories must match the configured visibility. Publication never changes visibility.

Publishing sends a validated committed snapshot with generic author metadata, creating its own remote history. Receipts identify both the local source commit and the remote commit; unrelated local history is not uploaded. Remote edits cause a conflict. Inspect and reconcile them into your committed local source, then use `projects publish PROJECT_ID --expected-remote FULL_SHA` to acknowledge that exact remote base. The new snapshot becomes its child, preserving the remote history; another concurrent edit still prevents the push. Use `projects source-plan PROJECT_ID` to inspect remote changes without downloading source into API output, and `projects pull PROJECT_ID --expected-remote FULL_SHA` to import a verified remote snapshot into a clean managed project. Pull refuses tracked, untracked or ignored local changes, local commits beyond the recorded baseline, and diverged remote history; reconcile those cases with Git first. `projects read-remote PROJECT_ID` returns the verified snapshot when an agent needs its source bytes. A retry reconciles a push whose response was lost. Local source remains usable independently. `projects duplicate` defaults to local Git; `--file` can specify another GitHub destination, whose credentials must be set separately.

Owner clients can use `projects.credentials.status/set/remove`, `projects.publish`, `projects.publication`, `projects.readRemote`, `projects.sourcePlan`, and `projects.pull` in the server SDK. The matching `/api/v1/projects/:id` endpoints are `credentials` (GET/PUT/DELETE), `publish` (POST), `publication` (GET), `read-remote`/`source-plan` (GET), and `pull` (POST). Credential management requires the `apps:credentials` key scope; publishing requires `apps:deploy`.

Create and install an Ink app on your running instance:

```sh
export INK_OS_CONFIG=.data/client.json
node cli/bin/ink-os.mjs init ./my-app --slug my-app
node cli/bin/ink-os.mjs build ./my-app
node cli/bin/ink-os.mjs deploy ./my-app
```

`init` creates a local Git repository with `main.ink` and `ink-app.json`. No GitHub account is required. Edit the source and commit changes before deploying again. Deployment imports the committed tree into the instance, checks its Git tree identity, builds a release, and publishes it. The starter is created only by `init`; startup still installs zero apps.

An Ink manifest declares `language: "ink"`, a source file, `ui.entry`, and exported function/query/change names. A view returns records using `kind` values `column`, `row`, `panel`, `heading`, `text`, `value`, `button`, or `field`. Buttons name an exported `entry` and an `args` JSON array string. Fields have a `name`; argument templates can reference them with `{"$field":"name"}`. The generated interface uses the SDK styles. App code needs no JavaScript.

Exports also become commands such as `ink.add`, available through the command launcher, API, SDK and workflows. Command arguments use JSON **text**, preserving exact integers and structured values. For example:

```sh
node cli/bin/ink-os.mjs ink describe APP_ID
node cli/bin/ink-os.mjs ink run APP_ID add --input '[1]'
node cli/bin/ink-os.mjs apps duplicate APP_ID
```

The server SDK exposes `projects.import`, `projects.snapshot`, `projects.files`, `apps.build`, `apps.publish`, and `apps.ink.describe/run`. Browser clients use `client.ink.describe()` and `client.ink.run(entry, input)` with the app's `code.execute` capability. Apps call other apps through exported commands and `apps.invoke`.

Native builds use a host Rust toolchain and a committed dependency lock. Build once, then choose a backend:

```sh
node cli/bin/ink-os.mjs native status
node cli/bin/ink-os.mjs native build APP_ID --wait
node cli/bin/ink-os.mjs ink run APP_ID total --backend native
node cli/bin/ink-os.mjs ink run APP_ID total --backend javascript
```

The default `auto` backend uses a ready native artifact for the exact app/source/compiler/runtime/host combination, otherwise JavaScript. Both backends share checkpoints and exact JSON values, including float-bit wrappers and full-width integers. Cached native artifacts run without the Rust toolchain; `native status` distinguishes build availability from ready artifacts. Set `INK_OS_NATIVE=0` to disable native execution, or `INK_NATIVE_CARGO` and `INK_NATIVE_RUSTC` to select a host toolchain.

Native build jobs persist privately and drain during a normal host shutdown. `native jobs APP_ID` and `native get APP_ID JOB_ID` inspect them. A CLI `--timeout` ends observation without cancelling a build. The SDK exposes `native.status()` and `apps.native.build/jobs/get`; browser clients use `client.ink.native`. A build whose host crashed checks its recorded host, execution root and process start identity before waiting for the worker. Unrelated or relocated process identities do not block recovery; ambiguous workers remain preserved.

Module and OCI backends can run through Docker Engine. The deployment repository's Compose setup builds the module runtime image and connects it automatically. A standalone host enables `INK_OS_BACKENDS=docker`, preloads `ink-os-runtime:local`, and sets `INK_OS_DOCKER_OS_URL` to its API address reachable from containers. `INK_OS_DOCKER_SOCKET`, `INK_OS_DOCKER_NETWORK`, and `INK_OS_DOCKER_CONNECTION=host|network` select the local engine and connection. Custom OCI images must already be loaded in that engine.

App containers receive their own lease credentials and app environment, bounded CPU/memory/process counts, a read-only root and a private temporary filesystem. They receive no host Docker socket or host service credentials. Live workers survive OS-host restart; SDK `compute.hold()` protects background work from idle reuse. Idle slots stop gracefully and a new assignment gets a new container, environment and credentials. Capacity defaults to eight containers with a two-minute idle interval; `INK_OS_DOCKER_MACHINES` and `INK_OS_DOCKER_IDLE_MS` configure these limits. Owner clients inspect/reap slots through `ink-os runtimes list|reap`, `client.runtimes.list/reap()`, or `/api/v1/runtimes`.

An owner can migrate an existing checkpoint after selecting a new release. The old release exports a read-only query for the data to preserve; the new release exports a single-argument state change that initializes the new state from that value. Inspect revisions with `ink checkpoint APP_ID`, then call `ink migrate APP_ID --file migration.json`:

```json
{"fromReleaseId":"OLD_RELEASE_ID","toReleaseId":"NEW_RELEASE_ID","query":"export_state","change":"import_state","expectedAppRevision":12,"expectedCheckpointRevision":3}
```

Use the exact current revisions returned by checkpoint inspection. Migration validates both releases and argument types, preserves full-width values, and rejects concurrent changes without replacing the existing checkpoint. The server SDK exposes `apps.ink.checkpoint/migrate`; owner routes are `GET /api/v1/apps/:id/ink/checkpoint` and `POST /api/v1/apps/:id/ink/migrate`.

For local private-data recovery, stop the host and all writers to its data directory before creating a backup. Supply the encryption password through stdin or an explicitly named environment variable; keep the archive outside the source directory:

```sh
node cli/bin/ink-os.mjs backup create --offline --directory /path/to/data --output /path/to/instance.inkbak --password-stdin
node cli/bin/ink-os.mjs backup restore --offline --directory /path/to/restored-data --input /path/to/instance.inkbak --password-stdin
```

Restore requires an absent or empty destination and authenticates the complete archive before publishing it. It preserves instance keys and local blob bytes, rebases managed project paths, and renews connection metadata on startup. External project directories, environment-provided secrets and remote object storage require separate recovery; inspect the returned coverage. The local owner SDK exports `createStoppedBackup` and `recoverBackup` from `@ink-os/platform/backup`. This interface does not establish a live snapshot barrier.

Ink apps accept a single source or an explicit committed module graph. For example, `ink-app.json` can declare:

```json
{"slug":"linked-app","title":"Linked app","language":"ink","modules":{"version":1,"root":"main.ink","modules":[{"path":"main.ink","name":"app","dependencies":["lib/math.ink"],"exports":["run"]},{"path":"lib/math.ink","name":"math","dependencies":[],"exports":["bump"]}]},"exports":["run"]}
```

With `main.ink` containing `module app;fn run(n:u32)->u32{return bump(n);}` and `lib/math.ink` containing `module math;fn bump(n:u32)->u32{return n+1;}`, the same CLI build/deploy and exported command APIs work. The root can own state, queries and changes; graph version1 links pure libraries with explicit dependencies and exports. It rejects stateful libraries, record-update syntax and unsupported advanced metadata. There is no filesystem, URL or package discovery during compilation.

Releases, checkpoints and native artifacts bind the complete graph and checked core identity. Package root exports bound callable entries; app exports/view can narrow them further. A library-only source change invalidates the old source identity, even when its generated core is unchanged. Persistent checkpoints survive restarts and duplicate independently with the app. A changed source identity requires an explicit migration; execution rejects incompatible saved state instead of silently resetting it. Host I/O bindings remain unfinished. The desktop configures a private pinned native installer; startup/status do not install tools, and an explicit native build bootstraps them on supported hosts. Real installer and packaged acceptance remain release gates.

Development: `npm run dev`. Validation: `npm test`, `npm run check`, `npm run audit`.

Administrators can import selected namespaces from a complete immutable OS Version export while the destination apps are registered and unpublished:

```sh
ink-os migrations namespaces plan --file import.json --output plan.json
ink-os migrations namespaces apply --file import.json --plan plan.json
```

The input contains a stable 32-hex `operation`, full `sourceVersion`, `sourceVersionCut` (`id`, original `manifestDigest`, `worldVersion`, `core`, `capturedAt`), and explicit `namespaces`, `recordIds`, `documentIds` and `bootstrapDocumentIds`. The original manifest digest hashes `JSON.stringify(sourceVersion)` in its exported key order. The inspected plan binds destination revisions and scope; changes require a new plan. Only explicitly listed bootstrap documents can be replaced. Import preserves text/state checkpoint bytes, tombstones and file IDs, maps file revisions to the destination, and records a durable decision for restart recovery. App registrations, releases, credentials, workflows and schedules use separate services. Transfer content-addressed assets first; top-level `locationRemap` entries must preserve the digest and pass destination readback. Existing operation receipts replay without overwriting later target edits. Use `migrations namespaces status OPERATION` to read the durable receipt. Server SDK callers use `migrations.namespaces.plan/apply/get`; these endpoints require administrator authority.

For saved references that must retain their original storage strings, administrators can call `migrations.storage.installAliases({operation,inputDigest,aliases})` or `ink-os migrations storage-aliases apply --file aliases.json`. Aliases map exact content-addressed locations to the currently configured local/R2/S3 store with the same digest. Installation checks complete destination bytes; reads verify integrity and never contact the old store. The private alias journal is included in local backups; retained aliases pin their blobs against garbage collection. Transfer remote bytes separately before installing aliases.
