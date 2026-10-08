# Architecture

How the Stream Player is put together, and the mechanisms behind its key features.

---

## Overview

The application has two parts that run together during development:

- **Frontend** — a Vite + React + TypeScript single-page app served on port **5173** in dev.
- **Backend** — an Express proxy + API server (Node) on port **8787**.

In dev, Vite proxies `/api` and `/proxy` requests to the Express server (see
`vite.config.ts`), so the browser only talks to one origin.

```
Browser (React SPA)                 Node / Express (:8787)              Stream origin / CDN
┌────────────────────┐  /proxy      ┌───────────────────────┐  fetch   ┌───────────────────┐
│ <video> element    │◀──fed by────  │ /proxy  (header inject,│────────▶ │ manifest          │
│   ▲                 │              │          IP override,  │          │ segments / media  │
│   │ MSE appendBuffer│              │          manifest       │◀──────── │                   │
│ hls.js / dash.js    │──XHR fetch──▶│          rewrite,       │          └───────────────────┘
│                     │              │          metrics)       │
│ Diagnostics ────────┼──/api/*─────▶│ /api/metrics /api/har   │
│                     │              │ /api/probe /api/health  │
└────────────────────┘              └───────────────────────┘
```

## Why a backend proxy exists

Browsers cannot attach custom request headers to:
- a native `<video>` element's media loads, or
- cross-origin segment/media fetches made by the media engines in many cases.

They also enforce CORS, which arbitrary stream origins rarely satisfy. The proxy solves all
of this server-side:

1. **Header injection** — forwards your custom headers to the upstream origin.
2. **IP override** — redirects the TCP/TLS connection to a chosen IP while keeping the real
   hostname for `Host`/SNI.
3. **Manifest rewriting** — ensures child segment requests keep flowing through the proxy.
4. **CORS** — the proxy responds with permissive CORS headers to the browser.
5. **Metrics** — measures response time, bytes, and throughput per request.

## Playback pipeline

The `Player` component (`src/components/Player.tsx`) chooses an engine from the resolved
format:

1. **HLS/CMAF + `Hls.isSupported()`** → **hls.js**. Headers are attached via `xhrSetup`,
   which sets the `x-sp-headers` request header on every XHR to the proxy.
