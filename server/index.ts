import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, buildConnector } from 'undici';
import type { RequestMetric } from '../shared/types.js';

const app = express();
const PORT = Number(process.env.PORT) || 8787;

// Don't advertise the server framework (information exposure hardening).
app.disable('x-powered-by');

app.use(cors());
app.use(express.json());

/**
 * In-memory ring buffer of recent request metrics. Keyed by a session id so
 * multiple tabs don't clobber each other. Capped to avoid unbounded growth.
 */
const MAX_METRICS = 500;
const metricsBySession = new Map<string, RequestMetric[]>();

function recordMetric(sessionId: string, metric: RequestMetric) {
  let list = metricsBySession.get(sessionId);
  if (!list) {
    list = [];
    metricsBySession.set(sessionId, list);
  }
  list.push(metric);
  if (list.length > MAX_METRICS) list.splice(0, list.length - MAX_METRICS);
}

/**
 * IP-override support.
 *
 * Lets the user force the connection for a stream host to a specific IP
 * (e.g. to target a particular CDN edge / origin / staging box) while keeping
 * the original hostname for the HTTP `Host` header and TLS SNI + certificate
 * validation. Implemented with an undici custom connector that dials the
 * override IP but hands the real hostname to the TLS layer as `servername`.
 *
 * The undici package version MUST match Node's bundled undici
 * (process.versions.undici) or the dispatcher is incompatible with global
 * fetch — see package.json pin.
 */
const baseConnector = buildConnector({ timeout: 10_000 });

/** Cache dispatchers per IP so we don't rebuild a connector per request. */
const dispatcherCache = new Map<string, Agent>();

/** Basic IPv4 / IPv6 validation to avoid passing junk to the connector. */
function isValidIp(ip: string): boolean {
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::1|([0-9a-fA-F]{1,4}:){1,7}:|:(:[0-9a-fA-F]{1,4}){1,7})$/;
  return ipv4.test(ip) || ipv6.test(ip);
}

/**
 * SSRF guard. Returns true if an IP address points at a private, loopback,
 * link-local, or cloud-metadata range that an internet stream should never
 * resolve to. Blocking these prevents the proxy from being abused to reach
 * internal infrastructure (CWE-918).
 *
 * Set ALLOW_PRIVATE_HOSTS=1 to disable this guard (e.g. to test against a
 * localhost origin during development).
 */
function isBlockedIp(ip: string): boolean {
  if (process.env.ALLOW_PRIVATE_HOSTS === '1') return false;
  const kind = isIP(ip); // 0 = not an IP, 4 = IPv4, 6 = IPv6
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                       // 10.0.0.0/8 private
    if (a === 127) return true;                      // 127.0.0.0/8 loopback
    if (a === 0) return true;                        // 0.0.0.0/8
    if (a === 169 && b === 254) return true;         // 169.254.0.0/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                       // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;      // loopback / unspecified
    if (v.startsWith('fe80')) return true;           // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4.
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return false;
}

/**
 * Validate that a target URL (and optional IP override) is safe to fetch:
 * the effective destination must not resolve to a blocked internal range.
 * Returns an error message if blocked, or null if safe.
 */
async function assertSafeTarget(targetUrl: URL, overrideIp?: string): Promise<string | null> {
  // If an override IP is supplied, that is the real connection target.
  if (overrideIp && isValidIp(overrideIp)) {
    return isBlockedIp(overrideIp)
      ? `blocked: override IP ${overrideIp} is in a private/reserved range`
      : null;
  }
  const host = targetUrl.hostname;
  // Literal IP host — check directly.
  if (isIP(host)) {
    return isBlockedIp(host) ? `blocked: host ${host} is in a private/reserved range` : null;
  }
  // Resolve the hostname and check every returned address.
  try {
    const results = await lookup(host, { all: true });
    for (const { address } of results) {
      if (isBlockedIp(address)) {
        return `blocked: ${host} resolves to private/reserved address ${address}`;
      }
    }
    return null;
  } catch (err) {
    return `dns resolution failed for ${host}: ${String(err)}`;
  }
}

/**
 * Build (or reuse) an undici dispatcher that forces every connection to
 * `overrideIp`, preserving the request's own hostname for SNI. Returns
 * undefined when no valid override is supplied (fetch then uses normal DNS).
 */
function getDispatcher(overrideIp: string | undefined): Agent | undefined {
  if (!overrideIp || !isValidIp(overrideIp)) return undefined;
  const cached = dispatcherCache.get(overrideIp);
  if (cached) return cached;
  const agent = new Agent({
    connect(opts, cb) {
      // Keep every original option (protocol, port, TLS opts…), but dial the
      // override IP while preserving the real hostname as the TLS servername
      // so SNI + certificate validation still match.
      const servername = (opts as { servername?: string }).servername || opts.hostname;
      baseConnector({ ...opts, hostname: overrideIp, servername }, cb);
    },
  });
  dispatcherCache.set(overrideIp, agent);
  return agent;
}

