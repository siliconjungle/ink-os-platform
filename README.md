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

Current Ink app builds accept one source file. Persistent checkpoints survive restarts and duplicate independently with the app. A changed source identity requires an explicit migration; execution rejects incompatible saved state instead of silently resetting it. Module linking, migration tooling, host I/O bindings and the native app execution service are still being integrated.

Development: `npm run dev`. Validation: `npm test`, `npm run check`, `npm run audit`.