2. **HLS/CMAF + native HLS support (Safari)** → native `<video>`. Headers are passed via a
   base64 `h=` query parameter on the proxied URL (native video can't set request headers).
3. **DASH/CMAF-over-DASH** → **dash.js**. A `RequestModifier` sets `x-sp-headers` on each
   XHR, and `modifyRequestURL` wraps each resolved absolute segment URL back through the
   proxy.
4. **MP4 (and other)** → native `<video>` with the `h=` query parameter.

In all cases, the media engine (or the browser) feeds segment bytes into the browser's
**Media Source Extensions** pipeline, which performs the actual decode and render using the
platform's codecs.

## Custom headers

Custom headers travel to the proxy by one of two transports, then are forwarded upstream:

- **`x-sp-headers` request header** — a base64-encoded JSON object of name/value pairs. Used
  by hls.js and dash.js XHRs.
- **`h=` query parameter** — the same base64 JSON, used by the native `<video>` element,
  which cannot set custom request headers.

Server-side, `decodeCustomHeaders()` reads whichever is present, parses the JSON, and merges
the result into the outgoing `fetch` headers. The browser's own `User-Agent` is forwarded by
default (unless a custom one is supplied), which maximizes CDN compatibility.

## Manifest rewriting

Adaptive manifests reference child resources (variant playlists, segments). To keep those
flowing through the proxy with headers/IP intact:

- **HLS (`.m3u8`)**: `rewriteHls()` resolves every segment / variant / `URI="…"` reference
  against the manifest's real URL, then rewrites each to
  `/proxy?url=<absolute>&sid=<session>[&ip=<ip>]`.
- **DASH (`.mpd`)**: `rewriteDash()` makes the `<BaseURL>` **absolute** (pointing at the real
  upstream directory) and injects one if absent. DASH uses `$Number$`/`$Time$` segment
  templates that the player resolves against this base, so the manifest body is *not*
  rewritten per-segment. Instead, dash.js's client-side `modifyRequestURL` wraps each
  resolved absolute URL back through the proxy. This avoids corrupting templated URLs.

## IP override

Implemented with [undici](https://github.com/nodejs/undici) (the HTTP client behind Node's
global `fetch`). `getDispatcher(ip)` builds a cached `undici.Agent` whose custom `connect`
function uses `buildConnector` to dial the override IP while setting `servername` to the real
hostname:

```
new Agent({
  connect(opts, cb) {
    baseConnector({ ...opts, hostname: overrideIp, servername: realHost }, cb);
  }
});
```

This preserves:
- the HTTP **`Host` header** (undici still uses the request URL's host), and
- **TLS SNI + certificate validation** (via `servername`),

so HTTPS verifies correctly even though the connection goes to a different IP.

> **Version pin**: the standalone `undici` version **must match** Node's bundled undici
> (`process.versions.undici`). A mismatch makes dispatchers incompatible with global `fetch`
> (fails with `invalid onError method`). The project pins `undici@8.10.2`, which is
> compatible with Node 26's bundled undici (8.9.x) — minor version differences interoperate,
> but a major mismatch (e.g. 6.x) does not.

The override is read from the `ip=` query parameter on `/proxy` and `/api/probe`, validated
with `isValidIp()`, and propagated to HLS child URLs (and to DASH requests via the client).

## Request lifecycle (HLS example)

1. User clicks **Load & Play**. `App` clears old metrics and sets the active stream.
2. `Player` builds a proxied manifest URL and calls `hls.loadSource(proxied)`.
3. hls.js fetches the manifest via `/proxy?url=…`; the proxy injects headers/IP, rewrites the
   playlist so child URLs point back at `/proxy`, records a metric, and returns it.
4. hls.js fetches each variant playlist and segment — all via `/proxy` — appending bytes to
   the MSE `SourceBuffer`.
5. The proxy records a metric per request (time, bytes, throughput, headers, kind).
6. `Diagnostics` polls `/api/metrics` every ~1.5s and updates the Performance tab; `Player`
   emits `PlayerStats` every ~1s for the Quality tab.
7. **Download HAR** calls `/api/har`, which converts the recorded metrics into a HAR 1.2 doc.

## Metrics storage

Metrics are kept **in memory** on the server in a `Map` keyed by a per-tab **session id**
(`sid`), capped at 500 entries (a ring buffer). They are not persisted; restarting the server
clears them. Clearing happens automatically each time a new stream is loaded
(`POST /api/metrics/clear`).

## Security hardening

The proxy applies several protections (added to address Snyk SAST findings):

- **SSRF guard** — before fetching, the effective destination is checked against private,
  loopback, link-local, CGNAT, and cloud-metadata ranges (e.g. `127.0.0.0/8`, `10/8`,
  `172.16/12`, `192.168/16`, `169.254/16` incl. `169.254.169.254`, IPv6 `::1`/`fe80::`/
  `fc00::/7`). For hostnames, DNS is resolved and every returned address is checked; for an
  IP override, the override IP is checked. Blocked requests return `403`. Set
  `ALLOW_PRIVATE_HOSTS=1` to disable the guard for local testing.
- **`X-Content-Type-Options: nosniff`** on proxied responses, so the browser won't MIME-sniff
  a mislabeled body into an executable type (defense-in-depth against XSS).
- **`x-powered-by` disabled** so the server doesn't advertise Express.

## Technology summary

| Layer | Technology |
|---|---|
| UI framework | React 18 + TypeScript |
| Build tool / dev server | Vite 5 |
| HLS engine | hls.js 1.5 |
| DASH engine | dash.js 4.7 |
| MP4 / Safari HLS | native `<video>` + Media Source Extensions |
| Backend | Express 4 (Node, ESM, `tsx` in dev) |
| HTTP client / IP override | undici 8.9 |
| CORS | `cors` middleware |
