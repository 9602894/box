// src/renderer/pages/LivePage.tsx
import { Component, useEffect, useRef, useState, useCallback } from 'react';
import { client } from '../api/client';
import { ipcInvoke } from '../api/ipc';
import type {
  LiveGroup, LiveBean, LiveEpgEntry, EpgChannelRef, LiveSubscription,
} from '../../shared/types';
import { splitLine } from '../../engine/live/LiveUtils';
import {
  sharedHlsPlaylistProbe, containerHintForUrl, isHlsProbeCandidate,
  resolveDirectPlaybackMode, type PlaybackMode,
} from '../live/livePlaybackProbe';
import { defineMpvVideoElement } from 'electron-mpv-video/renderer';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';

// ★ 修复：_electronMpvVideo 未注入时（preload 缺失/非 Electron 环境）不定义
//   mpv-video 元素，让上层能干净地兜底切换到 Web 播放器，而不是抛底层错误。
function mpvApiAvailable(): boolean {
  return typeof (window as any)?._electronMpvVideo !== 'undefined';
}

// 注册 MPV 自定义元素（幂等 + 容错，防止 HMR/重复注册抛错）
let mpvElementDefined = false;
function ensureMpvElement() {
  if (mpvElementDefined) return;
  try {
    if (mpvApiAvailable()) defineMpvVideoElement();
  } catch { /* 已注册或环境不支持时忽略 */ }
  mpvElementDefined = true;
}
ensureMpvElement();

