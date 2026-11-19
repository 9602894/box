// src/renderer/live/livePlaybackProbe.ts
// 移植自修狗TV core/player/hls_playlist_probe.dart：
// 只读清单判定「点播 / 直播」，失败静默回退 live，绝不挡起播。
// 注意：renderer 侧用 fetch，受 CORS 限制；读不到 body 会回退 live。
// 不走 DoH / 系统代理（桌面端 HttpClientFactory 的能力在浏览器不可用）。

export type PlaybackMode = 'live' | 'vod';

export type PlaybackModeSource =
  | 'defaultMode'
  | 'defaultLive'
  | 'directDialog'
  | 'container'
  | 'probe'
  | 'manual'
  | 'remembered'
  | 'escapeHatch';

export interface HlsVariant {
  uri: string;
  bandwidth: number;
}

export interface HlsPlaylistSignals {
  isMaster: boolean;
  hasEndList: boolean;
  playlistType: string | null;
  mediaSequence: number;
  totalDurationMs: number;
  segmentCount: number;
  variants: HlsVariant[];
}

export interface HlsPlaybackDecision {
  mode: PlaybackMode;
  reason: string;
  suspicious: boolean;
  contentDurationMs?: number;
}

export interface HlsProbeResult {
  mode: PlaybackMode;
  reason: string;
  suspicious: boolean;
  contentDurationMs?: number;
  requests: number;
  statusCode?: number;
  failed: boolean;
  fromCache: boolean;
}

export interface DirectPlaybackDecision {
  mode: PlaybackMode;
  source: PlaybackModeSource;
  reason?: string;
  suspicious: boolean;
}

export class HlsProbeHttpError extends Error {
  constructor(public readonly statusCode: number) {
    super(`HLS 清单请求返回 HTTP ${statusCode}`);
    this.name = 'HlsProbeHttpError';
  }
}

class ProbeTimeoutError extends Error {
  constructor() {
    super('HLS 探测超时');
    this.name = 'ProbeTimeoutError';
  }
}

// --- URL 层判定（不联网） ---------------------------------------------------

const LIVE_ONLY_SCHEMES = new Set(['rtmp', 'rtmps', 'rtsp', 'rtsps', 'udp', 'rtp']);

// 明确是点播容器的扩展名。注意：这里**不含 flv**——这份代码把 .flv 当 HTTP-FLV
// 直播流用 mpegts.js，若按修狗TV 原表把 .flv 判成 vod 会让直播流 isLive=false。
const VOD_CONTAINER_EXTENSIONS = new Set(['mp4', 'mkv', 'mov', 'webm', 'm4v', 'avi']);

const HLS_PLAYLIST_EXTENSIONS = new Set(['m3u8', 'm3u']);

function pathExtension(path: string): string {
  const p = path.toLowerCase();
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  if (dot <= slash || dot === p.length - 1) return '';
  return p.substring(dot + 1);
}

/** URL 层的点播提示：file:// 与明确的容器扩展名 → vod。 */
export function containerHintForUrl(url: string): PlaybackMode | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'file:') return 'vod';
  if (VOD_CONTAINER_EXTENSIONS.has(pathExtension(u.pathname))) return 'vod';
  return null;
}

/** 是否值得联网探测：仅 http(s) 且路径以 .m3u8 / .m3u 结尾。 */
export function isHlsProbeCandidate(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (!u.host) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return HLS_PLAYLIST_EXTENSIONS.has(pathExtension(u.pathname));
}

export function schemeOf(url: string): string {
  try {
    return new URL(url.trim()).protocol.replace(':', '').toLowerCase();
  } catch {
    return '';
  }
}

// --- 纯解析 -----------------------------------------------------------------

export function looksLikeHlsPlaylist(content: string): boolean {
  const head = content.trimStart();
  if (head.startsWith('#EXTM3U')) return true;
  return head.includes('#EXT-X-');
}

