import test from 'node:test';
import assert from 'node:assert/strict';
import { compilerRequest } from '../server/ink-compiler.mjs';

const graph = () => ({ version: 1, root: 'main.ink', modules: [
  { path: 'main.ink', name: 'app', source: 'module app;fn run(n:u32)->u32{return bump(n);}', dependencies: ['lib/math.ink'], exports: ['run'] },
  { path: 'lib/math.ink', name: 'math', source: 'module math;fn bump(n:u32)->u32{return n+1;}fn hidden()->u32{return 41;}', dependencies: [], exports: ['bump'] },
] });
const compile = graph => compilerRequest({ op: 'compileModules', graph });
const program = async artifact => import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));

test('distributed Wasm links checked modules, exposes explicit package exports and binds exact source closure', async () => {
  const source = graph(), artifact = await compile(source), module = await program(artifact);
  assert.equal(module.callOwned('run', [8]), 9);
  assert.deepEqual(artifact.module_graph.root_exports, ['run']);
  assert.equal(artifact.module_graph.core_sha256, artifact.manifest.core_sha256);
  for (const field of ['graph_sha256', 'core_sha256', 'identity']) assert.match(artifact.module_graph[field], /^[a-f0-9]{64}$/);
  const reordered = structuredClone(source); reordered.modules.reverse();
  assert.deepEqual((await compile(reordered)).module_graph, artifact.module_graph);
  const changed = structuredClone(source); changed.modules[1].source += '\n// exact committed source';
  assert.notEqual((await compile(changed)).module_graph.identity, artifact.module_graph.identity);
  const prepared = await compilerRequest({ op: 'prepare', core: artifact.core, identity: artifact.manifest.core_sha256, entry: 'run', input: '[8]' });
  assert.deepEqual(JSON.parse(prepared.input), [8]);
});

test('distributed Wasm preserves state/checkpoints and rejects foreign export access before generating artifacts', async () => {
  const source = graph();
  source.modules[0].source = 'module app;state Total:u32=0;change run(n:u32)->u32 reads(Total) writes(Total){Total=Total+bump(n);return Total;}query total()->u32 reads(Total){return Total;}';
  source.modules[0].exports = ['run', 'total'];
  const module = await program(await compile(source)), state = module.createState();
  assert.equal(state.invoke('run', [8]).result, 9);
  const saved = await state.checkpoint(), restored = module.createState(); await restored.restore(saved);
  assert.equal(restored.invoke('total', []).result, 9);
  const privateCall = graph(); privateCall.modules[0].source = 'module app;fn run(hidden:u32)->u32{return hidden();}';
  await assert.rejects(compile(privateCall));
  const missingDependency = graph(); missingDependency.modules[0].dependencies = [];
  await assert.rejects(compile(missingDependency));
  const invalidExport = graph(); invalidExport.modules[0].exports = ['bump'];
  await assert.rejects(compile(invalidExport));
});

test('distributed Wasm fails explicit graph limits and unsupported record-update syntax', async () => {
  for (const mutate of [source => source.modules[0].path = '../main.ink', source => source.version = 2, source => source.modules[1].source = 'module wrong;fn bump(n:u32)->u32{return n;}', source => source.modules[0].source += ' '.repeat(128 * 1024)]) {
    const source = graph(); mutate(source); await assert.rejects(compile(source));
  }
  const update = graph(); update.modules[0].source = 'module app;record Owned{item:u32,}fn run(v:Owned)->Owned{return Owned{..v,item:9};}';
  await assert.rejects(compile(update), /do not yet support record updates/);
});