/** Classify a request by content type / extension for the diagnostics UI. */
function classifyKind(url: string, contentType: string): string {
  const u = url.toLowerCase().split('?')[0];
  const ct = contentType.toLowerCase();
  if (u.endsWith('.m3u8') || ct.includes('mpegurl')) return 'manifest';
  if (u.endsWith('.mpd') || ct.includes('dash+xml')) return 'manifest';
  if (u.endsWith('.ts') || u.endsWith('.m4s') || u.endsWith('.mp4') || u.endsWith('.cmfv') || u.endsWith('.cmfa')) return 'segment';
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'media';
  return 'other';
}

/** Convert a plain header object into the HAR {name,value}[] shape. */
function toHarHeaders(obj: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(obj).map(([name, value]) => ({ name, value }));
}

/** Convert a fetch Headers object into the HAR {name,value}[] shape. */
function responseHeadersToHar(headers: Headers): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  headers.forEach((value, name) => out.push({ name, value }));
  return out;
}

/**
 * Decode custom headers passed by the client. They arrive base64-encoded in
 * the `x-sp-headers` header as a JSON object to avoid header-name collisions
 * and allow arbitrary values.
 */
function decodeCustomHeaders(req: Request): Record<string, string> {
  // Prefer the x-sp-headers request header (used by hls.js/dash.js XHRs).
  // Fall back to the `h` query param (used by the native <video> element,
  // which cannot set custom request headers).
  const raw = req.header('x-sp-headers') || (typeof req.query.h === 'string' ? req.query.h : '');
  if (!raw) return {};
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim()) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Rewrite URLs in an HLS (.m3u8) manifest so that every referenced resource is
 * fetched back through this proxy (preserving the target base + session so
 * custom headers keep being applied to segments and child playlists).
 */
function rewriteHls(body: string, baseUrl: string, sessionId: string, ip?: string): string {
  const ipSuffix = ip ? `&ip=${encodeURIComponent(ip)}` : '';
  const resolve = (uri: string) => {
    const abs = new URL(uri, baseUrl).toString();
    return `/proxy?url=${encodeURIComponent(abs)}&sid=${encodeURIComponent(sessionId)}${ipSuffix}`;
  };
  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      // URI="..." attributes (keys, maps, media, I-frames)
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${resolve(uri)}"`);
      }
      // Bare resource lines (segments / variant playlists)
      return resolve(trimmed);
    })
    .join('\n');
}

/**
 * Rewrite a DASH (.mpd) manifest.
 *
 * DASH uses SegmentTemplate `$Number$`/`$Time$` tokens and relative `<BaseURL>`
 * values that the player resolves against the manifest's own URL. Because the
 * manifest is served from `/proxy?url=...`, relative resolution would break.
 *
 * The robust fix: inject an ABSOLUTE `<BaseURL>` pointing at the real upstream
 * directory so dash.js resolves every segment URL correctly. The client-side
 * dash.js `RequestModifier.modifyRequestURL` then wraps each resolved request
 * back through this proxy (so custom headers are still applied). We therefore
 * do NOT rewrite template/media/initialization attributes here.
 */
function rewriteDash(body: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  // Directory of the manifest, used to resolve relative BaseURLs to absolute.
  const manifestDir = new URL('.', base).toString();

  const hasBaseUrl = /<BaseURL>/.test(body);

  // Make existing <BaseURL> values absolute against the manifest location.
  let out = body.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_m, uri) => {
    const abs = new URL(uri.trim(), base).toString();
    return `<BaseURL>${abs}</BaseURL>`;
  });

  // If the manifest has no BaseURL at all, inject one so relative segment
  // templates resolve against the real upstream directory instead of the proxy.
  if (!hasBaseUrl) {
    out = out.replace(/(<MPD\b[^>]*>)/, (_m, mpdTag) => `${mpdTag}\n  <BaseURL>${manifestDir}</BaseURL>`);
  }
  return out;
}

/**
 * Core streaming proxy. GET /proxy?url=<encoded>&sid=<session>
 * Injects custom headers, measures timing + bytes, and (for manifests)
 * rewrites child URLs to route back through the proxy.
 */