function bandwidthOf(line: string): number {
  const m = /(?:^|[:,])BANDWIDTH=(\d+)/i.exec(line);
  const v = m ? Number.parseInt(m[1], 10) : Number.NaN;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 解析清单头部的判定信号（纯函数，不联网、不抛异常）。 */
export function parseHlsSignals(content: string, baseUrl: string): HlsPlaylistSignals {
  let isMasterTag = false;
  let hasEndList = false;
  let playlistType: string | null = null;
  let mediaSequence = 0;
  let totalMs = 0;
  let segmentCount = 0;
  const variants: HlsVariant[] = [];
  let pendingBandwidth: number | null = null;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    base = new URL('http://invalid/');
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        isMasterTag = true;
        pendingBandwidth = bandwidthOf(line);
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        hasEndList = true;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        const value = line
          .substring('#EXT-X-PLAYLIST-TYPE:'.length)
          .split(',')[0]
          .trim()
          .toUpperCase();
        if (value) playlistType = value;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const value = line.substring('#EXT-X-MEDIA-SEQUENCE:'.length).trim();
        mediaSequence = Number.parseInt(value.split(',')[0].trim(), 10) || 0;
      } else if (line.startsWith('#EXTINF:')) {
        segmentCount++;
        const value = line.substring('#EXTINF:'.length).split(',')[0].trim();
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds) && seconds > 0) {
          totalMs += Math.round(seconds * 1000);
        }
      }
      continue;
    }
    if (pendingBandwidth !== null) {
      try {
        variants.push({ uri: new URL(line, base).toString(), bandwidth: pendingBandwidth });
      } catch {
        /* 无效变体地址忽略 */
      }
      pendingBandwidth = null;
    }
  }

  variants.sort((a, b) => {
    const left = a.bandwidth > 0 ? a.bandwidth : Number.MAX_SAFE_INTEGER;
    const right = b.bandwidth > 0 ? b.bandwidth : Number.MAX_SAFE_INTEGER;
    return left - right;
  });

  return {
    isMaster: isMasterTag && variants.length > 0,
    hasEndList,
    playlistType,
    mediaSequence,
    totalDurationMs: totalMs,
    segmentCount,
    variants,
  };
}

/** 判定表（自上而下，命中即返回；signals 为 null 表示探测失败）。 */
export function decidePlaybackMode(signals: HlsPlaylistSignals | null): HlsPlaybackDecision {
  if (!signals) return { mode: 'live', reason: 'unknown', suspicious: false };
  if (signals.hasEndList) {
    return { mode: 'vod', reason: 'endlist', suspicious: false, contentDurationMs: signals.totalDurationMs };
  }
  if (signals.playlistType === 'VOD') {
    return { mode: 'vod', reason: 'playlist-type-vod', suspicious: false, contentDurationMs: signals.totalDurationMs };
  }
  if (signals.playlistType === 'EVENT') {
    return { mode: 'live', reason: 'event', suspicious: false, contentDurationMs: signals.totalDurationMs };
  }
  if (signals.mediaSequence > 0) {
    return { mode: 'live', reason: 'sliding-window', suspicious: false, contentDurationMs: signals.totalDurationMs };
  }
  if (signals.totalDurationMs >= 10 * 60 * 1000) {
    return { mode: 'live', reason: 'long-window-unfinished', suspicious: true, contentDurationMs: signals.totalDurationMs };
  }
  return { mode: 'live', reason: 'unknown', suspicious: false, contentDurationMs: signals.totalDurationMs };
}

// --- 抓取 -------------------------------------------------------------------

