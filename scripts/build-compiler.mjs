import { execFileSync } from 'node:child_process';
import { readFile, writeFile, copyFile, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const args = ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', 'compiler/Cargo.toml'];
if (process.env.INK_CARGO_CONFIG) args.push('--config', process.env.INK_CARGO_CONFIG);
execFileSync(process.env.INK_CARGO || 'cargo', args, {
  stdio: 'inherit',
  env: { ...process.env, CARGO_INCREMENTAL: '0', CARGO_PROFILE_RELEASE_DEBUG: '0', RUSTFLAGS: `--remap-path-prefix=${homedir()}=/build -C link-arg=-z -C link-arg=stack-size=8388608 -C link-arg=--max-memory=268435456` },
});
await mkdir('public', { recursive: true });
const source = 'compiler/target/wasm32-unknown-unknown/release/ink_browser_compiler.wasm';
const bytes = await readFile(source);
if (bytes.includes(Buffer.from(homedir()))) throw Error('Compiler artifact contains a personal filesystem path.');
await copyFile(source, 'public/ink-compiler.wasm');
await chmod('public/ink-compiler.wasm', 0o644);
await writeFile('public/compiler-info.json', JSON.stringify({
  schema: 1,
  license: 'MIT',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  dependencyLockSHA256: createHash('sha256').update(await readFile('compiler/Cargo.lock')).digest('hex'),
  transportSourceSHA256: createHash('sha256').update(await readFile('compiler/src/lib.rs')).digest('hex'),
  outputs: ['javascript', 'rust', 'wgsl'],
}, null, 2) + '\n');
console.log('Built and verified the portable Ink compiler.');
