# Learned parameters and gated edits

Ink apps can leave parts of their logic to be learned with `learn` holes (see
ink-lang `docs/learnable-holes.md`). An installed app's learned parameters are
ordinary Ink state behind its generated `__learn_get` query and `__learn_set`
learn change. Ink OS exposes them as rows, keeps a copy in World, and applies
edits only when they measurably help.

## Rows

```js
const state = await client.apps.ink.learned.get(appId);
// state.rows: [{hole: 'recover', key: ['State.Quoted', 'Class.Quote'], value: 'Step.End'}, ...]
```

The response contains:

- `rows`: each `choice` entry keyed by its argument values, and each `mlp`
  weight by its index.
- `holes` and `objectives`: the layout from the checked module.
- `gate`: the objective and a hash of the gate data, or `null`.
- `history`: the most recent admitted edits with their receipts.

The rows are mirrored into a World object (`ink-learned-rows` tag) in the app's
namespace, so they have revision history and appear in search.

## The gate

The owner chooses the objective and the held-out data that judge edits:

```js
await client.apps.ink.learned.gate(appId, {objective: 'mistakes', data: [cases]});
```

`data` is the JSON array of the objective's arguments. It is stored as a World
object (`ink-learned-gate`). Whoever proposes edits should not have seen it.

## Edits

```js
const receipt = await client.apps.ink.learned.edit(appId, {
  edit: {format: 'ink-learn-edit-v1', author: 'agent', reason: '...', rows: [...]},
  allowEqual: false,
});
```

For each edit, the service:

1. Checks every row against the hole layout.
2. On a scratch state of the same release
   (`ink-app:learned-scratch`), evaluates the objective with the current
   parameters, then with the edited ones. Objectives read only parameters and
   their arguments, so these are the exact values the live app would give.
3. Admits the edit only if the objective strictly improves, or, with
   `allowEqual`, does not get worse. An edit that changes nothing is rejected.
4. Applies an admitted edit to the live state as one learn commit, if the
   parameters did not change meanwhile; otherwise it returns 409.
5. Records an `ink-learned-edit` World object with the edit and its receipt.

A rejected edit never touches the live state. Edits to one app are serialised.
Learn holes on an error path cannot change any input the authored code
handles, so such edits are judged only on what they can affect.

The receipt (`ink-os-learned-gate-v1`) binds:

- the release;
- the objective and the gate data hash;
- the edit hash, its author and reason;
- the rule;
- the before and after values and the number of changed parameters.

## Access

All three routes are owner-only (`/api/v1/apps/:appId/ink/learned`,
`.../learned/gate`, `.../learned/edits`).

The generated `__learn_*` and `__objective_*` entries cannot be run as app
commands. Only this service can reach them, through `code.run({learned: true})`.

Gating compares measured objective values; it grants no other authority.

## Requirements

Apps need a compiler that understands `learn` holes. That is the bundled
compiler pinned to the Ink core package `71ca0330` or later. A module without
holes returns 409.

## Validation

`tests/ink-learned.test.mjs`:

- deploys an app with a learn hole;
- checks that generated entries are not commands;
- sets a gate;
- rejects a worse edit and leaves the live app unchanged;
- admits an improving edit and applies it live;
- shows that authored paths are untouched and that a no-effect edit is
  rejected;
- confirms the World records exist and the parameters survive a restart.
