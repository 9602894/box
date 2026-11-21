// scripts/build-main.mjs — 主进程转 ESM，preload/worker 保持 CJS
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const src = resolve(root, '..');
const watch = process.argv.includes('--watch');

// ★ 核心补丁：让 ESM 支持 __dirname / require / __filename
const esmBanner = `
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`;

// 主进程配置（改为 ESM 格式）
const mainOpts = {
  bundle: true,
  platform: 'node',
  format: 'esm', // ★ 输出为 ESM 模块
  target: 'node20',
  sourcemap: true,
  banner: { js: esmBanner }, // ★ 注入补丁
  // electron-mpv-video 是纯 ESM 且含原生模块，必须 external 让运行时通过 import() 加载
  external: ['electron', 'iconv-lite', 'fast-xml-parser', 'node-unrar-js', '7z-wasm', 'electron-mpv-video'],
  logLevel: 'info',
};

// Preload 配置（必须保持 CJS 格式）
const preloadOpts = {
  bundle: true,
  platform: 'node',
  format: 'cjs', // ★ preload 必须为 CJS
  target: 'node20',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

// JS 蜘蛛 Worker 配置（保持 CJS）
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
  // 主进程 (Watch)
  const mainCtx = await context({
    ...mainOpts,
    entryPoints: [resolve(src, 'src/main/index.ts')],
    outfile: resolve(src, 'dist/main.mjs'), // ★ 输出为 .mjs
  });
  await mainCtx.watch();

  // Preloads (Watch)
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

  // Worker (Watch)
  const wctx = await context({
    ...workerOpts,
    entryPoints: [resolve(src, 'src/engine/js/worker/entry.ts')],
    outfile: workerFile,
  });
  await wctx.watch();
  
  console.log('[main] watching...');
} else {
  // 主进程 (Build)
  await build({
    ...mainOpts,
    entryPoints: [resolve(src, 'src/main/index.ts')],
    outfile: resolve(src, 'dist/main.mjs'),
  });

  // Preloads (Build)
  for (const e of [
    { in: resolve(src, 'src/main/preload.ts'), out: 'preload' },
    { in: resolve(src, 'src/main/webbridge/webhomePreload.ts'), out: 'webhome-preload' },
  ]) {
    await build({ ...preloadOpts, entryPoints: [e.in], outfile: resolve(src, `dist/${e.out}.cjs`) });
  }

  // Worker (Build)
  await build({ ...workerOpts, entryPoints: [resolve(src, 'src/engine/js/worker/entry.ts')], outfile: workerFile });
  
  console.log('[main] build done');
}
