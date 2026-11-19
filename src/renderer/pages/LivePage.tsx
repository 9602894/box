// src/renderer/pages/LivePage.tsx
// ★ 2026-11-13（用户要求）：网络直播源更新时的精细 diff —— 不无脑重置播放。
//   · 名字变了、URL 没变 → 只刷新 groups / 频道列表，playUrl 不动，播放继续；
//   · 当前频道 URL 变了 → setPlayUrl(新地址)，LiveVideoPlayer 因 key 变化重挂，用新地址播；
//   · 当前频道在新源里找不到 / 订阅源更新失败 → 保留旧 groups + 旧 playUrl，继续播。
//   · 订阅更新后 loadLive 用 { forceRefresh: true } 绕过 5 分钟内存缓存，groups 一换 →
//     下方 [groups] 依赖的 EPG useEffect 自动重新拉 EPG，与新源保持一致。
//
// ★ 2026-11-19：接入移植自修狗TV 的直播链接解析（livePlaybackProbe.ts）：
//   容器扩展名 → 点播；.m3u8/.m3u → 只读清单探测判定点播/直播；失败静默回退直播。
//
// ★ 2026-11-20：直播播放器切换为 libmpv（electron-mpv-video 的 <mpv-video>）。
//   · 点播播放器不改，本文件只管直播；
//   · hls.js / mpegts.js 的协议分发与错误恢复不再需要，交给 libmpv；
//   · detectPlaybackSource 仅用于 topbar 展示「点播/直播」，不参与解码决策；
//   · 前置条件：主进程 createMpvMain().attachWindow(win)，preload exposeMpvApi()。
import { useEffect, useRef, useState, useCallback } from 'react';
import { client } from '../api/client';
import { ipcInvoke } from '../api/ipc';
import type {
  LiveGroup,
  LiveBean,
  LiveEpgEntry,
  EpgChannelRef,
  LiveSubscription,
} from '../../shared/types';
import { splitLine } from '../../engine/live/LiveUtils';
import {
  sharedHlsPlaylistProbe,
  containerHintForUrl,
  isHlsProbeCandidate,
  resolveDirectPlaybackMode,
  type PlaybackMode,
} from '../live/livePlaybackProbe';
import { defineMpvVideoElement } from 'electron-mpv-video/renderer';

// 注册 <mpv-video> 自定义元素（多次调用安全）
defineMpvVideoElement();

// TypeScript 不识别自定义元素，补一份最小声明
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'mpv-video': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        mode?: 'shared-texture' | 'webgl' | 'canvas2d';
      };
    }
  }
}

// ---- 频道选择记忆 ----
const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try { return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem; } catch { return {}; }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

type EpgStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

// ★ 与 main/LiveSubscriptionManager.ts 里的 LiveSubChangedPayload 对齐
interface LiveSubChangedPayload {
  updated: boolean;
  updatedIds: string[];
  failedIds: string[];
  reason: 'startup' | 'manual' | 'crud';
}

type MediaKind = 'hls' | 'flv' | 'ts' | 'native' | 'unknown';

