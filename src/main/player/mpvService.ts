// src/main/player/mpvService.ts — electron-mpv-video 统一托管
// 目标：任何一个加载了 preload（含 exposeMpvApi）的窗口创建 <mpv-video> 时，
//       其 BrowserWindow 都必须已通过 attachWindow 注册，否则播放会报：
//       "The sender BrowserWindow is not attached to electron-mpv-video"
import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMpvMain } from 'electron-mpv-video/main';
import { fileLogger } from '../util/logger';
import { resourcesDir } from '../util/paths';

type MpvMain = ReturnType<typeof createMpvMain>;

let mpvMain: MpvMain | null = null;
let starting: Promise<MpvMain | null> | null = null;
const attachedWinIds = new Set<number>();

function ensureMpvRuntimeDir(): void {
  try {
    const mpvDir = join(resourcesDir(), 'libmpv');
    if (existsSync(mpvDir)) {
      // 必须在原生插件加载之前设置
      process.env.MPV_RUNTIME_DIR = mpvDir;
      fileLogger.i(`[libmpv] MPV_RUNTIME_DIR=${mpvDir}`);
    } else {
      fileLogger.w(`[libmpv] 运行时目录不存在: ${mpvDir}，直播 MPV 内核将不可用`);
    }
  } catch (e) {
    fileLogger.w('[libmpv] 运行时目录探测失败: ' + (e as Error).message);
  }
}

/** 对窗口执行 attach（幂等，重复调用安全） */
export function attachMpvWindow(win: BrowserWindow | null | undefined): void {
  if (!mpvMain || !win || win.isDestroyed()) return;
  if (attachedWinIds.has(win.id)) return;
  try {
    (mpvMain as any).attachWindow?.(win);
    attachedWinIds.add(win.id);
    win.once('closed', () => attachedWinIds.delete(win.id));
    fileLogger.i(`[libmpv] attachWindow 成功: winId=${win.id}`);
  } catch (e) {
    fileLogger.w(`[libmpv] attachWindow 失败 win=${win.id}: ${(e as Error).message}`);
  }
}

/** 初始化 MPV 服务，并全局自动挂载所有 BrowserWindow */
export async function initMpvService(): Promise<void> {
  if (starting) { await starting; return; }
  starting = (async () => {
    try {
      ensureMpvRuntimeDir();
      const main = createMpvMain();
      if (typeof (main as any).whenReady === 'function') {
        await (main as any).whenReady();
      }
      mpvMain = main;
      fileLogger.i('[libmpv] MPV 服务已创建并就绪');
    } catch (e) {
      fileLogger.w('[libmpv] MPV 服务初始化失败: ' + (e as Error).message);
      mpvMain = null;
      return null;
    }

    // ★ 核心修复：此后创建的每一个 BrowserWindow（主窗口、播放器窗口、
    //   详情/EPG/搜索/网页窗口……）都自动 attach，无需各窗口自行处理。
    app.on('browser-window-created', (_event, win) => {
      try {
        if (win.webContents && !win.webContents.isDestroyed()) {
          attachMpvWindow(win);
        } else {
          win.once('ready-to-show', () => attachMpvWindow(win));
        }
      } catch (e) {
        fileLogger.w('[libmpv] browser-window-created 挂载异常: ' + (e as Error).message);
      }
    });

    // 回补：服务创建之前已经存在的窗口
    for (const win of BrowserWindow.getAllWindows()) attachMpvWindow(win);
    return mpvMain;
  })();
  await starting;
}

export function mpvService(): MpvMain | null {
  return mpvMain;
}

export function disposeMpvService(): void {
  try { (mpvMain as any)?.dispose?.(); } catch { /* ignore */ }
  mpvMain = null;
  attachedWinIds.clear();
}
