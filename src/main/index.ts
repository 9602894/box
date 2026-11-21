// src/main/index.ts — Electron 主进程入口
import { dataDirReport } from './util/dataDirBootstrap';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerIpc } from './ipc';
import { SpiderHost } from './spider/SpiderHost';
import { LocalProxyServer } from './server/LocalProxyServer';
import { fileLogger } from './util/logger';
import { applyWindowCorner } from './util/windowCorner';
import { bossKey } from './bossKey';
import { playerWindow, onPlayerWindowClosed } from './player/PlayerWindow';
import { playerSettings } from './player/playerSettings';
import { hostRegexFor, builtinAdRegex } from '../engine/util/m3u8Purify';
import { adKeywordSettings } from './player/adKeywordSettings';
import { TorrentPlay } from './torrent/torrentPlay';
import { DavService } from './webdav/DavService';
import { DlnaService } from './dlna/DlnaService';
import { UpdateService } from './update/UpdateService';
import { DavStore } from './store/DavStore';
import { JsonStore } from './store/JsonStore';
import { LocalPkgStore } from './store/LocalPkgStore';
import { LOCAL_PROXY_BASE } from '../shared/constants';
import { localImportsDir, userDataDir } from './util/paths';
import { safeStorageDriveCodec } from './util/driveCodec';
import { backupUserConfig, tryRecoverFromBackup } from './util/configBackup';
import {
  registerLiveSubscriptionIpc,
  bindLiveImporter,
  checkAndUpdateSubscriptions,
} from './LiveSubscriptionManager';
import { importLiveFileFromPath } from './live/importLiveFile';
// ★ 直播 libmpv 服务
import { createMpvMain } from 'electron-mpv-video/main';

declare const __dirname: string;

// 全局声明 mpvMain，延迟到 whenReady 后初始化
let mpvMain: ReturnType<typeof createMpvMain> | null = null;

try {
  const dir = userDataDir();
  backupUserConfig(dir);
  tryRecoverFromBackup(dir);
} catch {
  /* 数据目录初始化早期日志可能还没就绪，静默 */
}

let mainWindow: BrowserWindow | null = null;
const host = new SpiderHost();

const torrent = new TorrentPlay(fileLogger, () => playerSettings.settings.btExternalPlayer);
host.torrentPlay = torrent;

const dav = new DavService(
  new DavStore(new JsonStore(join(userDataDir(), 'webdav-servers.json')), fileLogger, safeStorageDriveCodec()),
  fileLogger,
);

const dlna = new DlnaService(fileLogger);

const updater = (() => {
  const CURRENT_VERSION = app.getVersion();
  const noopCheck = async () => ({
    hasUpdate: false, updateAvailable: false, available: false, needUpdate: false,
    shouldUpdate: false, hasNewVersion: false, forced: false, mandatory: false,
    forceUpdate: false, current: CURRENT_VERSION, currentVersion: CURRENT_VERSION,
    localVersion: CURRENT_VERSION, latest: CURRENT_VERSION, latestVersion: CURRENT_VERSION,
    version: CURRENT_VERSION, tag: CURRENT_VERSION, tagName: CURRENT_VERSION,
    tag_name: CURRENT_VERSION, version_name: CURRENT_VERSION, remoteVersion: CURRENT_VERSION,
    downloadUrl: '', url: '', notes: '', releaseNotes: '', body: '', publishedAt: '', name: '',
  });
  const noopDownload = async () => ({ ok: false, error: '更新功能已禁用' });
  const noopLaunch = async () => ({ ok: false, error: '更新功能已禁用' });
  const noopDownloadedPath = () => null as string | null;
  return {
    check: noopCheck, download: noopDownload, downloadedPath: noopDownloadedPath, launch: noopLaunch,
  } as unknown as UpdateService;
})();

const localPkgs = new LocalPkgStore(new JsonStore(join(userDataDir(), 'local-pkgs.json')), LOCAL_PROXY_BASE, localImportsDir());
const proxy = new LocalProxyServer(
  fileLogger,
  () => host.driveList(),
  {
    enabled: () => playerSettings.settings.m3u8Purify,
    rulesFor: (url) => [
      ...hostRegexFor(url, host.siteConfig?.rules),
      ...builtinAdRegex(adKeywordSettings.settings.strong, adKeywordSettings.settings.weak),
    ],
    adsFor: () => host.siteConfig?.ads || [],
    strongKeywordsFor: () => adKeywordSettings.settings.strong,
  },
  (id) => dav.authHeader(id),
);