class StreamDetector {
  /** 纯 URL 判断，不联网。 */
  static detectByUrl(url: string): MediaKind {
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8')) return 'hls';
    if (lower.includes('.flv')) return 'flv';
    if (/\.ts(\?|#|$)/.test(lower)) return 'ts';
    if (/\.(mp4|mkv|mov|webm|m4v|avi)(\?|#|$)/.test(lower)) return 'native';
    return 'unknown';
  }
}

/**
 * ★ 直播链接解析入口：仅用于 UI 展示「播放方式」。
 * libmpv 自己会按协议解码，不需要这里再决定用哪个引擎。
 */
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
  // 无扩展名：默认按直播起播，UI 标注 default-live
  return { kind: 'unknown', mode: 'live', reason: 'default-live' };
}

/**
 * ★ 直播播放器：libmpv（electron-mpv-video 的 <mpv-video>）。
 *
 * 与旧实现的差异：
 * - 不再按 URL 分发 hls.js / mpegts.js / 原生 video，HLS/RTMP/FLV/TS 全部由 libmpv 原生处理；
 * - 不再监听 hls.js 的 MANIFEST_PARSED / ERROR，就绪由 el.play() 的 Promise 反馈；
 * - 断流恢复交给 libmpv 内部的 stream-lavf-o（reconnect / seg_max_retry），
 *   宿主保留 doReconnect 作为兜底（点击「重新加载」或外部触发）。
 */
function LiveVideoPlayer({
  url,
  onModeDetected,
  onError,
}: {
  url: string;
  onModeDetected?: (mode: PlaybackMode, reason: string) => void;
  onError?: (msg: string) => void;
}) {
  const videoRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = videoRef.current as any;
    if (!el || !url) return;

    let disposed = false;

    (async () => {
      // 仅用于 UI 展示「播放方式」，不影响 libmpv 解码决策
      try {
        const { mode, reason } = await detectPlaybackSource(url);
        if (disposed) return;
        onModeDetected?.(mode, reason);
      } catch {
        // 探测失败不阻塞起播；按直播标注
        if (!disposed) onModeDetected?.('live', 'probe-failed');
      }

      if (disposed) return;
      try {
        // libmpv 原生处理 HLS / RTMP / HTTP-FLV / TS
        await el.open(url);
        if (disposed) return;
        await el.play();
      } catch (err) {
        if (!disposed) {
          console.error('[mpv] live open failed', err);
          onError?.('直播播放失败，请尝试切换频道或线路');
        }
      }
    })();

    return () => {
      disposed = true;
      try { el.stop(); } catch { /* ignore */ }
      try { el.destroy(); } catch { /* ignore */ }
    };
  }, [url]);

  return (
    <mpv-video
      ref={videoRef as any}
      mode="shared-texture"
      style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
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

  // ★ 播放方式识别结果（来自 livePlaybackProbe，仅 UI 展示）
  const [playMode, setPlayMode] = useState<PlaybackMode>('live');
  const [playModeReason, setPlayModeReason] = useState('');

  // ★ 把「当前播放上下文」用 ref 存一份，供订阅更新回调读取
  const playStateRef = useRef({ liveIdx, groupName, channelName, lineIdx, playUrl });
  useEffect(() => {
    playStateRef.current = { liveIdx, groupName, channelName, lineIdx, playUrl };
  }, [liveIdx, groupName, channelName, lineIdx, playUrl]);

  useEffect(() => {
    if (!playUrl) { setPlaybackUrl(''); return; }
    setPlaybackUrl(playUrl);
    reconnectCountRef.current = 0;
    lastReconnectAtRef.current = 0;
    setReconnectMsg('');
  }, [playUrl]);

  // ★ 兜底重连：libmpv 内部已有 stream-lavf-o 重连，这里用于「连续失败后手动重载」
  const doReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAtRef.current < 3000) return;
    lastReconnectAtRef.current = now;
    reconnectCountRef.current += 1;
    const n = reconnectCountRef.current;
    if (n > MAX_RECONNECT) {
      setReconnectMsg(`已连续重连 ${MAX_RECONNECT} 次仍失败，请切换线路`);
      return;
    }
    setReconnectMsg(`重新加载中…（第 ${n} 次）`);
    setReconnectKey((k) => k + 1);
    window.setTimeout(() => {
      setReconnectMsg((cur) => (cur.startsWith('重新加载中') ? '' : cur));
    }, 3000);
  }, []);

  const handlePlayerError = useCallback((msg: string) => {
    if (msg) setReconnectMsg(msg);
  }, []);

  const reloadLives = useCallback(async () => {
    try {
      await client.cfgGet();
      const m = await client.liveMeta();
      setLives(m);
      const idx = liveIdx < m.length ? liveIdx : 0;
      setLiveIdx(idx);
      if (m.length && idx !== liveIdx) {
        await loadLiveInternal(idx, m);
      }
    } catch (e) {
      console.warn('[Live] reload lives 失败：', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

  /**
   * ★ 加 `forceRefresh` 参数 —— 订阅源更新后调用时传 true，
   *   绕过 SpiderHost.loadLive 的 5 分钟内存缓存，拿到真实新 groups + 新 EPG URL。
   */
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
        setGroups([]);
        setGroupName('');
        setChannelName('');
        setPlayUrl('');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ★ 订阅源内容有变化 → 精细 diff，不做无脑重置。
   */
  const applySubscriptionUpdate = useCallback(async () => {
    const cur = playStateRef.current;
    try {
      const newMeta = await client.liveMeta();
      if (!Array.isArray(newMeta) || newMeta.length === 0) {
        console.warn('[Live] 订阅更新后线路列表为空，保留旧列表与旧地址继续播放');
        return;
      }
      setLives(newMeta);

      const idx = cur.liveIdx < newMeta.length ? cur.liveIdx : 0;
      if (idx !== cur.liveIdx) setLiveIdx(idx);

      const r = await client.loadLive(idx, { forceRefresh: true });
      const newGroups = r.groups;

      if (!cur.groupName || !cur.channelName) {
        setGroups(newGroups);
        return;
      }

      const curGroup = newGroups.find((g) => g.group === cur.groupName);
      const curChannel = curGroup?.channels.find((c) => c.name === cur.channelName);

      if (!curGroup || !curChannel) {
        console.info('[Live] 当前频道已从更新后的源中消失，保留旧列表与旧地址继续播放');
        return;
      }

      setGroups(newGroups);

      const newLine = splitLine(curChannel.urls[cur.lineIdx] || curChannel.urls[0], cur.lineIdx + 1);
      const newUrl = newLine.url || '';
      if (newUrl && newUrl !== cur.playUrl) {
        console.info('[Live] 当前频道地址已更新，使用新地址重播');
        setPlayUrl(newUrl);
      } else {
        console.info('[Live] 当前频道地址未变，仅刷新频道列表');
      }
    } catch (e) {
      console.warn('[Live] 处理订阅更新失败（保留旧播放继续）：', e);
    }
  }, []);

  // ★ 监听主进程广播的订阅更新（带 payload），做精细 diff
  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:subscriptions-changed', (payload?: LiveSubChangedPayload) => {
      void loadSubStatus();

      if (!payload) {
        void reloadLives();
        return;
      }

      if (!payload.updated) {
        if (payload.reason === 'crud') void reloadLives();
        return;
      }

      void applySubscriptionUpdate();
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadSubStatus, reloadLives, applySubscriptionUpdate]);

  // ★ 监听主进程广播的「直播源已变更」→ 自动重新加载
  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:changed', (payload: { index?: number; name?: string; replaced?: boolean }) => {
      console.log('[Live] 收到 live:changed 广播：', payload);
      void (async () => {
        try {
          const m = await client.liveMeta();
          setLives(m);
          const idx = liveIdx < m.length ? liveIdx : 0;
          if (idx !== liveIdx) setLiveIdx(idx);
          if (m.length) {
            await loadLiveInternal(idx, m);
          }
        } catch (e) {
          console.warn('[Live] live:changed 处理后失败：', e);
        }
      })();
    });
    return () => { if (typeof off === 'function') off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const r: EpgChannelRef = {
          tvgId: c['tvg-id'],
          tvgName: c['tvg-name'],
          name: c.name,
          epg: c.epg,
        };
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
      setEpg({});
      setEpgStatus('error');
      console.warn('[EPG] 加载失败：', e);
    }
  }

  // ★ 订阅更新后 groups 一换，这里会自动用新 EPG URL 重拉 EPG
  useEffect(() => {
    if (!groups.length) return;
    void refreshEpg(liveIdx, groups, channelName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg, groupName, channelName, liveIdx]);

  async function openPrograms(channel: { name: string; 'tvg-id'?: string; 'tvg-name'?: string }) {
    const name = (channel.name || '').trim();
    if (!name) return;
    const groupList = groups
      .map((g) => ({
        group: String(g.group || '').trim(),
        channels: g.channels
          .map((c) => ({
            name: String(c.name || '').trim(),
            tvgId: String(c['tvg-id'] || '').trim(),
            tvgName: String(c['tvg-name'] || '').trim(),
          }))
          .filter((c) => !!c.name),
      }))
      .filter((g) => !!g.group && g.channels.length > 0);
    try {
      await ipcInvoke('epg:openWindow', {
        channelName: name,
        tvgId: (channel['tvg-id'] || '').trim(),
        tvgName: (channel['tvg-name'] || '').trim(),
        groups: groupList,
        currentGroup: groupName,
      });
    } catch (e) {
      console.warn('[EPG] 打开节目单窗口失败', e);
    }
  }

  const epgStatusText =
    epgStatus === 'loading' ? '加载中…'
      : epgStatus === 'ok' ? `命中 ${Object.keys(epg).length} 键`
        : epgStatus === 'empty' ? '无节目单'
          : epgStatus === 'error' ? '失败（看日志）'
            : '未触发';

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
        {/* ★ 播放方式标识：让用户知道为什么进度条能用/不能用 */}
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          播放方式：{playMode === 'vod' ? '点播' : '直播'}
          {playModeReason ? `（${playModeReason}）` : ''}
        </span>
      </div>

      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {groups.map((g) => (
            <div
              key={g.group}
              className={`nav-item ${g.group === groupName ? 'active' : ''}`}
              onClick={() => {
                setGroupName(g.group);
                if (g.channels.length) pickChannel(g, g.channels[0].name, 0, groups);
              }}
            >
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
                  <span
                    key={c.name}
                    className={`tag ${c.name === channelName ? 'active' : ''}`}
                    onClick={() => pickChannel(curGroup, c.name, 0, groups)}
                    onDoubleClick={() => openPrograms(c)}
                    title="双击查看完整节目单（独立窗口，可拖到屏幕任意位置）"
                  >
                    {c.name}
                  </span>
                ))}
              </div>
              {lines.length > 1 && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">线路：</span>
                  {lines.map((l) => (
                    <span
                      key={l.index}
                      className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`}
                      onClick={() => {
                        setLineIdx(l.index - 1);
                        setPlayUrl(l.url);
                        saveLiveMem({ liveIdx, groupName, channelName, lineIdx: l.index - 1 });
                      }}
                    >
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {curEpg && (curEpg.current || curEpg.next) && curChannel && (
                <div
                  className="live-epg"
                  onClick={() => openPrograms(curChannel)}
                  style={{ cursor: 'pointer' }}
                  title="点击查看完整节目单（独立窗口，可拖到屏幕任意位置）"
                >
                  {curEpg.current && (
                    <span className="live-epg-now">
                      <b>正在播</b> {curEpg.current.start}~{curEpg.current.end} {curEpg.current.title || '（无标题）'}
                    </span>
                  )}
                  {curEpg.next && (
                    <span className="muted">
                      <b>下一档</b> {curEpg.next.start} {curEpg.next.title || '（无标题）'}
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>📺</span>
                </div>
              )}

              {playUrl ? (
                <div className="live-player" style={{ position: 'relative' }}>
                  {playbackUrl ? (
                    <LiveVideoPlayer
                      key={`${playbackUrl}__${reconnectKey}`}
                      url={playbackUrl}
                      onModeDetected={(mode, reason) => {
                        setPlayMode(mode);
                        setPlayModeReason(reason);
                      }}
                      onError={handlePlayerError}
                    />
                  ) : (
                    <div className="empty" style={{ width: '100%', height: '100%' }}>加载中…</div>
                  )}
                  {reconnectMsg && (
                    <div
                      style={{
                        position: 'absolute', top: 12, left: 12,
                        padding: '6px 12px', borderRadius: 6,
                        background: 'rgba(0,0,0,0.7)', color: '#ffb74d', fontSize: 13,
                        pointerEvents: 'none', zIndex: 20,
                      }}
                    >{reconnectMsg}</div>
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
