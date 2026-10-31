# Ink OS

Shared web desktop, application API, SDK, and CLI. A new instance contains zero apps.

Requires Node.js 24+ and Git.

```sh
npm ci
npm run build
npm start
```

The server listens on loopback port 4318. Its private `.data/client.json` contains the generated local account credential. Set `INK_OS_CONFIG=.data/client.json` when using `node cli/bin/ink-os.mjs`. Keep the entire data directory outside Git.

Administrators can create member identities with `POST /api/v1/accounts` (or `client.request('accounts', {method:'POST', body:input})` in the server SDK). Alongside `name` and `scopes`, an optional `id` preserves an existing 24-character lowercase hexadecimal account identity; collisions are rejected. Set `issueKey:false` to create the identity without any sign-in key, for example when preserving author references. Such an account cannot authenticate until a key is separately issued. Omitting this flag preserves the default creation of a sign-in key; member permissions cannot include `accounts:manage`.

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

JavaScript apps can also deploy from committed local Git without a repository URL. Build their frontend first, then run `ink-os deploy DIRECTORY`. An installed app with a source project updates that same project from the clean checkout, including apps whose older manifest still records a repository URL. `--project PROJECT_ID` selects an existing managed project for a new app; an installed app keeps its existing binding. A project snapshot uses the checkout's actual commit, and an explicit `--commit` must match it. Repository-based prebuilt deployments continue to accept their explicit source repository and revision.

`ink-os projects checkout PROJECT_ID --directory NEW_DIRECTORY` (also `projects export`) materializes exact managed source into a new private local Git checkout and writes a token-free `.git/ink-os-project.json` binding. Edit and commit normally, then use `ink-os deploy NEW_DIRECTORY --app APP_ID`. Existing directories are never overwritten and no remote HEAD/history is fabricated. A stale managed base conflicts; explicitly reconcile it or create another checkout. The server SDK also supports `projects.snapshot(id,input,{expectedCommit})` (or `input.expectedCommit`), using a full SHA or null for an unborn project; omitted CAS remains backward compatible.

Module backends keep the selected release's custom runtime image when their source manifest omits it. Set `--runtime-image REGISTRY/IMAGE@sha256:DIGEST` or `INK_OS_APP_RUNTIME_IMAGE` to choose a pinned runtime outside source control. `--runtime-image default` explicitly returns to the instance runtime. These options require a module backend entry.

An Ink manifest declares `language: "ink"`, a source file, `ui.entry`, and exported function/query/change names. A view returns records using `kind` values `column`, `row`, `panel`, `heading`, `text`, `value`, `button`, or `field`. Buttons name an exported `entry` and an `args` JSON array string. Fields have a `name`; argument templates can reference them with `{"$field":"name"}`. The generated interface uses the SDK styles. App code needs no JavaScript.

Exports also become commands such as `ink.add`, available through the command launcher, API, SDK and workflows. Command arguments use JSON **text**, preserving exact integers and structured values. For example:

```sh
node cli/bin/ink-os.mjs ink describe APP_ID
node cli/bin/ink-os.mjs ink run APP_ID add --input '[1]'
node cli/bin/ink-os.mjs apps duplicate APP_ID
```

The server SDK exposes `projects.import`, `projects.snapshot`, `projects.files`, `apps.build`, `apps.publish`, and `apps.ink.describe/run`. Browser clients use `client.ink.describe()` and `client.ink.run(entry, input)` with the app's `code.execute` capability. Apps call other apps through exported commands and `apps.invoke`.

Inspect an app's exported backend API before calling it:

```sh
ink-os apps api APP_ID
ink-os apps read APP_ID READ_NAME --body '{"id":"record-1"}'
ink-os apps send APP_ID MESSAGE_NAME --body '{"id":"record-1","text":"Hello"}'
ink-os call APP_ID /exported/path --method POST --body '{"text":"Hello"}'
ink-os apps open APP_ID --data '{"record":"record-1"}'
ink-os apps action REQUEST_ID
```

Named reads use exported GET routes and messages use exported POST routes. Route parameters come from the JSON object; remaining read fields become query parameters and remaining message fields become the body. `call` also requires an exported route and method; `invoke` retains its existing backend invocation behavior. The server verifies owner or app caller identity and an app caller still needs `apps.invoke`; the CLI cannot grant that permission. `apps open` requires a signed-in owner account and returns a queued handoff receipt, not proof that a window opened. Check `apps action` for the UI's acknowledged `opened` or `failed` result. `INK_OS_UI_CLIENT_ID` optionally selects a desktop client and `INK_OS_APP_ID` labels the source app. Credentials remain in `INK_OS_CONFIG` or explicit `INK_OS_TOKEN`, subject to the same origin and instance checks as other commands.

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