async function fetchPlaylistHop(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  externalSignal?: AbortSignal,
): Promise<{ content: string; finalUrl: string; statusCode: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (externalSignal) externalSignal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
      mode: 'cors',
      credentials: 'omit',
    });
    if (res.status < 200 || res.status >= 300) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      throw new HlsProbeHttpError(res.status);
    }
    const finalUrl = res.url || url;
    if (!res.body) {
      const text = await res.text();
      return { content: text.slice(0, maxBytes), finalUrl, statusCode: res.status };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remain = maxBytes - total;
      if (value.length <= remain) {
        chunks.push(value);
        total += value.length;
      } else {
        chunks.push(value.subarray(0, remain));
        total += remain;
        break;
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.length;
    }
    const text = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
    return { content: text, finalUrl, statusCode: res.status };
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

// --- 探针 -------------------------------------------------------------------

export class HlsPlaylistProbe {
  private readonly cache = new Map<string, HlsProbeResult>();

  constructor(
    private readonly opts: {
      budgetMs?: number;
      connectionTimeoutMs?: number;
      maxBytes?: number;
      maxVariants?: number;
      cacheSize?: number;
    } = {},
  ) {}

  private get budgetMs() { return this.opts.budgetMs ?? 4000; }
  private get connectionTimeoutMs() { return this.opts.connectionTimeoutMs ?? 3000; }
  private get maxBytes() { return this.opts.maxBytes ?? 512 * 1024; }
  private get maxVariants() { return this.opts.maxVariants ?? 2; }
  private get cacheSize() { return this.opts.cacheSize ?? 32; }

  /** 探测直链播放方式；永不抛异常。 */
  async probe(
    url: string,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<HlsProbeResult> {
    const trimmed = url.trim();
    let uri: URL;
    try {
      uri = new URL(trimmed);
    } catch {
      return this.fail('probe-invalid-url');
    }
    if (!uri.host) return this.fail('probe-invalid-url');

    const scheme = uri.protocol.replace(':', '').toLowerCase();
    if (LIVE_ONLY_SCHEMES.has(scheme)) return this.ok('live', 'protocol');
    if (scheme === 'file') return this.ok('vod', 'local-file');
    const container = containerHintForUrl(trimmed);
    if (container) return this.ok(container, 'container');
    if (!isHlsProbeCandidate(trimmed)) return this.ok('live', 'not-hls');

    const cacheKey = trimmed.split('#')[0];
    const cached = this.cache.get(cacheKey);
    if (cached) return { ...cached, requests: 0, fromCache: true };

    const deadline = Date.now() + this.budgetMs;
    let requests = 0;
    let lastStatus: number | undefined;

    const fetchOne = async (target: string) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ProbeTimeoutError();
      requests++;
      const hopTimeout = Math.min(remaining, this.connectionTimeoutMs);
      const res = await fetchPlaylistHop(target, headers, hopTimeout, this.maxBytes, signal);
      lastStatus = res.statusCode;
      return res;
    };

    try {
      const root = await fetchOne(trimmed);
      if (!looksLikeHlsPlaylist(root.content)) {
        return this.remember(cacheKey, {
          mode: 'live',
          reason: 'probe-invalid-content',
          suspicious: false,
          requests,
          statusCode: lastStatus,
          failed: true,
          fromCache: false,
        });
      }
      let signals = parseHlsSignals(root.content, root.finalUrl);
      if (signals.isMaster) {
        let media: HlsPlaylistSignals | null = null;
        for (const variant of signals.variants.slice(0, this.maxVariants)) {
          try {
            const r = await fetchOne(variant.uri);
            if (!looksLikeHlsPlaylist(r.content)) continue;
            const parsed = parseHlsSignals(r.content, r.finalUrl);
            if (parsed.isMaster) continue;
            media = parsed;
            break;
          } catch (e) {
            if (e instanceof HlsProbeHttpError) {
              lastStatus = e.statusCode;
              continue;
            }
            throw e;
          }
        }
        if (!media) {
          return this.remember(cacheKey, {
            mode: 'live',
            reason: 'unknown',
            suspicious: false,
            requests,
            statusCode: lastStatus,
            failed: false,
            fromCache: false,
          });
        }
        signals = media;
      }
      const d = decidePlaybackMode(signals);
      return this.remember(cacheKey, {
        mode: d.mode,
        reason: d.reason,
        suspicious: d.suspicious,
        contentDurationMs: d.contentDurationMs,
        requests,
        statusCode: lastStatus,
        failed: false,
        fromCache: false,
      });
    } catch (e) {
      if (e instanceof HlsProbeHttpError) {
        return this.remember(cacheKey, {
          mode: 'live',
          reason: `probe-http-${e.statusCode}`,
          suspicious: false,
          requests,
          statusCode: e.statusCode,
          failed: true,
          fromCache: false,
        });
      }
      const name = (e as Error)?.name;
      if (e instanceof ProbeTimeoutError || name === 'AbortError') {
        return this.fail('probe-timeout', requests, lastStatus);
      }
      return this.fail('probe-failed', requests, lastStatus);
    }
  }

  private ok(mode: PlaybackMode, reason: string): HlsProbeResult {
    return { mode, reason, suspicious: false, requests: 0, failed: false, fromCache: false };
  }

  private fail(reason: string, requests = 0, statusCode?: number): HlsProbeResult {
    return { mode: 'live', reason, suspicious: false, requests, statusCode, failed: true, fromCache: false };
  }

  /** 只缓存「有结论」的结果：失败不缓存，避免一次抖动把地址钉死在直播模式。 */
  private remember(key: string, result: HlsProbeResult): HlsProbeResult {
    if (!result.failed) {
      this.cache.set(key, result);
      while (this.cache.size > this.cacheSize) {
        const first = this.cache.keys().next().value;
        if (first === undefined) break;
        this.cache.delete(first);
      }
    }
    return result;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/** 共享探针实例：整个直播页共用一个内存缓存（进程内，不落盘）。 */
export const sharedHlsPlaylistProbe = new HlsPlaylistProbe();

// --- 模式决策 ---------------------------------------------------------------

/** 直链播放方式的唯一决策点：manual > container > remembered > probe > live。 */
export function resolveDirectPlaybackMode(args: {
  url: string;
  manual?: PlaybackMode | null;
  containerHint?: PlaybackMode | null;
  remembered?: PlaybackMode | null;
  probe?: HlsProbeResult | null;
}): DirectPlaybackDecision {
  const hint = args.containerHint ?? containerHintForUrl(args.url);
  const nonsensicalManualLive = args.manual === 'live' && hint === 'vod';
  if (args.manual && !nonsensicalManualLive) {
    return { mode: args.manual, source: 'manual', reason: 'manual', suspicious: false };
  }
  if (hint) {
    return { mode: hint, source: 'container', reason: 'container', suspicious: false };
  }
  if (args.remembered) {
    return { mode: args.remembered, source: 'remembered', reason: 'remembered', suspicious: false };
  }
  if (args.probe) {
    return {
      mode: args.probe.mode,
      source: 'probe',
      reason: args.probe.reason,
      suspicious: args.probe.suspicious,
    };
  }
  return { mode: 'live', source: 'defaultLive', reason: 'default-live', suspicious: false };
}
