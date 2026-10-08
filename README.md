# 🎬 Stream Player

A web-based stream player for **MP4, HLS, DASH, and CMAF** streams — both **live** and **VOD** —
with **custom request headers**, an **IP override**, and a **quality/performance diagnostics**
panel that can export a **HAR** file.

Everything runs in the browser (via `hls.js`, `dash.js`, and the native `<video>` element),
backed by a small Express proxy that injects headers, applies the IP override, rewrites
manifests, sidesteps CORS, and measures per-request metrics.

## Features at a glance

- **Any stream URL** with automatic format detection (MP4 / HLS / DASH / CMAF, live & VOD).
- **Custom request headers** applied to the manifest and every segment/media request.
- **IP override** — force the host to a specific IP while preserving hostname for `Host`/TLS SNI.
- **Diagnostics** — Quality (resolution, bitrate, buffer, dropped frames, latency),
  Performance (response time, throughput, request timeline, recent requests), Media
  (codecs + source probe), and Manifests (view the raw `.m3u8` / `.mpd` content).
- **HAR 1.2 export** of all captured requests — including manifest bodies — for Chrome
  DevTools, Charles, Fiddler, etc.
- **Hardened proxy** — SSRF guard against private/metadata ranges, `nosniff`, and no
  `x-powered-by`.

## Quick start

```bash
npm install
npm run dev
# open http://localhost:5173
```

Click a **Samples** pill or paste your own URL, then press **Load & Play**.

### Production build

```bash
npm run build          # frontend → dist/
npm run build:server   # server   → dist-server/
npm start              # serve the compiled server on :8787
```

## Documentation

Detailed docs live in [`docs/`](./docs/README.md):

- [Features](./docs/features.md) — every feature in detail.
- [Architecture](./docs/architecture.md) — how it works: proxy, headers, manifest rewriting, IP override.
- [Page structure](./docs/page-structure.md) — UI layout, component tree, state flow.
- [API reference](./docs/api-reference.md) — the proxy and API endpoints.
- [Development guide](./docs/development.md) — setup, scripts, layout, troubleshooting.

See the [CHANGELOG](./CHANGELOG.md) for version history.

## Tech stack

Vite · React · TypeScript · hls.js · dash.js · Express · undici

## Requirements

Node.js 26.x (the project pins `undici` to match Node 26's bundled version — see
[architecture](./docs/architecture.md#ip-override)).
