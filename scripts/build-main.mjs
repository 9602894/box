// scripts/build-main.mjs
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const src = resolve(root, '..');
const watch = process.argv.includes('--watch');

// 主进程配置（改为 ESM）
const mainOpts = {
  bundle: true,
  platform: 'node',
  format: 'esm', // ★ 改为 ESM
  target: 'node20',
  sourcemap: true,
  external: ['electron', 'iconv-lite', 'fast-xml-parser', 'node-unrar-js', '7z-wasm', 'electron-mpv-video'],
  logLevel: 'info',
};

// Preload 配置（必须保持 CJS，因为 Electron 的沙盒机制限制）
const preloadOpts = {
  bundle: true,
  platform: 'node',
  format: 'cjs', // ★ 保持 CJS
  target: 'node20',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

const workerFile = resolve(src, 'dist/js-worker.cjs');
const workerOpts = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'info',
};

if (watch) {
  // Main (ESM)
  const mainCtx = await context({
    ...mainOpts,
    entryPoints: [resolve(src, 'src/main/index.ts')],
    outfile: resolve(src, 'dist/main.mjs'), // ★ 输出为 .mjs
  });
  await mainCtx.watch();

  // Preloads (CJS)
  const preloadCtx = await context({
    ...preloadOpts,
    entryPoints: [
      resolve(src, 'src/main/preload.ts'),
      resolve(src, 'src/main/webbridge/webhomePreload.ts')
    ],
    outdir: resolve(src, 'dist'),
    outExtension: { '.js': '.cjs' },
  });
  await preloadCtx.watch();

  // Worker (CJS)
  const wctx = await context({
    ...workerOpts,
    entryPoints: [resolve(src, 'src/engine/js/worker/entry.ts')],
    outfile: workerFile,
  });
  await wctx.watch();
  console.log('[main] watching...');
} else {
  // Build Main (ESM)
  await build({
    ...mainOpts,
    entryPoints: [resolve(src, 'src/main/index.ts')],
    outfile: resolve(src, 'dist/main.mjs'),
  });

  // Build Preloads (CJS)
  for (const e of [
    { in: resolve(src, 'src/main/preload.ts'), out: 'preload' },
    { in: resolve(src, 'src/main/webbridge/webhomePreload.ts'), out: 'webhome-preload' },
  ]) {
    await build({ ...preloadOpts, entryPoints: [e.in], outfile: resolve(src, `dist/${e.out}.cjs`) });
  }

  // Build Worker (CJS)
  await build({ ...workerOpts, entryPoints: [resolve(src, 'src/engine/js/worker/entry.ts')], outfile: workerFile });
  console.log('[main] build done');
}
