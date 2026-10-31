import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { optimizeSnapshotWriter } from './snapshot-writer.mjs';

execFileSync(process.env.INK_COMPILER || 'ink', ['build', 'ink/world.ink', '--target', 'javascript', '-o', 'generated/world.mjs'], { stdio: 'inherit' });
await writeFile('generated/world.mjs', optimizeSnapshotWriter(await readFile('generated/world.mjs', 'utf8')));
