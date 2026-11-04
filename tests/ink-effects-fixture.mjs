import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { World } from '../server/world.mjs';
import { Platform } from '../server/platform.mjs';
import { Code } from '../server/code.mjs';
import { InkEffects } from '../server/ink-effects.mjs';
import { buildInkApp } from '../server/ink-apps.mjs';
import { EFFECT_CAPABILITIES } from '../shared/ink-effects.mjs';
export const owner = {
  owner: true,
  admin: true,
  accountId: 'owner',
  namespace: 'os',
};
export const library = await readFile(
  new URL('../sdk/ink/effects.ink', import.meta.url),
  'utf8',
);
export const exports = [
  ...library.matchAll(/(?:record|fn)\s+([A-Za-z_][A-Za-z_0-9]*)/g),
].map((m) => m[1]);
export const file = (path, source) => ({
  path,
  base64: Buffer.from(source).toString('base64'),
});
export function protocol(
  kind,
  {
    resource,
    deadlineMs = 5000,
    retry = 'recorded',
    effect,
    source,
    appInput = 'Unit',
    appOutput = 'Unit',
    resume,
    requestType,
    requestExpression,
  } = {},
) {
  const type =
    requestType || kind[0].toUpperCase() + kind.slice(1) + 'EffectRequest';
  const input = appInput,
    output = appOutput,
    pending = 'EffectPending<Unit,' + input + '>';
  source ||= `module app;fn begin(request:${kind === 'app' ? input : type})->Result<EffectReply<${output}>,${pending}>{return Err(${pending}{state:unit,request:${requestExpression || `effect_${kind}<${input}>("op",request)`}});}fn resume(state:Unit,reply:EffectReply<${output}>)->Result<EffectReply<${output}>,${pending}>{${resume || 'return Ok(reply);'}}`;
  // Unit values use (), not an ambient host representation.
  source = source.replaceAll('state:unit', 'state:()');
  const manifest = {
    slug: 'effects-' + kind,
    language: 'ink',
    exports: ['begin'],
    capabilities: [EFFECT_CAPABILITIES[kind]],
    modules: {
      version: 1,
      root: 'main.ink',
      modules: [
        {
          path: 'main.ink',
          name: 'app',
          dependencies: ['effects.ink'],
          exports: ['begin', 'resume'],
        },
        { path: 'effects.ink', name: 'ink_effects', dependencies: [], exports },
      ],
    },
    effects: {
      version: 1,
      protocols: [
        {
          entry: 'begin',
          resume: 'resume',
          maxSteps: 4,
          deadlineMs,
          operations: [
            {
              name: 'op',
              kind,
              resource:
                resource ||
                {
                  clock: 'wall-clock',
                  random: 'system',
                  subscription: 'world',
                }[kind] ||
                'test',
              effect:
                effect ||
                {
                  clock: 'volatile',
                  random: 'volatile',
                  subscription: 'subscription',
                  http: 'read',
                  file: 'write',
                  process: 'write',
                  app: 'read',
                }[kind],
              retry,
              deadlineMs,
            },
          ],
        },
      ],
    },
  };
  return {
    manifest,
    files: [file('main.ink', source), file('effects.ink', library)],
  };
}
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ink-effects-'));
  const instances = [];
  const open = async (extra = {}) => {
    const world = await new World(directory).open(),
      platform = await new Platform({
        root: '.',
        directory,
        world,
        origin: 'http://127.0.0.1:1',
        environmentKey: Buffer.alloc(32, 3).toString('base64'),
        provider: {
          async deploy() {
            return { provider: 'fixture', url: 'http://127.0.0.1:1' };
          },
        },
      }).open();
    platform.code = new Code('.', join(directory, 'code'), world);
    platform.effects = await new InkEffects({
      platform,
      ...options,
      ...extra,
    }).open();
    instances.push(platform);
    return platform;
  };
  t.after(async () => {
    for (const p of instances) {
      await p.effects.close();
      await p.code.close();
      clearInterval(p.calls?.timer);
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, open, platform: await open() };
}
export async function install(platform, kind, options) {
  const source = protocol(kind, options),
    bundle = await buildInkApp(source.manifest, source.files),
    app = await platform.createApp({
      slug: 'effect-' + kind + '-' + crypto.randomUUID().slice(0, 8),
      capabilities: bundle.capabilities,
    }),
    release = await platform.createRelease(app.id, bundle);
  await platform.publish(app.id, release.id);
  return { app, release, bundle, source };
}
export const none = () => ({ None: null }),
  some = (Some) => ({ Some });
export async function call(platform, app, request, options = {}) {
  const start = await platform.effects.start(
    app.id,
    {
      entry: 'begin',
      input: JSON.stringify([request]),
      backend: 'javascript',
      ...options,
    },
    owner,
  );
  return platform.effects.wait(app.id, start.id, owner);
}
export async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error('Timed out waiting for fixture condition');
}
