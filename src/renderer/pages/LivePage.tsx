// src/renderer/pages/LivePage.tsx
import { useEffect, useRef, useState, useCallback } from 'react';
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

// 注册 MPV 自定义元素
defineMpvVideoElement();

declare global {
  namespace JSX {
    interface IntrinsicElements {
      // ★ 不要声明 mode，防止 React 强行赋值
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

class StreamDetector {
  static detectByUrl(url: string): MediaKind {
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8')) return 'hls';
    if (lower.includes('.flv')) return 'flv';
    if (/\.ts(\?|#|$)/.test(lower)) return 'ts';
    if (/\.(mp4|mkv|mov|webm|m4v|avi)(\?|#|$)/.test(lower)) return 'native';
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
// 播放器 1：MPV 播放器
// ----------------------------------------------------------------------
function LiveMpvPlayer({
  url, onModeDetected, onError,
}: {
  url: string;
  onModeDetected?: (mode: PlaybackMode, reason: string) => void;
  onError?: (msg: string) => void;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!el || !url) return;
    let disposed = false;
    const mpvEl = el as any;

    if (typeof mpvEl.setAttribute === 'function') {
      mpvEl.setAttribute('mode', 'webgl');
    }

    (async () => {
      try {
        const { mode, reason } = await detectPlaybackSource(url);
        if (disposed) return;
        onModeDetected?.(mode, reason);
      } catch {
        if (!disposed) onModeDetected?.('live', 'probe-failed');
      }
      if (disposed) return;

      try {
        if (typeof mpvEl.open === 'function') {
          await mpvEl.open(url);
        } else {
          mpvEl.src = url;
        }
        if (disposed) return;
        if (typeof mpvEl.play === 'function') {
          await mpvEl.play();
        }
      } catch (err) {
        if (!disposed) {
          console.error('[mpv] live open failed', err);
          onError?.(`MPV 播放失败: ${(err as Error).message || '请尝试切换频道或线路'}`);
        }
      }
    })();

    return () => {
      disposed = true;
      try { mpvEl.stop(); } catch { /* ignore */ }
      // ★ 绝对不要调用 destroy()，否则会触发 not attached 报错
    };
  }, [url, el, onModeDetected, onError]);

  return (
    <mpv-video
      ref={(node) => setEl(node)}
      style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
    />
  );
}

// ----------------------------------------------------------------------
// 播放器 2：Web 播放器 (原生 video + hls.js)
// ----------------------------------------------------------------------
function LiveWebPlayer({ url, onError }: { url: string; onError?: (msg: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;

    let hls: Hls | null = null;

    const play = () => {
      video.play().catch((err) => {
        if (err.name !== 'AbortError') {
          console.warn('[WebPlayer] 自动播放被拦截:', err);
        }
      });
    };

    if (url.includes('.m3u8') && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, play);
      
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls?.startLoad(); break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls?.recoverMediaError(); break;
            default:
              onError?.(`Web 播放失败: ${data.details}`); break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener('loadedmetadata', play);
    } else {
      video.src = url;
      play();
    }

    return () => {
      if (hls) hls.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [url, onError]);

  return (
    <video
      ref={videoRef}
      controls
      autoPlay
      playsInline
      style={{ width: '100%', height: '100%', background: '#000', outline: 'none' }}
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
  const [playerEngine, setPlayerEngine] = useState<'mpv' | 'web'>('mpv');

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
                    playerEngine === 'mpv' ? (
                      <LiveMpvPlayer
                        key={`mpv_${playbackUrl}__${reconnectKey}`}
                        url={playbackUrl}
                        onModeDetected={(mode, reason) => { setPlayMode(mode); setPlayModeReason(reason); }}
                        onError={handlePlayerError}
                      />
                    ) : (
                      <LiveWebPlayer
                        key={`web_${playbackUrl}__${reconnectKey}`}
                        url={playbackUrl}
                        onError={handlePlayerError}
                      />
                    )
                  ) : (
                    <div className="empty" style={{ width: '100%', height: '100%' }}>加载中…</div>
                  )}
                  {reconnectMsg && (
                    <div style={{
                      position: 'absolute', top: 12, left: 12, padding: '6px 12px', borderRadius: 6,
                      background: 'rgba(0,0,0,0.7)', color: '#ffb74d', fontSize: 13, pointerEvents: 'none', zIndex: 20,
                    }}>{reconnectMsg}</div>
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