Account-key tools inside admitted work can pass `continuation: { url, token: computeLeaseToken }` to the server SDK's `createClient`. The CLI reads transient `INK_OS_CONTINUATION_URL` and `INK_OS_CONTINUATION_TOKEN`; it also applies them to binary uploads and downloads. The context supplements account authentication and preserves its permission limits. It is sent only to the exact configured origin, redirects are refused, and `login` never persists it. Invalid or expired contexts are refused, and guarded World writes retain the originating lease fence. Shutdown closes new admission and waits for admitted requests, jobs, writes and runtime holds before closing the host.

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

Embedding hosts can also use the local owner SDK's `SnapshotGate` and `createLiveBackup`. The gate must share the host's admission adapter and exclude other snapshots, upgrades and shutdown. It drains admitted work, verifies the runtime pool, and checkpoints collaborative state before reading the private tree. Direct local app requests join that admission and activity tracking. Acquisition timeouts and cancellation resume admission while preserving admitted work; an acquired snapshot remains held until its reader releases it. The pool can release verified idle workers before capture. Pass the same instance's `world` and `storage` with `remoteAssets: true` to include retained local/R2/S3 content and installed aliases. Bounded verified files stream into the encrypted archive with an authenticated asset manifest, without staging another full remote copy. Coverage flags distinguish included content from external projects and environment-provided secrets. Hosted HTTP/CLI snapshot jobs and changing storage/runtime providers during recovery remain unfinished.

Ink apps accept a single source or an explicit committed module graph. For example, `ink-app.json` can declare:

```json
{"slug":"linked-app","title":"Linked app","language":"ink","modules":{"version":1,"root":"main.ink","modules":[{"path":"main.ink","name":"app","dependencies":["lib/math.ink"],"exports":["run"]},{"path":"lib/math.ink","name":"math","dependencies":[],"exports":["bump"]}]},"exports":["run"]}
```

With `main.ink` containing `module app;fn run(n:u32)->u32{return bump(n);}` and `lib/math.ink` containing `module math;fn bump(n:u32)->u32{return n+1;}`, the same CLI build/deploy and exported command APIs work. The root can own state, queries and changes; graph version1 links pure libraries with explicit dependencies and exports. It rejects stateful libraries, record-update syntax and unsupported advanced metadata. There is no filesystem, URL or package discovery during compilation.

Releases, checkpoints and native artifacts bind the complete graph and checked core identity. Package root exports bound callable entries; app exports/view can narrow them further. A library-only source change invalidates the old source identity, even when its generated core is unchanged. Persistent checkpoints survive restarts and duplicate independently with the app. A changed source identity requires an explicit migration; execution rejects incompatible saved state instead of silently resetting it. The desktop configures a private pinned native installer; startup/status do not install tools, and an explicit native build bootstraps them on supported hosts. Packaged native acceptance remains a separate release gate.

Ink apps can bind checked stateless functions to fixed keys in their own persistent app data, without an authored JavaScript backend. For example, add this to `ink-app.json`:

```json
{"host":{"version":1,"bindings":[{"entry":"read_note","effect":"read","key":"note"},{"entry":"write_note","effect":"write","key":"note"}]},"exports":["read_note","write_note"]}
```

The corresponding Ink source can contain:

```ink
fn read_note(body:String)->String{return body;}
fn write_note(body:String,text:String)->String{if(text=="reset"){return "";}return text;}
```

Read bindings take no public arguments and receive the stored body as their checked `String` parameter. Write bindings take `[expectedRevision,text]`; the host injects the current body as the first source parameter, executes the pure transform through the selected JavaScript/native backend, then commits its resulting `String` with one record CAS. Read responses expose `hostRecord.revision`; use zero to create the initially absent record. Bodies and input text are bounded to 64 KiB. Bindings require the app's existing `world.read` capability, plus `world.write` for writes, retain the selected-release write fence, and cannot choose another namespace or overwrite document-bound records. Commands derive their actual read/write effects from the validated binding. Writes are non-idempotent: after a lost reply, read the current row and explicitly reconcile its revision rather than automatically replaying a write. They do not also mutate Ink state, files, workflow stores or arbitrary World objects. No cross-store atomic transaction is claimed.

A read binding may supply the Ink view from the stored body. Generated views may put `{"$revision":"write_note"}` into a button's JSON argument array to use the last read revision of that same fixed key, alongside existing `{"$field":"name"}` tokens. The binding contract and its parameter/result descriptors are checked when building and reading the release. Host-bound releases use Ink contract version 2; older releases retain version 1. This data binding does not provide filesystem, network, process, credential or arbitrary FFI access.