declare global {
  namespace JSX {
    interface IntrinsicElements {
      // ★ 绝不声明/传递 mode：mpv-video 的 mode 是只读 getter，
      //   任何赋值（React 属性赋值或元素内部回调赋值）都会抛 TypeError
      'mpv-video': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try { return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem; } catch { return {}; }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

type EpgStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';
interface LiveSubChangedPayload {
  updated: boolean; updatedIds: string[]; failedIds: string[]; reason: 'startup' | 'manual' | 'crud';
}

type MediaKind = 'hls' | 'flv' | 'ts' | 'native' | 'unknown';
type PlayerEngine = 'mpv' | 'web';

// 固定引用，避免每次渲染生成新 style 对象触发无意义的 DOM 写
const PLAYER_STYLE: React.CSSProperties = { width: '100%', height: '100%', background: '#000', display: 'block' };

class StreamDetector {
  static detectByUrl(url: string): MediaKind {
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8')) return 'hls';
    if (lower.includes('.flv')) return 'flv';
    if (/\.ts(\?|#|$)/.test(lower)) return 'ts';
    if (/\.(mp4|mkv|mov|webm|m4v|avi)(\?|#|$)/test(lower)) return 'native';
    return 'unknown';
  }
}

async function detectPlaybackSource(
  url: string,
): Promise<{ kind: MediaKind; mode: PlaybackMode; reason: string }> {
  const hint = containerHintForUrl(url);
  const urlKind = StreamDetector.detectByUrl(url);
  if (hint) {
    return { kind: urlKind === 'unknown' ? 'native' : urlKind, mode: hint, reason: 'container' };
  }
  if (isHlsProbeCandidate(url)) {
    const probe = await sharedHlsPlaylistProbe.probe(url);
    const decision = resolveDirectPlaybackMode({ url, probe });
    return { kind: 'hls', mode: decision.mode, reason: decision.reason ?? '' };
  }
  if (urlKind !== 'unknown') {
    return { kind: urlKind, mode: 'live', reason: 'default-live' };
  }
  return { kind: 'unknown', mode: 'live', reason: 'default-live' };
}

// ----------------------------------------------------------------------
// 错误边界：单个播放器崩溃只影响自己，绝不允许拖垮整个直播页
// ----------------------------------------------------------------------
class PlayerErrorBoundary extends Component<
  { children: React.ReactNode; onFatal: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(err: Error): void {
    console.error('[Live] 播放器内部错误，已隔离：', err);
    try { this.props.onFatal(); } catch { /* ignore */ }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="empty" style={{ width: '100%', height: '100%' }}>
          播放器内部错误，正在自动切换内核…
        </div>
      );
    }
    return this.props.children;
  }
}

// ----------------------------------------------------------------------
// 播放器 1：MPV 播放器
// ★ 修复要点：
//   1. 绝不写 mode（只读 getter），也不 setAttribute('mode')
//   2. 所有元素 API 调用前做能力检测 + try/catch
//   3. effect 只依赖 [url, el]，回调经 ref 转发，杜绝每次渲染重复 open()
//   4. 播放前检测 window._electronMpvVideo 是否注入，缺失时直接走错误回调兜底
// ----------------------------------------------------------------------
function LiveMpvPlayer({
  url, onModeDetected, onError,
}: {
  url: string;
  onModeDetected?: (mode: PlaybackMode, reason: string) => void;
  onError?: (msg: string) => void;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const cbRef = useRef({ onModeDetected, onError });
  cbRef.current = { onModeDetected, onError };

  useEffect(() => {
    if (!el || !url) return;
    let disposed = false;
    const mpvEl = el as any;

    // ★ 修复点 A：播放前确认 MPV 通道可用，不可用立即上报并交由上层切 Web 内核
    if (!mpvApiAvailable() || typeof mpvEl.open !== 'function') {
      cbRef.current.onError?.('MPV 服务不可用（preload 未注入），已自动切换到 Web 播放器');
      return;
    }

    // 清理上次可能残留的 error 监听
    const onElError = (ev: Event) => {
      if (disposed) return;
      const detail = (ev as CustomEvent)?.detail;
      cbRef.current.onError?.(`MPV 播放错误: ${detail || '未知错误'}`);
    };
    try { mpvEl.addEventListener?.('error', onElError); } catch { /* ignore */ }

    (async () => {
      try {
        const { mode, reason } = await detectPlaybackSource(url);
        if (disposed) return;
        cbRef.current.onModeDetected?.(mode, reason);
      } catch {
        if (!disposed) cbRef.current.onModeDetected?.('live', 'probe-failed');
      }
      if (disposed) return;

      try {
        // 只使用元素明确暴露的 API；不触碰任何只读属性（mode 等）
        if (typeof mpvEl.open === 'function') {
          await mpvEl.open(url);
          if (disposed) return;
          if (typeof mpvEl.play === 'function') await mpvEl.play();
        } else if ('src' in mpvEl) {
          mpvEl.src = url;
          if (disposed) return;
          if (typeof mpvEl.play === 'function') await mpvEl.play();
        } else {
          throw new Error('mpv-video 元素未暴露可用播放 API');
        }
      } catch (err) {
        if (!disposed) {
          console.error('[mpv] live open failed', err);
          cbRef.current.onError?.(`MPV 播放失败: ${(err as Error).message || '请尝试切换频道或线路'}`);
        }
      }
    })();

    return () => {
      disposed = true;
      try { mpvEl.removeEventListener?.('error', onElError); } catch { /* ignore */ }
      try { if (typeof mpvEl.pause === 'function') mpvEl.pause(); } catch { /* ignore */ }
      try { if (typeof mpvEl.stop === 'function') mpvEl.stop(); } catch { /* ignore */ }
      // ★ 注意：不要调用 destroy()，避免主进程解除窗口绑定引发下一次调用报错
    };
  }, [url, el]);

  return (
    <mpv-video
      ref={(node) => setEl(node)}
      style={PLAYER_STYLE}
    />
  );
}

// ----------------------------------------------------------------------
// 播放器 2：Web 播放器 (hls.js + mpegts.js + 原生 video)
// ----------------------------------------------------------------------
function LiveWebPlayer({ url, onError }: { url: string; onError?: (msg: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cbRef = useRef(onError);
  cbRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;

    let hls: Hls | null = null;
    let flv: mpegts.Player | null = null;

    const play = () => {
      video.play().catch((err) => {
        if (err.name !== 'AbortError') {
          console.warn('[WebPlayer] 自动播放被拦截:', err);
        }
      });
    };

    const lower = url.toLowerCase();

    if (lower.includes('.flv') && mpegts.isSupported()) {
      // FLV 直播流：走 mpegts.js
      try {
        flv = mpegts.createPlayer(
          { type: 'flv', isLive: true, url },
          { enableStashBuffer: false, liveBufferLatencyChasing: true },
        );
        flv.attachMediaElement(video);
        flv.load();
        flv.play();
      } catch (err) {
        cbRef.current?.(`Web 播放失败: ${(err as Error).message}`);
      }
    } else if (lower.includes('.m3u8') && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, play);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // ★ 网络级失败重试一次；若持续失败多半是跨域/Referer 校验，提示换 MPV 内核
            hls?.startLoad(); break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls?.recoverMediaError(); break;
          default:
            cbRef.current?.(`Web 播放失败: ${data.details}（跨域或 header 受限的源请改用 MPV 内核）`); break;
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl') && lower.includes('.m3u8')) {
      video.src = url;
      video.addEventListener('loadedmetadata', play);
    } else {
      video.src = url;
      play();
    }

    return () => {
      if (hls) { try { hls.destroy(); } catch { /* ignore */ } }
      if (flv) {
        try { flv.pause(); flv.unload(); flv.detachMediaElement(); flv.destroy(); } catch { /* ignore */ }
      }
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [url]);

  return (
    <video
      ref={videoRef}
      controls
      autoPlay
      playsInline
      style={{ ...PLAYER_STYLE, outline: 'none' }}
    />
  );
}

export default function LivePage() {
  const [lives, setLives] = useState<LiveBean[]>([]);
  const [liveIdx, setLiveIdx] = useState(0);
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [channelName, setChannelName] = useState('');
  const [lineIdx, setLineIdx] = useState(0);
  const [playUrl, setPlayUrl] = useState('');
  const [playbackUrl, setPlaybackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [epg, setEpg] = useState<Record<string, LiveEpgEntry>>({});
  const [epgStatus, setEpgStatus] = useState<EpgStatus>('idle');
  const epgTimer = useRef<number | null>(null);
  const [subCount, setSubCount] = useState(0);
  const [subEnabled, setSubEnabled] = useState(0);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [reconnectMsg, setReconnectMsg] = useState('');
  const reconnectCountRef = useRef(0);
  const lastReconnectAtRef = useRef(0);
  const MAX_RECONNECT = 50;
  const [playMode, setPlayMode] = useState<PlaybackMode>('live');
  const [playModeReason, setPlayModeReason] = useState('');

  // 播放器引擎状态
  const [playerEngine, setPlayerEngine] = useState<PlayerEngine>('mpv');
  const engineSwitchCountRef = useRef(0);
  // ★ 修复点 B：记录当前频道两个内核各自的失败状态，杜绝 mpv↔web 无限乒乓；
  //   两个内核都失败时停止切换，展示明确的重试入口。
  const engineFailedRef = useRef<Record<PlayerEngine, boolean>>({ mpv: false, web: false });
  const [bothFailed, setBothFailed] = useState(false);

  const playStateRef = useRef({ liveIdx, groupName, channelName, lineIdx, playUrl });
  useEffect(() => {
    playStateRef.current = { liveIdx, groupName, channelName, lineIdx, playUrl };
  }, [liveIdx, groupName, channelName, lineIdx, playUrl]);

  useEffect(() => {
    if (!playUrl) { setPlaybackUrl(''); return; }
    setPlaybackUrl(playUrl);
    reconnectCountRef.current = 0;
    lastReconnectAtRef.current = 0;
    engineSwitchCountRef.current = 0; // 换频道后重置引擎切换次数
    engineFailedRef.current = { mpv: false, web: false }; // 换频道后重置内核失败记录
    setBothFailed(false);
    setReconnectMsg('');
  }, [playUrl]);

  // ★ 稳定回调：useCallback 保证引用不变，杜绝播放器 effect 每渲染重复 open()
  const handleModeDetected = useCallback((mode: PlaybackMode, reason: string) => {
    setPlayMode(mode);
    setPlayModeReason(reason);
  }, []);

  const switchEngine = useCallback((target: PlayerEngine) => {
    // 防乒乓：同一频道最多互切 3 次，避免两个引擎都失败时死循环
    if (engineSwitchCountRef.current >= 3) return;
    // 已经失败过的内核不再切回
    if (engineFailedRef.current[target]) return;
    engineSwitchCountRef.current += 1;
    setPlayerEngine(target);
  }, []);

  const handlePlayerError = useCallback((msg: string) => {
    if (msg) setReconnectMsg(msg);
    const failed: PlayerEngine = playerEngine;
    engineFailedRef.current[failed] = true;
    const other: PlayerEngine = failed === 'mpv' ? 'web' : 'mpv';
    if (!engineFailedRef.current[other]) {
      switchEngine(other);
    } else {
      // 两个内核都已失败：停止切换，等待用户重试
      setBothFailed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerEngine, switchEngine]);

  const handleBoundaryFatal = useCallback(() => {
    // 渲染期崩溃（如只读属性赋值）→ 切到另一个引擎
    const failed: PlayerEngine = playerEngine;
    engineFailedRef.current[failed] = true;
    const other: PlayerEngine = failed === 'mpv' ? 'web' : 'mpv';
    if (!engineFailedRef.current[other]) switchEngine(other);
    else setBothFailed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerEngine, switchEngine]);

  // ★ 两个内核都失败后的手动重试：重置状态并强制重挂载当前引擎
  const retryPlayback = useCallback(() => {
    engineSwitchCountRef.current = 0;
    engineFailedRef.current = { mpv: false, web: false };
    setBothFailed(false);
    setReconnectMsg('');
    setPlayerEngine('mpv');
    setReconnectKey((k) => k + 1);
  }, []);

  const reloadLives = useCallback(async () => {
    try {
      await client.cfgGet();
      const m = await client.liveMeta();
      setLives(m);
      const idx = liveIdx < m.length ? liveIdx : 0;
      setLiveIdx(idx);
      if (m.length && idx !== liveIdx) await loadLiveInternal(idx, m);
    } catch (e) {
      console.warn('[Live] reload lives 失败：', e);
    }
  }, [liveIdx]);

  async function loadLiveInternal(index: number, meta?: LiveBean[], forceRefresh = false) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLoading(true);
    setErr('');
    try {
      const r = await client.loadLive(index, { forceRefresh });
      setGroups(r.groups);
      if (r.groups.length) {
        const mem = loadLiveMem();
        const fromMem = mem.liveIdx === index;
        const g = fromMem && mem.groupName ? r.groups.find((x) => x.group === mem.groupName) : undefined;
        const group = g || r.groups[0];
        setGroupName(group.group);
        const ch = fromMem && mem.channelName && group.channels.some((c) => c.name === mem.channelName)
          ? group.channels.find((c) => c.name === mem.channelName)!
          : group.channels[0];
        if (group.channels.length && ch) {
          pickChannelInternal(group, ch.name, fromMem ? (mem.lineIdx || 0) : 0, r.groups, index);
        }
      } else {
        setGroups([]); setGroupName(''); setChannelName(''); setPlayUrl('');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function pickLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLiveIdx(index);
    client.cfgSetActiveLive(index).catch(() => undefined);
    void loadLiveInternal(index, m);
  }

  function pickChannelInternal(g: LiveGroup, name: string, li: number, all = groups, idx = liveIdx) {
    setGroupName(g.group);
    setChannelName(name);
    setLineIdx(li);
    saveLiveMem({ liveIdx: idx, groupName: g.group, channelName: name, lineIdx: li });
    const ch = g.channels.find((c) => c.name === name);
    if (ch && ch.urls.length) {
      const line = splitLine(ch.urls[li] || ch.urls[0], li + 1);
      setPlayUrl(line.url);
    }
    if (all !== groups) setGroups(all);
  }
  const pickChannel = pickChannelInternal;

  const loadSubStatus = useCallback(async () => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      const arr = Array.isArray(list) ? list : [];
      setSubCount(arr.length);
      setSubEnabled(arr.filter((s) => s.enabled).length);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await client.cfgGet();
        const m = await client.liveMeta();
        if (cancelled) return;
        setLives(m);
        if (m.length) {
          const start = cfg.ui.activeLiveIndex < m.length ? cfg.ui.activeLiveIndex : 0;
          setLiveIdx(start);
          await loadLiveInternal(start, m);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    void loadSubStatus();
    return () => { cancelled = true; };
  }, []);

  const applySubscriptionUpdate = useCallback(async () => {
    const cur = playStateRef.current;
    try {
      const newMeta = await client.liveMeta();
      if (!Array.isArray(newMeta) || newMeta.length === 0) return;
      setLives(newMeta);
      const idx = cur.liveIdx < newMeta.length ? cur.liveIdx : 0;
      if (idx !== cur.liveIdx) setLiveIdx(idx);
      const r = await client.loadLive(idx, { forceRefresh: true });
      const newGroups = r.groups;
      if (!cur.groupName || !cur.channelName) { setGroups(newGroups); return; }
      const curGroup = newGroups.find((g) => g.group === cur.groupName);
      const curChannel = curGroup?.channels.find((c) => c.name === cur.channelName);
      if (!curGroup || !curChannel) return;
      setGroups(newGroups);
      const newLine = splitLine(curChannel.urls[cur.lineIdx] || curChannel.urls[0], cur.lineIdx + 1);
      const newUrl = newLine.url || '';
      if (newUrl && newUrl !== cur.playUrl) setPlayUrl(newUrl);
    } catch (e) {
      console.warn('[Live] 处理订阅更新失败:', e);
    }
  }, []);

  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:subscriptions-changed', (payload?: LiveSubChangedPayload) => {
      void loadSubStatus();
      if (!payload) { void reloadLives(); return; }
      if (!payload.updated) { if (payload.reason === 'crud') void reloadLives(); return; }
      void applySubscriptionUpdate();
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadSubStatus, reloadLives, applySubscriptionUpdate]);

  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:changed', () => {
      void (async () => {
        try {
          const m = await client.liveMeta();
          setLives(m);
          const idx = liveIdx < m.length ? liveIdx : 0;
          if (idx !== liveIdx) setLiveIdx(idx);
          if (m.length) await loadLiveInternal(idx, m);
        } catch { /* ignore */ }
      })();
    });
    return () => { if (typeof off === 'function') off(); };
  }, [liveIdx]);

  const curGroup = groups.find((g) => g.group === groupName);
  const curChannel = curGroup?.channels.find((c) => c.name === channelName);
  const curEpg = curChannel ? (epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name]) : undefined;
  const lines = curChannel ? curChannel.urls.map((u, i) => splitLine(u, i + 1)) : [];

  async function refreshEpg(index: number, gs: LiveGroup[], currentChannelName: string) {
    if (!currentChannelName) { setEpg({}); setEpgStatus('empty'); return; }
    const refs: EpgChannelRef[] = [];
    outer: for (const g of gs) {
      for (const c of g.channels) {
        if (c.name !== currentChannelName) continue;
        const r: EpgChannelRef = { tvgId: c['tvg-id'], tvgName: c['tvg-name'], name: c.name, epg: c.epg };
        if (r.tvgId || r.tvgName || r.name) refs.push(r);
        break outer;
      }
    }
    if (!refs.length) { setEpg({}); setEpgStatus('empty'); return; }
    setEpgStatus('loading');
    try {
      const r = await client.liveEpg(index, refs);
      setEpg(r.byKey);
      setEpgStatus(Object.keys(r.byKey).length ? 'ok' : 'empty');
    } catch (e) {
      setEpg({}); setEpgStatus('error');
    }
  }

  useEffect(() => {
    if (!groups.length) return;
    void refreshEpg(liveIdx, groups, channelName);
  }, [liveIdx, groups, channelName]);

  useEffect(() => {
    if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    if (!curChannel) return;
    const e = epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name];
    const at = e?.current?.endTime ?? e?.next?.startTime;
    if (!at) return;
    const delay = Math.max(1000, Math.min(at - Date.now() + 1000, 6 * 3600 * 1000));
    epgTimer.current = window.setTimeout(() => { void refreshEpg(liveIdx, groups, channelName); }, delay);
    return () => {
      if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    };
  }, [epg, groupName, channelName, liveIdx]);

  async function openPrograms(channel: { name: string; 'tvg-id'?: string; 'tvg-name'?: string }) {
    const name = (channel.name || '').trim();
    if (!name) return;
    const groupList = groups.map((g) => ({
      group: String(g.group || '').trim(),
      channels: g.channels.map((c) => ({
        name: String(c.name || '').trim(),
        tvgId: String(c['tvg-id'] || '').trim(),
        tvgName: String(c['tvg-name'] || '').trim(),
      })).filter((c) => !!c.name),
    })).filter((g) => !!g.group && g.channels.length > 0);
    try {
      await ipcInvoke('epg:openWindow', {
        channelName: name, tvgId: (channel['tvg-id'] || '').trim(), tvgName: (channel['tvg-name'] || '').trim(),
        groups: groupList, currentGroup: groupName,
      });
    } catch (e) { /* ignore */ }
  }

  const epgStatusText = epgStatus === 'loading' ? '加载中…' : epgStatus === 'ok' ? `命中 ${Object.keys(epg).length} 键` : epgStatus === 'empty' ? '无节目单' : epgStatus === 'error' ? '失败' : '未触发';

  return (
    <>
      <div className="topbar">
        <select value={liveIdx} onChange={(e) => pickLive(Number(e.target.value))} disabled={loading}>
          {lives.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
        </select>
        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading ? '加载中…' : `${groups.length} 组`}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          订阅 {subEnabled}/{subCount}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          EPG：{epgStatusText}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          方式：{playMode === 'vod' ? '点播' : '直播'}{playModeReason ? `（${playModeReason}）` : ''}
        </span>

        <button
          className="btn"
          style={{ marginLeft: 12, fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}
          onClick={() => setPlayerEngine((p) => (p === 'mpv' ? 'web' : 'mpv'))}
          title="切换播放器内核"
        >
          切换播放器 ({playerEngine === 'mpv' ? 'MPV' : 'Web'})
        </button>
      </div>

      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {groups.map((g) => (
            <div key={g.group} className={`nav-item ${g.group === groupName ? 'active' : ''}`}
              onClick={() => { setGroupName(g.group); if (g.channels.length) pickChannel(g, g.channels[0].name, 0, groups); }}>
              {g.group} <span className="muted">({g.channels.length})</span>
            </div>
          ))}
        </div>
        <div className="right">
          {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
          {curGroup ? (
            <>
              <div className="row" style={{ marginBottom: 10, maxHeight: 180, overflow: 'auto' }}>
                {curGroup.channels.map((c) => (
                  <span key={c.name} className={`tag ${c.name === channelName ? 'active' : ''}`}
                    onClick={() => pickChannel(curGroup, c.name, 0, groups)} onDoubleClick={() => openPrograms(c)}>
                    {c.name}
                  </span>
                ))}
              </div>
              {lines.length > 1 && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">线路：</span>
                  {lines.map((l) => (
                    <span key={l.index} className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`}
                      onClick={() => { setLineIdx(l.index - 1); setPlayUrl(l.url); saveLiveMem({ liveIdx, groupName, channelName, lineIdx: l.index - 1 }); }}>
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {curEpg && (curEpg.current || curEpg.next) && curChannel && (
                <div className="live-epg" onClick={() => openPrograms(curChannel)} style={{ cursor: 'pointer' }}>
                  {curEpg.current && <span className="live-epg-now"><b>正在播</b> {curEpg.current.start}~{curEpg.current.end} {curEpg.current.title || '（无标题）'}</span>}
                  {curEpg.next && <span className="muted"><b>下一档</b> {curEpg.next.start} {curEpg.next.title || '（无标题）'}</span>}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>📺</span>
                </div>
              )}

              {playUrl ? (
                <div className="live-player" style={{ position: 'relative' }}>
                  {playbackUrl ? (
                    // ★ key 包含引擎名：切换引擎时强制重挂载，彻底丢弃坏掉的播放器实例
                    <PlayerErrorBoundary
                      key={`boundary_${playerEngine}_${playbackUrl}__${reconnectKey}`}
                      onFatal={handleBoundaryFatal}
                    >
                      {playerEngine === 'mpv' ? (
                        <LiveMpvPlayer
                          key={`mpv_${playbackUrl}__${reconnectKey}`}
                          url={playbackUrl}
                          onModeDetected={handleModeDetected}
                          onError={handlePlayerError}
                        />
                      ) : (
                        <LiveWebPlayer
                          key={`web_${playbackUrl}__${reconnectKey}`}
                          url={playbackUrl}
                          onError={handlePlayerError}
                        />
                      )}
                    </PlayerErrorBoundary>
                  ) : (
                    <div className="empty" style={{ width: '100%', height: '100%' }}>加载中…</div>
                  )}
                  {reconnectMsg && (
                    <div style={{
                      position: 'absolute', top: 12, left: 12, padding: '6px 12px', borderRadius: 6,
                      background: 'rgba(0,0,0,0.7)', color: '#ffb74d', fontSize: 13,
                      pointerEvents: bothFailed ? 'auto' : 'none', zIndex: 20,
                    }}>
                      <span>{reconnectMsg}</span>
                      {bothFailed && (
                        <button
                          className="btn"
                          style={{ marginLeft: 10, padding: '2px 10px', cursor: 'pointer', fontSize: 12 }}
                          onClick={retryPlayback}
                        >
                          重试
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty">无播放地址</div>
              )}
            </>
          ) : (
            <div className="empty">{groups.length ? '选择左侧分组' : '无直播（请先导入含 lives 的配置）'}</div>
          )}
        </div>
      </div>
    </>
  );
}
