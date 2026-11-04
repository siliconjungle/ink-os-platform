import { join } from 'node:path';
import { World } from '../../server/world.mjs';
import { Platform } from '../../server/platform.mjs';
import { Code } from '../../server/code.mjs';
import { InkEffects } from '../../server/ink-effects.mjs';
const [directory, encodedPolicy, mode] = process.argv.slice(2),
  policy = JSON.parse(encodedPolicy);
const world = await new World(directory).open(),
  platform = await new Platform({
    root: '.',
    directory,
    world,
    origin: 'http://127.0.0.1:1',
    environmentKey: Buffer.alloc(32, 3).toString('base64'),
  }).open();
platform.code = new Code('.', join(directory, 'code'), world);
platform.effects = await new InkEffects({
  platform,
  policy,
  allowHttp: true,
  autoStart: false,
}).open();
if (mode === 'observed') {
  const commit = platform.effects.store.commit.bind(platform.effects.store);
  platform.effects.store.commit = async (record) => {
    await commit(record);
    if (record.runs?.some(([, run]) => run?.phase === 'observed')) {
      process.send({ observed: true });
      await new Promise(() => {});
    }
  };
}
platform.effects.resumeAdmission();
process.send({ ready: true });