`ink-os ink preview DIRECTORY --entry ENTRY --input '[]'` captures clean committed source and creates a genuinely executable, unpublished preview. `ink preview-run PREVIEW_ID ENTRY --input JSON`, `ink preview-status PREVIEW_ID`, and `ink preview-close PREVIEW_ID` operate on it. No app/project registration, release publication, production checkpoint, runtime provider or toolchain installation occurs. The returned URL renders the generated UI in an opaque sandbox with a dedicated preview-only MessagePort bridge. Browser sign-in is required to open that URL; API credentials are never put in it.

Owner API routes are `POST /api/v1/ink/previews`, `GET|DELETE /api/v1/ink/previews/:id`, `POST /api/v1/ink/previews/:id/run`, and `GET /api/v1/ink/previews/:id/view`; the server SDK exposes `client.ink.previews.create/get/run/remove`. Creation accepts exact `files` plus optional verified `tree`/`originCommit`, or an existing `projectId` and full `commit`. Previews start with empty private Ink state and host data, run through the ordinary bounded JavaScript worker, serialize their own changes, expire after ten minutes, and disappear on host restart. Explicit native preview execution is rejected; native installation/execution belongs to installed apps. Existing installed state remains unchanged, and the normal selected-release guard remains in force. Preview access uses existing owner and `apps:deploy`/`computer` permissions and is bound to the creating account.

Development: `npm run dev`. Validation: `npm test`, `npm run check`, `npm run audit`.

Administrators can import selected namespaces from a complete immutable OS Version export while the destination apps are registered and unpublished:

```sh
ink-os migrations namespaces plan --file import.json --output plan.json
ink-os migrations namespaces apply --file import.json --plan plan.json
```

The input contains a stable 32-hex `operation`, full `sourceVersion`, `sourceVersionCut` (`id`, original `manifestDigest`, `worldVersion`, `core`, `capturedAt`), and explicit `namespaces`, `recordIds`, `documentIds` and `bootstrapDocumentIds`. The original manifest digest hashes `JSON.stringify(sourceVersion)` in its exported key order. The inspected plan binds destination revisions and scope; changes require a new plan. Only explicitly listed bootstrap documents can be replaced. Import preserves text/state checkpoint bytes, tombstones and file IDs, maps file revisions to the destination, and records a durable decision for restart recovery. App registrations, releases, credentials, workflows and schedules use separate services. Transfer content-addressed assets first; top-level `locationRemap` entries must preserve the digest and pass destination readback. Existing operation receipts replay without overwriting later target edits. Use `migrations namespaces status OPERATION` to read the durable receipt. Server SDK callers use `migrations.namespaces.plan/apply/get`; these endpoints require administrator authority.

Draft seeds may reference explicitly selected desktop files or notes from another selected namespace. Optional `referenceNamespaces` permits only seed records required by selected drafts from namespaces without an app registration; it cannot import documents, protected app-source files or unrelated records from those namespaces. Archived seed records and draft checkpoints are retained; drafts stay inaccessible until the seed is restored.

For saved references that must retain their original storage strings, administrators can call `migrations.storage.installAliases({operation,inputDigest,aliases})` or `ink-os migrations storage-aliases apply --file aliases.json`. Aliases map exact content-addressed locations to the currently configured local/R2/S3 store with the same digest. Installation checks complete destination bytes; reads verify integrity and never contact the old store. The private alias journal is included in local backups; retained aliases pin their blobs against garbage collection. Transfer remote bytes separately before installing aliases.

Authoritative workflows and schedules can be imported with `migrations automation plan/apply/status`, using the same explicit `--file`, `--output` and inspected `--plan` flow as namespaces. The source envelope contains only the exact two hashed store files and records that they were captured individually. Credentials and platform settings are rejected. Imported unfinished runs remain interrupted; schedules remain disabled and authority binds to the authenticated target administrator. Historical workflows require a fresh preview/new run. Imported schedules require `migrations automation preview-schedule`, then `review-schedule --approve` against a future time and current backend; review keeps them disabled until an explicit normal enable/run. Server SDK methods are under `migrations.automation`.

Hosted upgrades use the administrator-only maintenance API through the deployment CLI. The gate closes external admission, lets admitted work finish, checkpoints data, and holds idle runtime admission. A durable stop authorization binds the source boot and image pair before the deployment client stops the host. Cancellation is allowed before that seal; target-image startup retains the gate until verified completion. The local CLI exposes `maintenance prepare/status/seal/complete/cancel` and the server SDK exposes `maintenance`. Image provenance must come from `INK_OS_IMAGE_PIN` and `INK_OS_RUNTIME_IMAGE`; arbitrary caller image claims are rejected. Unsupported or unmanaged runtimes block automatic quiescence.
