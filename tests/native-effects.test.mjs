import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NativeInk } from '../server/native-ink.mjs';
import { NativeJobs } from '../server/native-jobs.mjs';
import { inkExecutionSource, runInstalledInk } from '../server/ink-apps.mjs';
import {
  fixture,
  install,
  call,
  owner,
  some,
  none,
} from './ink-effects-fixture.mjs';
test(
  'real native and JavaScript effect protocols share typed durable virtual file versions',
  { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 },
  async (t) => {
    const { platform: p, directory } = await fixture(t),
      { app, release, bundle } = await install(p, 'file', {
        deadlineMs: 30000,
      });
    const jobs = await new NativeJobs(directory, {
      native: new NativeInk(join(directory, 'native'), {
        offline: process.env.INK_NATIVE_OFFLINE === '1',
      }),
      source: () => inkExecutionSource(bundle.ink, bundle.files),
    }).open();
    p.code.nativeJobs = jobs;
    t.after(() => jobs.close());
    const job = await jobs.enqueue(app.id, release.id);
    await jobs.pump();
    assert.equal(
      jobs.get(app.id, job.id).status,
      'succeeded',
      JSON.stringify(jobs.get(app.id, job.id)),
    );
    const req = {
        action: 'write',
        name: 'test',
        value: none(),
        bytes: some([0, 255, 4]),
        expected: some(0),
      },
      js = await call(p, app, req);
    assert.equal(js.status, 'done', JSON.stringify(js));
    const native = await runInstalledInk(
      p,
      app.id,
      {
        entry: 'begin',
        input: JSON.stringify([
          { ...req, action: 'read', bytes: none(), expected: none() },
        ]),
        backend: 'native',
      },
      owner,
    );
    assert.equal(native.backend, 'native');
    assert.equal(native.valueWire, js.valueWire);
    const wrote = await call(
      p,
      app,
      { ...req, expected: some(1), value: some('native'), bytes: none() },
      { backend: 'native' },
    );
    assert.equal(wrote.status, 'done', JSON.stringify(wrote));
    assert.equal(wrote.value.file.Some.version, 2);
  },
);
