import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildInkApp, validateInkBundle, inkExecutionSource } from '../server/ink-apps.mjs';
import { Code } from '../server/code.mjs';
import { validateBundle } from '../server/platform.mjs';

test('configured build uses the real offline planner and bundles a replayable selection receipt', { skip: process.env.INK_TEST_PLANNER !== '1', timeout: 60000 }, async () => {
  const source = await readFile(new URL('./fixtures/planned-counter.ink', import.meta.url), 'utf8');
  const bundle = await buildInkApp({ language: 'ink', slug: 'searched-counter', exports: ['amount'], optimisation: { version: 1, mode: 'search', budget: 1, timeSeconds: 8 } }, [{ path: 'main.ink', base64: Buffer.from(source).toString('base64') }]);
  const saved = JSON.parse(Buffer.from(bundle.files.find(file => file.path === bundle.ink.implementation.path).base64, 'base64'));
  assert.equal(saved.selection.mode, 'search');
  assert.equal(saved.selection.receipt.status, 'checked');
  assert.equal(saved.selection.receipt.source, saved.checked.input);
  assert.equal(saved.selection.receipt.selected, saved.checked.plan);
  assert.equal(saved.selection.receipt.planning_budgets.budget, 1);
  await validateInkBundle(validateBundle(bundle));
  const sourceWithPlan = await inkExecutionSource(bundle.ink, bundle.files);
  const result = await new Code('.').run({ source: sourceWithPlan, entry: 'amount', input: '[18446744073709551615]', backend: 'javascript' });
  assert.equal(result.wire, '18446744073709551615');
  const changed = structuredClone(bundle), file = changed.files.find(file => file.path === bundle.ink.implementation.path);
  saved.selection.receipt.source = '0'.repeat(64); file.base64 = Buffer.from(JSON.stringify(saved)).toString('base64');
  await assert.rejects(validateInkBundle(validateBundle(changed)), /planning receipt/);
});
