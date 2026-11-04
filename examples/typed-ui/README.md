# Ink items

An Ink-authored form, keyed list, table and navigation. There is no app JavaScript. `ui.ink` is the committed SDK UI library; `ink-app.json` binds its explicit module closure and typed component handlers.

```sh
node cli/bin/ink-os.mjs build examples/typed-ui
```

To deploy it, copy this directory to a new app directory, initialize Git, add and commit its source, then run `ink-os deploy APP_DIRECTORY` against your instance. The app uses persistent Ink state. Add items with the form, remove them with list buttons or table row activation, and switch between the two presentations. Stable IDs retain controls during updates. List/table components depend on `Rows`; navigation depends on `Page`; the editor is pure and remains mounted across navigation.

See [the interface contract](../../docs/typed-ui.md) for storage-backed components, typed external-effect handlers, session outcomes and native adapter requirements.