proxy.pkgRoot = (i) => localPkgs.rootOf(i);
host.localPkgs = localPkgs;
host.initializeLocalImports();

const pushSpeed = (kbs: number): void => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('net:speed', kbs);
  }
};
proxy.onSpeed = pushSpeed;
torrent.onSpeed = pushSpeed;
proxy.onSpiderProxy = (port) => host.pinSpiderProxy(port);
proxy.onPythonProxy = (key, params) => host.pythonProxy(key, params);
proxy.bt = torrent;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');

app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_e, details) => {
    fileLogger.w(`renderer-gone wc=${contents.id} reason=${details.reason} exitCode=${details.exitCode}`);
  });
  contents.on('unresponsive', () => fileLogger.w(`renderer-unresponsive wc=${contents.id}`));
});
app.on('child-process-gone', (_event, details) => {
  fileLogger.w(`child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

function createWindow(): void {
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0c10' : '#dce4ec',
    title: 'Win-Box',
    frame: false,
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : join(__dirname, '..', '..', 'build', 'icon.png'),
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  mainWindow = new BrowserWindow(winOpts);

  const setCorner = (round: boolean) => {
    if (mainWindow && !mainWindow.isDestroyed()) applyWindowCorner(mainWindow, round);
  };
  const refreshContent = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const { webContents } = mainWindow;
        if (!webContents.isDestroyed()) webContents.invalidate();
      } catch { /* ignore */ }
    }
  };
  mainWindow.on('maximize', () => { setCorner(false); refreshContent(); });
  mainWindow.on('unmaximize', () => { setCorner(true); refreshContent(); });

  if (isDev()) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  }

  // ★ 核心修复：必须在窗口完全加载完毕后，再通知 MPV 绑定窗口
  mainWindow.webContents.on('did-finish-load', () => {
    if (mpvMain && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mpvMain.attachWindow(mainWindow);
        fileLogger.i('[libmpv] 已成功挂载主窗口到 MPV 服务 (did-finish-load)');
      } catch (e) {
        fileLogger.w('[libmpv] attachWindow 失败: ' + (e as Error).message);
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // 1. 设置 libmpv 路径
  try {
    const { resourcesDir } = await import('./util/paths');
    const mpvDir = join(resourcesDir(), 'libmpv');
    if (existsSync(mpvDir)) {
      process.env.MPV_RUNTIME_DIR = mpvDir;
      fileLogger.i(`[libmpv] 运行时目录设置成功: ${mpvDir}`);
    } else {
      fileLogger.w(`[libmpv] 运行时目录不存在: ${mpvDir}，直播将无法播放`);
    }
  } catch (e) {
    fileLogger.w('[libmpv] 路径探测失败: ' + (e as Error).message);
  }

  // 2. 初始化 MPV 服务
  try {
    mpvMain = createMpvMain();
    if (typeof (mpvMain as any).whenReady === 'function') {
      await (mpvMain as any).whenReady();
      fileLogger.i('[libmpv] MPV 服务底层就绪');
    }
  } catch (e) {
    fileLogger.w(`[libmpv] 服务初始化失败: ${(e as Error).message}`);
  }

  // 3. 其他初始化
  try {
    const m = dataDirReport.migration;
    const migDesc = m
      ? `迁移=${m.status}${m.files ? `（${m.files} 文件 / ${(m.bytes / 1024 / 1024).toFixed(1)}MB）` : ''}${m.skipped ? `，跳过可重建缓存 ${m.skipped} 项` : ''}${m.status === 'moved' ? '（整目录移动）' : ''}${m.cleanedLegacy ? '，旧目录已清理' : ''}${m.error ? `，注意：${m.error}` : ''}`
      : '迁移=无旧数据';
    if (dataDirReport.mode === 'fallback') {
      fileLogger.w(`数据目录: ${dataDirReport.target}（回退，计划目录 ${dataDirReport.planned}）：${dataDirReport.reason || ''}`);
    } else {
      fileLogger.i(`数据目录: ${dataDirReport.target}（模式 ${dataDirReport.mode}；${migDesc}）`);
    }
  } catch { /* ignore */ }

  try {
    const { resourcesDir, resourcesDirDebug } = await import('./util/paths');
    const dir = resourcesDir();
    const ok = existsSync(join(dir, 'jvm', 'jre', 'bin', 'java.exe'));
    fileLogger.i(`资源根: ${dir} | java.exe: ${ok ? 'OK' : '缺失'}`);
    if (!ok) fileLogger.w('资源候选路径探测:\n' + resourcesDirDebug());
  } catch (e) {
    fileLogger.w('资源根探测失败: ' + (e instanceof Error ? e.message : String(e)));
  }

  fileLogger.i(`build: 20261012.1 release-${app.getVersion()}`);

  try {
    await proxy.start();
  } catch {
    fileLogger.w('本地代理启动失败，直播归一化可能受影响');
  }
  try {
    const { initProxySettings } = await import('./net/proxy');
    initProxySettings(join(userDataDir(), 'proxy.json'));
  } catch (e) {
    fileLogger.w('代理设置初始化失败：' + (e as Error).message);
  }
  try {
    const { initPlayDiag } = await import('./util/playDiag');
    initPlayDiag({
      logDir: () => join(userDataDir(), 'logs'),
      log: (m: string) => fileLogger.i(m),
    });
  } catch (e) {
    fileLogger.w('播放诊断初始化失败：' + (e as Error).message);
  }
  
  registerIpc(host, dav, dlna, updater, localPkgs);
  bindLiveImporter((srcPath, opts) => importLiveFileFromPath(host, srcPath, opts));
  registerLiveSubscriptionIpc();

  try {
    const r = host.healUserConfig();
    if (r.sources + r.lives + r.subs > 0) {
      fileLogger.i(`[heal] 启动自愈：补 ${r.sources} py 源 / ${r.lives} 本地直播 / ${r.subs} 网络订阅`);
    }
  } catch (e) {
    fileLogger.w(`[heal] 启动自愈失败：${(e as Error).message}`);
  }

  setTimeout(() => {
    void host.checkPyUpdates().catch((e) => fileLogger.w('py 更新检查失败：' + (e as Error).message));
  }, 10_000);

  bossKey.start(() => {
    const ws: BrowserWindow[] = [];
    if (mainWindow && !mainWindow.isDestroyed()) ws.push(mainWindow);
    const pw = playerWindow();
    if (pw) ws.push(pw);
    return ws;
  });
  bossKey.apply();
  onPlayerWindowClosed(() => {
    void host.quarkDeletePending().catch(() => undefined);
  });
  void host.quarkDeletePending().catch(() => undefined);
  
  // 4. 创建主窗口
  createWindow();

  setTimeout(() => {
    void checkAndUpdateSubscriptions()
      .then((r) => {
        if (r.updated > 0 || r.failed > 0) {
          fileLogger.i(`[LiveSub] 启动自动检查：更新 ${r.updated} · 跳过 ${r.skipped} · 失败 ${r.failed}`);
        }
      })
      .catch((e) => fileLogger.w(`[LiveSub] 启动自动检查异常：${(e as Error).message}`));
  }, 300);

  void host.maybeAutoRefreshSubscriptions();
  try { host.syncDriveFiles(); } catch { /* 同步失败不影响启动 */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  proxy.stop();
  if (process.platform !== 'darwin') app.quit();
});

let quitCleanupStarted = false;
app.on('will-quit', (event) => {
  if (!quitCleanupStarted) {
    quitCleanupStarted = true;
    event.preventDefault();
    void Promise.race([
      host.quarkDeletePending(),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]).finally(() => app.quit());
    return;
  }
  
  try { void mpvMain?.dispose(); } catch { /* ignore */ }
  try { void host.quarkDeletePending(); } catch { /* ignore */ }
  try { host.dispose(); } catch { /* ignore */ }
  try { torrent.dispose(); } catch { /* ignore */ }
  try { proxy.stop(); } catch { /* ignore */ }
});

process.on('beforeExit', () => {
  try { host.dispose(); } catch { /* ignore */ }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
