import test from 'node:test';
import assert from 'node:assert/strict';
import { systemFixture } from './ink-system-fixture.mjs';
import { retainedHistory } from './ink-retained-fixture.mjs';
test(
  'retained query delivery and duplicate recovery agree through actual JS and native computation',
  { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 },
  async (t) => {
    const js = await retainedHistory(
      await systemFixture(t, { collaborative: true }),
    );
    const native = await retainedHistory(
      await systemFixture(t, { collaborative: true, native: true }),
    );
    assert.deepEqual(native, js);
  },
);