app.get('/proxy', async (req: Request, res: Response) => {
  const target = req.query.url;
  const sessionId = (req.query.sid as string) || 'default';
  const overrideIp = typeof req.query.ip === 'string' ? req.query.ip.trim() : undefined;
  if (typeof target !== 'string' || !target) {
    res.status(400).json({ error: 'missing url query param' });
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    res.status(400).json({ error: 'invalid url' });
    return;
  }
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    res.status(400).json({ error: 'only http/https supported' });
    return;
  }

  // SSRF guard: refuse to fetch internal/private/metadata destinations.
  const blocked = await assertSafeTarget(targetUrl, overrideIp);
  if (blocked) {
    res.status(403).json({ error: 'request blocked', detail: blocked });
    return;
  }

  const customHeaders = decodeCustomHeaders(req);
  // Forward Range header for byte-range / seek support.
  const forwardHeaders: Record<string, string> = { ...customHeaders };
  const range = req.header('range');
  if (range) forwardHeaders['range'] = range;
  // Some CDNs reject requests with no User-Agent, others reject specific
  // fabricated ones. The most compatible choice is to forward the browser's
  // own User-Agent from the incoming request, unless the caller supplied one
  // via custom headers.
  const hasUA = Object.keys(forwardHeaders).some((k) => k.toLowerCase() === 'user-agent');
  if (!hasUA) {
    const incomingUA = req.header('user-agent');
    if (incomingUA) forwardHeaders['user-agent'] = incomingUA;
  }

  const startedAt = Date.now();
  const id = randomUUID();

  try {
    const dispatcher = getDispatcher(overrideIp);
    const upstream = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: forwardHeaders,
      redirect: 'follow',
      // When an IP override is active, route the connection to it (preserving
      // hostname for Host header + TLS SNI). undici follows redirects on the
      // same dispatcher, so redirected hops also use the override.
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);

    const contentType = upstream.headers.get('content-type') || '';
    const kind = classifyKind(targetUrl.toString(), contentType);

    // Pass through useful headers.
    res.status(upstream.status);
    const passthrough = ['content-type', 'cache-control', 'accept-ranges', 'content-range', 'etag', 'last-modified'];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // Expose timing/kind to the browser for client-side correlation.
    res.setHeader('access-control-expose-headers', 'x-sp-kind, x-sp-response-ms, x-sp-bytes');
    // Prevent the browser from MIME-sniffing proxied bodies into executable
    // types (defense-in-depth against XSS via mislabeled content).
    res.setHeader('x-content-type-options', 'nosniff');

    const isManifest = kind === 'manifest';

    if (isManifest) {
      // Buffer + rewrite manifests.
      const text = await upstream.text();
      const bytes = Buffer.byteLength(text, 'utf8');
      const finishedAt = Date.now();
      const responseTimeMs = finishedAt - startedAt;

      let rewritten = text;
      const lower = targetUrl.pathname.toLowerCase();
      if (lower.endsWith('.mpd') || contentType.includes('dash+xml')) {
        rewritten = rewriteDash(text, targetUrl.toString());
      } else {
        rewritten = rewriteHls(text, targetUrl.toString(), sessionId, overrideIp);
      }

      recordMetric(sessionId, {
        id, url: targetUrl.toString(), kind, method: 'GET',
        status: upstream.status, statusText: upstream.statusText, httpVersion: 'HTTP/1.1',
        responseTimeMs, bytes, throughputBps: responseTimeMs > 0 ? (bytes * 8) / (responseTimeMs / 1000) : 0,
        contentType, startedAt, finishedAt,
        requestHeaders: toHarHeaders(forwardHeaders),
        responseHeaders: responseHeadersToHar(upstream.headers),
        // Store the ORIGINAL manifest text (not the proxy-rewritten version)
        // so the HAR / viewer shows the real upstream URLs and tags.
        body: text,
      });

      res.setHeader('x-sp-kind', kind);
      res.setHeader('x-sp-response-ms', String(responseTimeMs));
      res.setHeader('x-sp-bytes', String(bytes));
      res.send(rewritten);
      return;
    }

    // Stream binary (segments / media) through, counting bytes.
    const reader = upstream.body?.getReader();
    let bytes = 0;
    if (reader) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.byteLength;
          res.write(Buffer.from(value));
        }
      }
    }
    const finishedAt = Date.now();
    const responseTimeMs = finishedAt - startedAt;
    recordMetric(sessionId, {
      id, url: targetUrl.toString(), kind, method: 'GET',
      status: upstream.status, statusText: upstream.statusText, httpVersion: 'HTTP/1.1',
      responseTimeMs, bytes, throughputBps: responseTimeMs > 0 ? (bytes * 8) / (responseTimeMs / 1000) : 0,
      contentType, startedAt, finishedAt,
      requestHeaders: toHarHeaders(forwardHeaders),
      responseHeaders: responseHeadersToHar(upstream.headers),
    });
    res.end();
  } catch (err) {
    const finishedAt = Date.now();
    recordMetric(sessionId, {
      id, url: targetUrl.toString(), kind: 'other', method: 'GET',
      status: 0, statusText: 'Fetch failed', httpVersion: 'HTTP/1.1',
      responseTimeMs: finishedAt - startedAt, bytes: 0, throughputBps: 0,
      contentType: '', startedAt, finishedAt,
      requestHeaders: toHarHeaders(forwardHeaders),
      responseHeaders: [],
    });
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream fetch failed', detail: String(err) });
    } else {
      res.end();
    }
  }
});

