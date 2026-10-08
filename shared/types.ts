// Shared types used by both client and server.

export type StreamFormat = 'mp4' | 'hls' | 'dash' | 'cmaf' | 'auto';

export interface HeaderPair {
  key: string;
  value: string;
}

/** A single network request observed by the proxy, used for performance metrics. */
export interface RequestMetric {
  id: string;
  url: string;
  /** manifest | segment | media | other */
  kind: string;
  method: string;
  status: number;
  statusText: string;
  httpVersion: string;
  /** Time to first byte / full response, milliseconds. */
  responseTimeMs: number;
  /** Bytes transferred. */
  bytes: number;
  /** Throughput in bits per second for this request. */
  throughputBps: number;
  contentType: string;
  startedAt: number;
  finishedAt: number;
  /** Headers actually sent upstream (incl. custom + Range + UA). For HAR export. */
  requestHeaders: { name: string; value: string }[];
  /** Response headers received from upstream. For HAR export. */
  responseHeaders: { name: string; value: string }[];
  /**
   * Original (pre-rewrite) response body text. Only populated for manifests
   * (m3u8 / mpd), which are small and already buffered. Segments/media are
   * streamed through without buffering, so they have no body.
   */
  body?: string;
}

export interface ProxyMetricsResponse {
  metrics: RequestMetric[];
}

/** Live playback / quality stats surfaced from the active player engine. */
export interface PlayerStats {
  engine: 'hls.js' | 'dash.js' | 'native' | null;
  isLive: boolean;
  // Quality
  currentLevel: number;
  levelHeight: number;
  levelWidth: number;
  levelBitrateKbps: number;
  levels: { height: number; width: number; bitrateKbps: number }[];
  videoCodec: string;
  audioCodec: string;
  // Playback health
  bufferSeconds: number;
  droppedFrames: number;
  totalFrames: number;
  // Timing
  currentTime: number;
  duration: number;
  liveLatencySeconds: number | null;
  // Throughput (player-estimated bandwidth)
  estimatedBandwidthKbps: number;
  playbackRate: number;
  // Error
  lastError: string | null;
}
