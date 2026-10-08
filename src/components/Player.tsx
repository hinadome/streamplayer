import { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import * as dashjs from 'dashjs';
import type { PlayerStats, StreamFormat } from '../../shared/types';
import { detectFormat, encodeHeaders, isAdaptive, proxyUrl } from '../lib/stream';

interface Props {
  url: string;
  format: StreamFormat;
  headers: Record<string, string>;
  ip: string;
  sessionId: string;
  onStats: (stats: PlayerStats) => void;
  onError: (msg: string) => void;
}

const EMPTY_STATS: PlayerStats = {
  engine: null, isLive: false, currentLevel: -1, levelHeight: 0, levelWidth: 0,
  levelBitrateKbps: 0, levels: [], videoCodec: '', audioCodec: '',
  bufferSeconds: 0, droppedFrames: 0, totalFrames: 0, currentTime: 0, duration: 0,
  liveLatencySeconds: null, estimatedBandwidthKbps: 0, playbackRate: 1, lastError: null,
};

export function Player({ url, format, headers, ip, sessionId, onStats, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<dashjs.MediaPlayerClass | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const resolvedFormat = format === 'auto' ? detectFormat(url) : format;
    const encodedHeaders = encodeHeaders(headers);
    const ipOverride = ip || undefined;
    const proxied = proxyUrl(url, sessionId, ipOverride);
    let statsTimer: number | undefined;
    let destroyed = false;

    const stats: PlayerStats = { ...EMPTY_STATS };

    // Periodically compute playback health stats from the <video> element and engine.
    const startStatsLoop = () => {
      statsTimer = window.setInterval(() => {
        if (destroyed || !video) return;
        stats.currentTime = video.currentTime;
        stats.duration = isFinite(video.duration) ? video.duration : 0;
        stats.playbackRate = video.playbackRate;

        // Buffer ahead of playhead
        let buffered = 0;
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
            buffered = video.buffered.end(i) - video.currentTime;
            break;
          }
        }
        stats.bufferSeconds = buffered;

        const q = (video as any).getVideoPlaybackQuality?.();
        if (q) {
          stats.droppedFrames = q.droppedVideoFrames ?? 0;
          stats.totalFrames = q.totalVideoFrames ?? 0;
        }
        onStats({ ...stats });
      }, 1000);
    };

    const fail = (msg: string) => {
      stats.lastError = msg;
      onError(msg);
      onStats({ ...stats });
    };

    // ---------- HLS / CMAF-over-HLS ----------
    if ((resolvedFormat === 'hls' || resolvedFormat === 'cmaf') && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        // Attach custom headers to every XHR hitting our proxy.
        xhrSetup: (xhr) => {
          xhr.setRequestHeader('x-sp-headers', encodedHeaders);
        },
      });
      hlsRef.current = hls;
      stats.engine = 'hls.js';

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        stats.levels = hls.levels.map((l) => ({
          height: l.height, width: l.width, bitrateKbps: Math.round(l.bitrate / 1000),
        }));
        stats.isLive = hls.levels[0]?.details?.live ?? false;
        if (data.levels?.[0]) {
          stats.videoCodec = data.levels[0].videoCodec || '';
          stats.audioCodec = data.levels[0].audioCodec || '';
        }
        video.play().catch(() => {});
        onStats({ ...stats });
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const lvl = hls.levels[data.level];
        if (lvl) {
          stats.currentLevel = data.level;
          stats.levelHeight = lvl.height;
          stats.levelWidth = lvl.width;
          stats.levelBitrateKbps = Math.round(lvl.bitrate / 1000);
          stats.videoCodec = lvl.videoCodec || stats.videoCodec;
          stats.audioCodec = lvl.audioCodec || stats.audioCodec;
        }
        onStats({ ...stats });
      });

      hls.on(Hls.Events.LEVEL_UPDATED, (_e, data) => {
        stats.isLive = data.details.live;
        if (data.details.live && data.details.totalduration) {
          const target = data.details.targetduration || 0;
          stats.liveLatencySeconds = hls.latency || target * 3;
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        stats.estimatedBandwidthKbps = Math.round((hls.bandwidthEstimate || 0) / 1000);
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          fail(`HLS error: ${data.type} / ${data.details}`);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break;
            case Hls.ErrorTypes.MEDIA_ERROR: hls.recoverMediaError(); break;
            default: hls.destroy(); break;
          }
        }
      });

      hls.loadSource(proxied);
      hls.attachMedia(video);
      startStatsLoop();
    }
    // ---------- HLS native (Safari) ----------
    else if ((resolvedFormat === 'hls' || resolvedFormat === 'cmaf') && video.canPlayType('application/vnd.apple.mpegurl')) {
      stats.engine = 'native';
      // Native can't set x-sp-headers; pass headers via query param.
      video.src = `${proxied}&h=${encodeURIComponent(encodedHeaders)}`;
      video.addEventListener('loadedmetadata', () => {
        stats.isLive = video.duration === Infinity;
        video.play().catch(() => {});
      });
      video.addEventListener('error', () => fail('Native HLS playback error'));
      startStatsLoop();
    }
    // ---------- DASH / CMAF-over-DASH ----------
    else if (resolvedFormat === 'dash' || (resolvedFormat === 'cmaf' && url.toLowerCase().includes('.mpd'))) {
      const player = dashjs.MediaPlayer().create();
      dashRef.current = player;
      stats.engine = 'dash.js';

      // Inject custom headers on every dash.js XHR, and wrap each resolved
      // (absolute upstream) segment URL back through our proxy so headers are
      // applied and CORS is sidestepped. The MPD itself is already proxied.
      player.extend?.('RequestModifier', () => ({
        modifyRequestHeader: (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('x-sp-headers', encodedHeaders);
          return xhr;
        },
        modifyRequestURL: (u: string) => {
          // Already going through our proxy (e.g. the manifest) — leave as-is.
          if (u.startsWith('/proxy?') || u.includes('/proxy?url=')) return u;
          // Wrap absolute upstream URLs resolved from the manifest's BaseURL.
          if (/^https?:\/\//i.test(u)) return proxyUrl(u, sessionId, ipOverride);
          return u;
        },
      }), true);

      player.updateSettings({
        streaming: {
          abr: { useDefaultABRRules: true },
        },
      });

      player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        stats.isLive = player.isDynamic();
        const bitrates = player.getBitrateInfoListFor?.('video') || [];
        stats.levels = bitrates.map((b: any) => ({
          height: b.height, width: b.width, bitrateKbps: Math.round(b.bitrate / 1000),
        }));
        onStats({ ...stats });
      });

      player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (e: any) => {
        if (e.mediaType === 'video') {
          const bitrates = player.getBitrateInfoListFor?.('video') || [];
          const info = bitrates[e.newQuality];
          if (info) {
            stats.currentLevel = e.newQuality;
            stats.levelHeight = info.height;
            stats.levelWidth = info.width;
            stats.levelBitrateKbps = Math.round(info.bitrate / 1000);
          }
          onStats({ ...stats });
        }
      });

      player.on(dashjs.MediaPlayer.events.PLAYBACK_METADATA_LOADED, () => {
        try {
          stats.videoCodec = player.getCurrentTrackFor?.('video')?.codec || '';
          stats.audioCodec = player.getCurrentTrackFor?.('audio')?.codec || '';
        } catch { /* ignore */ }
      });

      player.on(dashjs.MediaPlayer.events.ERROR, (e: any) => {
        fail(`DASH error: ${e.error?.message || JSON.stringify(e.error)}`);
      });

      const dashStatsLoop = window.setInterval(() => {
        if (destroyed) return;
        try {
          const avgThroughput = player.getAverageThroughput?.('video');
          if (avgThroughput) stats.estimatedBandwidthKbps = Math.round(avgThroughput);
          if (player.isDynamic()) {
            stats.liveLatencySeconds = player.getCurrentLiveLatency?.() ?? null;
          }
        } catch { /* ignore */ }
      }, 1000);
      statsTimer = dashStatsLoop;

      player.initialize(video, proxied, true);
      startStatsLoop();
    }
    // ---------- Native MP4 ----------
    else {
      stats.engine = 'native';
      video.src = `${proxied}&h=${encodeURIComponent(encodedHeaders)}`;
      video.addEventListener('loadedmetadata', () => {
        stats.isLive = video.duration === Infinity || !isFinite(video.duration);
        stats.duration = isFinite(video.duration) ? video.duration : 0;
        stats.levelWidth = video.videoWidth;
        stats.levelHeight = video.videoHeight;
        video.play().catch(() => {});
        onStats({ ...stats });
      });
      video.addEventListener('error', () => fail('MP4 playback error (check URL / headers / CORS)'));
      startStatsLoop();
    }

    // Cleanup on unmount / url change.
    return () => {
      destroyed = true;
      if (statsTimer) window.clearInterval(statsTimer);
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      if (dashRef.current) { dashRef.current.destroy(); dashRef.current = null; }
      if (video) { video.removeAttribute('src'); video.load(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, format, sessionId, ip]);

  const resolved = format === 'auto' ? detectFormat(url) : format;

  return (
    <div className="panel">
      <h2>
        Player
        <span style={{ float: 'right', fontWeight: 400, textTransform: 'none' }}>
          <span className="badge fmt">{resolved.toUpperCase()}</span>
          {isAdaptive(resolved) && <span className="muted small"> adaptive</span>}
        </span>
      </h2>
      <div className="video-wrap">
        <video ref={videoRef} controls playsInline />
      </div>
    </div>
  );
}
