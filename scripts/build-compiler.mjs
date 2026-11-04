import { execFileSync } from 'node:child_process';
import { readFile, writeFile, copyFile, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const args = [
  'build',
  '--locked',
  '--release',
  '--target',
  'wasm32-unknown-unknown',
  '--manifest-path',
  'compiler/Cargo.toml',
];
if (process.env.INK_CARGO_CONFIG)
  args.push('--config', process.env.INK_CARGO_CONFIG);
execFileSync(process.env.INK_CARGO || 'cargo', args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    CARGO_INCREMENTAL: '0',
    CARGO_PROFILE_RELEASE_DEBUG: '0',
    RUSTFLAGS: `--remap-path-prefix=${homedir()}=/build -C link-arg=-z -C link-arg=stack-size=8388608 -C link-arg=--max-memory=536870912`,
  },
});
await mkdir('public', { recursive: true });
const source =
  'compiler/target/wasm32-unknown-unknown/release/ink_browser_compiler.wasm';
const bytes = await readFile(source);
let previous;
try {
  previous = JSON.parse(await readFile('public/compiler-info.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const lockSHA256 = createHash('sha256')
  .update(await readFile('compiler/Cargo.lock'))
  .digest('hex');
let compatibility;
try {
  compatibility = JSON.parse(
    await readFile('compiler/replay-compatibility.json', 'utf8'),
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (
  compatibility &&
  (compatibility.schema !== 1 ||
    compatibility.dependencyLockSHA256 !== lockSHA256 ||
    compatibility.proofReplayRequired !== true ||
    !Array.isArray(compatibility.compatibleCompilerSHA256) ||
    compatibility.compatibleCompilerSHA256.length > 8 ||
    compatibility.compatibleCompilerSHA256.some(
      (hash) => !/^[a-f0-9]{64}$/.test(hash),
    ))
)
  throw Error(
    'Compiler replay eligibility receipt differs from the locked source',
  );
if (bytes.includes(Buffer.from(homedir())))
  throw Error('Compiler artifact contains a personal filesystem path.');
await copyFile(source, 'public/ink-compiler.wasm');
await chmod('public/ink-compiler.wasm', 0o644);
await writeFile(
  'public/compiler-info.json',
  JSON.stringify(
    {
      schema: 1,
      license: 'MIT',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      dependencyLockSHA256: lockSHA256,
      replayCompatible: [
        ...new Set([
          ...(previous?.dependencyLockSHA256 === lockSHA256
            ? [previous.sha256, ...(previous.replayCompatible || [])]
            : []),
          ...(compatibility?.compatibleCompilerSHA256 || []),
        ]),
      ]
        .filter(
          (hash) => hash !== createHash('sha256').update(bytes).digest('hex'),
        )
        .slice(0, 8),
      ...(compatibility
        ? {
            replayCompatibilitySHA256: createHash('sha256')
              .update(await readFile('compiler/replay-compatibility.json'))
              .digest('hex'),
          }
        : {}),
      transportSourceSHA256: createHash('sha256')
        .update(await readFile('compiler/src/lib.rs'))
        .digest('hex'),
      outputs: ['javascript', 'rust', 'wgsl'],
    },
    null,
    2,
  ) + '\n',
);
console.log('Built and verified the portable Ink compiler.');
