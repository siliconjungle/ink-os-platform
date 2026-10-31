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

Development: `npm run dev`. Validation: `npm test`, `npm run check`, `npm run audit`.
