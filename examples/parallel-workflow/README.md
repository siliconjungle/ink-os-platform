# Parallel Ink workflow

Build and publish this Ink application normally. Replace the placeholder app ID
(`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`) in `workflow.json` with its installed ID,
then create, preview and run the workflow through the CLI or SDK.

`left` and `right` can execute concurrently in independent resident workers.
`join` waits for both exact JSON results. `publish` then commits the result, and
`read` observes it afterward. The final value is 36. No JavaScript application
backend is needed. State changes retain their normal versions, events and journal.

```js
const definition = JSON.parse(await readFile('workflow.json', 'utf8'));
const workflow = await client.workflows.save(definition);
const preview = await client.workflows.preview(workflow.id);
const run = await client.workflows.run(workflow.id, {}, {
  fingerprint: preview.fingerprint,
  approved: true
});
```

See [safe scheduling](../../docs/safe-scheduling.md) for dependency admission,
snapshot batches, resource limits, failure and cancellation semantics.