/** Return and clear/keep collected metrics for a session. */
app.get('/api/metrics', (req: Request, res: Response) => {
  const sessionId = (req.query.sid as string) || 'default';
  res.json({ metrics: metricsBySession.get(sessionId) || [] });
});

/**
 * Export collected requests for a session as a HAR 1.2 document.
 * The result is a valid HTTP Archive that can be imported into Chrome
 * DevTools (Network tab → Import HAR), Charles, Fiddler, or any HAR viewer.
 *
 * HAR 1.2 spec: http://www.softwareishard.com/blog/har-12-spec/
 */
app.get('/api/har', (req: Request, res: Response) => {
  const sessionId = (req.query.sid as string) || 'default';
  const metrics = metricsBySession.get(sessionId) || [];

  const entries = metrics.map((m) => {
    // We don't buffer segment bodies, so body size comes from the measured
    // byte count. Header size is unknown via fetch, so we report -1 per spec.
    const bodySize = m.bytes;
    const mimeType = m.contentType || 'application/octet-stream';
    const parsed = (() => {
      try { return new URL(m.url); } catch { return null; }
    })();
    const queryString = parsed
      ? Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }))
      : [];

    // HAR response content. For manifests we captured the original body, so
    // include it as `text` (per the HAR 1.2 spec). Segments/media are streamed
    // through unbuffered and therefore have no body.
    const content: { size: number; mimeType: string; text?: string; encoding?: string } = {
      size: bodySize,
      mimeType,
    };
    if (typeof m.body === 'string') {
      content.text = m.body;
    }

    return {
      startedDateTime: new Date(m.startedAt).toISOString(),
      time: m.responseTimeMs,
      request: {
        method: m.method,
        url: m.url,
        httpVersion: m.httpVersion,
        cookies: [],
        headers: m.requestHeaders,
        queryString,
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: m.status,
        statusText: m.statusText,
        httpVersion: m.httpVersion,
        cookies: [],
        headers: m.responseHeaders,
        content,
        redirectURL: '',
        headersSize: -1,
        bodySize,
      },
      cache: {},
      timings: {
        // We measure a single wall-clock span; attribute it to `wait` (TTFB-ish)
        // and `receive`. Unmeasured phases are -1 per the HAR spec.
        blocked: -1,
        dns: -1,
        connect: -1,
        ssl: -1,
        send: 0,
        wait: 0,
        receive: m.responseTimeMs,
      },
      // Custom extension fields (allowed via `_` prefix) with our metrics.
      _kind: m.kind,
      _throughputBps: Math.round(m.throughputBps),
    };
  });

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'StreamPlayer', version: '1.1.0' },
      pages: [],
      entries,
    },
  };

  const filename = `streamplayer-${sessionId}-${Date.now()}.har`;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(har, null, 2));
});

app.post('/api/metrics/clear', (req: Request, res: Response) => {
  const sessionId = (req.body?.sid as string) || 'default';
  metricsBySession.delete(sessionId);
  res.json({ ok: true });
});

/**
 * Probe endpoint: does a lightweight HEAD/GET to report status, content-type,
 * size, and server headers for the media info panel without playing it.
 */
app.get('/api/probe', async (req: Request, res: Response) => {
  const target = req.query.url;
  if (typeof target !== 'string' || !target) {
    res.status(400).json({ error: 'missing url' });
    return;
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    res.status(400).json({ error: 'invalid url' });
    return;
  }
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    res.status(400).json({ error: 'only http/https supported' });
    return;
  }
  const customHeaders = decodeCustomHeaders(req);
  const overrideIp = typeof req.query.ip === 'string' ? req.query.ip.trim() : undefined;
  // SSRF guard: same protection as /proxy.
  const probeBlocked = await assertSafeTarget(targetUrl, overrideIp);
  if (probeBlocked) {
    res.status(403).json({ error: 'request blocked', detail: probeBlocked });
    return;
  }
  try {
    const started = Date.now();
    const dispatcher = getDispatcher(overrideIp);
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { ...customHeaders, range: 'bytes=0-1' },
      redirect: 'follow',
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    const responseTimeMs = Date.now() - started;
    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => { headers[k] = v; });
    res.json({
      status: upstream.status,
      finalUrl: upstream.url,
      responseTimeMs,
      contentType: upstream.headers.get('content-type') || '',
      contentLength: upstream.headers.get('content-length') || '',
      acceptRanges: upstream.headers.get('accept-ranges') || '',
      headers,
    });
  } catch (err) {
    res.status(502).json({ error: 'probe failed', detail: String(err) });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[streamplayer] proxy + api listening on http://localhost:${PORT}`);
});
