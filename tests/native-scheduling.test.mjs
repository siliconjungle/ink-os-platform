import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NativeInk } from '../server/native-ink.mjs';
import { NativeJobs } from '../server/native-jobs.mjs';
import { Workflows } from '../server/workflows.mjs';
import {
  buildInkApp,
  inkExecutionSource,
  runInstalledInk,
} from '../server/ink-apps.mjs';
import { fixture, file, owner, until } from './ink-effects-fixture.mjs';

test(
  'native concurrent pure calls retain exact ordered parallel_map values and workflow writes retain commit versions/events',
  { skip: process.env.INK_TEST_NATIVE !== '1', timeout: 300000 },
  async (t) => {
    const { platform: p, directory } = await fixture(t),
      source =
        'module native_scheduler;state Count:u64=0;event seen:u64;fn mapped(xs:List<u32>)->List<u32>{return parallel_map(xs,1,fn(i)=>fn(x)=>x+i);}fn twice(n:u64)->u64{return n*2;}change add(n:u64)->u64 reads(Count) writes(Count) emits(seen){Count=Count+n;emit seen(Count);return Count;}query total()->u64 reads(Count){return Count;}',
      bundle = await buildInkApp(
        { slug: 'native-scheduler', language: 'ink' },
        [file('main.ink', source)],
      ),
      app = await p.createApp({
        slug: 'native-scheduler',
        capabilities: bundle.capabilities,
      }),
      release = await p.createRelease(app.id, bundle);
    await p.publish(app.id, release.id);
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
    const input = Array.from({ length: 32 }, (_, i) => i),
      values = await Promise.all(
        [1, 2].map(() =>
          runInstalledInk(
            p,
            app.id,
            {
              entry: 'mapped',
              input: JSON.stringify([input]),
              backend: 'native',
            },
            owner,
            undefined,
            { parallelPure: true },
          ),
        ),
      );
    assert.deepEqual(
      values[0].value,
      input.map((x) => x * 2),
    );
    assert.equal(values[1].valueWire, values[0].valueWire);
    assert.equal(values[0].backend, 'native');
    const w = (p.workflows = await new Workflows({
      directory,
      platform: p,
    }).open());
    t.after(async () => {
      w.close();
      await until(() => w.active.size === 0 && !w.pumping);
    });
    const literal = (value) => ({ source: 'literal', value }),
      step = (id, commandId, bindings) => ({
        id,
        appId: app.id,
        commandId,
        bindings,
      }),
      definition = await w.save(owner, {
        definition: {
          title: 'Native schedule',
          scheduling: { version: 1, mode: 'parallel', maxConcurrent: 4 },
          steps: [
            step('a', 'ink.twice', { arg0: literal('4') }),
            step('b', 'ink.twice', { arg0: literal('5') }),
            step('write-one', 'ink.add', { arg0: literal('1') }),
            step('write-two', 'ink.add', { arg0: literal('2') }),
            step('read', 'ink.total', {}),
          ],
        },
      }),
      preview = w.preview(owner, { id: definition.id }),
      run = await w.run(owner, {
        id: definition.id,
        fingerprint: preview.fingerprint,
        approved: true,
        requestId: crypto.randomUUID(),
      });
    await until(
      () =>
        !w.active.has(run.id) &&
        w.runs.find((r) => r.id === run.id)?.finishedAt,
      10000,
    );
    const done = w.runs.find((r) => r.id === run.id);
    assert.equal(done.status, 'succeeded', done.error);
    assert.ok(done.steps.every((step) => step.output.backend === 'native'));
    const writes = done.steps.slice(2, 4).map((step) => step.output.output);
    assert.deepEqual(
      writes.map((value) => value.version),
      [1, 2],
    );
    assert.deepEqual(
      writes.map((value) => value.events[0].value),
      [1, 3],
    );
    assert.deepEqual(
      writes.map((value) => value.events[0].commit),
      [1, 2],
    );
    assert.equal(done.steps.at(-1).output.valueWire, '3');
  },
);
