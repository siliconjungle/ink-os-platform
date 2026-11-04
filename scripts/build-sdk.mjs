import { build } from 'vite';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// CLI applications load a classic script; inline the SDK's dynamic helpers so
// source SDK fixes (including typed live queries) also reach new applications.
await build({
  root: fileURLToPath(new URL('../', import.meta.url)),
  configFile: false,
  publicDir: false,
  build: {
    lib: {
      entry: fileURLToPath(
        new URL('../sdk/src/cli-global.js', import.meta.url),
      ),
      formats: ['iife'],
      name: 'InkSDK',
      fileName: () => 'sdk.js',
    },
    target: 'es2022',
    outDir: 'cli/templates',
    emptyOutDir: false,
    minify: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
await copyFile(
  new URL('../sdk/src/live-query.js', import.meta.url),
  new URL('../cli/templates/live-query.mjs', import.meta.url),
);

await build({
  root: fileURLToPath(new URL('../', import.meta.url)),
  configFile: false,
  publicDir: false,
  build: {
    lib: {
      entry: fileURLToPath(new URL('../sdk/src/ui-global.js', import.meta.url)),
      formats: ['iife'],
      name: 'InkUIRuntime',
      fileName: () => 'ui.mjs',
    },
    target: 'es2022',
    outDir: 'cli/templates',
    emptyOutDir: false,
    minify: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
