import type { HeaderPair, StreamFormat } from '../../shared/types';

/** Detect stream format from a URL's extension / known patterns. */
export function detectFormat(url: string): Exclude<StreamFormat, 'auto'> {
  const clean = url.toLowerCase().split('?')[0].split('#')[0];
  if (clean.endsWith('.m3u8')) return 'hls';
  if (clean.endsWith('.mpd')) return 'dash';
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v') || clean.endsWith('.mov')) return 'mp4';
  // CMAF is delivered via HLS or DASH manifests; .cmfv/.cmfa are raw segments.
  if (clean.endsWith('.cmfv') || clean.endsWith('.cmfa')) return 'cmaf';
  // Fallbacks based on substrings
  if (clean.includes('m3u8')) return 'hls';
  if (clean.includes('mpd')) return 'dash';
  return 'mp4';
}

/** Convert header pairs to a plain object, dropping empty keys. */
export function headersToObject(headers: HeaderPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.key.trim()) out[h.key.trim()] = h.value;
  }
  return out;
}

/** Base64-encode a JSON header map for transport via the x-sp-headers header. */
export function encodeHeaders(headers: Record<string, string>): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(headers))));
}

/** Build a proxied URL that routes through the backend with the session id. */
export function proxyUrl(targetUrl: string, sessionId: string, ip?: string): string {
  const ipSuffix = ip ? `&ip=${encodeURIComponent(ip)}` : '';
  return `/proxy?url=${encodeURIComponent(targetUrl)}&sid=${encodeURIComponent(sessionId)}${ipSuffix}`;
}

/** Whether a format is adaptive (manifest-based) vs a single file. */
export function isAdaptive(fmt: Exclude<StreamFormat, 'auto'>): boolean {
  return fmt === 'hls' || fmt === 'dash' || fmt === 'cmaf';
}
