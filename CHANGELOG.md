# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes._

## [1.1.0] - 2026-10-08

### Added

- **Manifest content capture** — the proxy now stores the original (pre-rewrite) body of
  each HLS/DASH manifest. It is included in the HAR export as `response.content.text` and
  shown in a new **Manifests** tab in the Diagnostics panel (with a list of captured
  manifests and a copy button). Segments/media remain body-less (streamed through unbuffered).

### Security

- Upgraded **undici** 8.9.0 → **8.10.2**, resolving 10 advisories including a **critical**
  improper-certificate-validation issue (CVE-2026-84961) and several high-severity
  resource/exception/cookie issues.
- Upgraded **express** 4.21.2 → **4.22.3**, clearing 6 transitive advisories in `qs`,
  `body-parser`, and `path-to-regexp` (ReDoS, resource exhaustion, null deref).
- Added an **SSRF guard** on `/proxy` and `/api/probe`: destinations resolving to private,
  loopback, link-local, CGNAT, or cloud-metadata ranges are blocked with `403`. Override IPs
  are validated too. Bypass for local testing via `ALLOW_PRIVATE_HOSTS=1`.
- Added **`X-Content-Type-Options: nosniff`** to proxied responses.
- Disabled the **`x-powered-by`** header.

## [1.0.0]

Initial release of the Stream Player.

### Added

- **Stream URL input** with automatic format detection (MP4 / HLS / DASH / CMAF) and manual
  format override pills (`auto`, `mp4`, `hls`, `dash`, `cmaf`).
- **In-browser playback** supporting both **live** and **VOD**:
  - `hls.js` for HLS and CMAF-over-HLS.
  - `dash.js` for DASH and CMAF-over-DASH.
  - native `<video>` for MP4 and for HLS on Safari.
- **Custom request headers** — add any number of header name/value pairs, applied to the
  manifest and every child segment/media request. Transported via an `x-sp-headers`
  base64-JSON header (hls.js/dash.js) or an `h=` query parameter (native `<video>`).
- **IP override** — force the stream host to connect to a specific IPv4/IPv6 address while
  preserving the hostname for the HTTP `Host` header and TLS SNI/certificate validation.
  Applied to the manifest and all child requests. Implemented with an `undici` custom
  connector.
- **Express proxy backend** that injects headers, applies the IP override, rewrites HLS/DASH
  manifests so child requests route back through the proxy, sidesteps CORS, and records
  per-request metrics.
- **Diagnostics panel** with three tabs:
  - **Quality** — live/VOD, engine, resolution, current/available bitrates, estimated
    bandwidth, buffer ahead, dropped frames, and live latency / VOD progress.
  - **Performance** — request count, total transferred, average response time, average
    throughput, a per-request timeline, and a recent-requests table.
  - **Media** — video/audio codecs and a source probe (status, content-type, length,
    accept-ranges, final URL, and response headers).
- **HAR 1.2 export** — a Download HAR button that exports all captured requests as a
  standards-compliant HAR file (validated against the HAR 1.2 schema) for Chrome DevTools,
  Charles, Fiddler, or any HAR viewer.
- **Sample streams** — one-click pills for HLS VOD/Live, Apple bipbop, DASH VOD/Live, and MP4.
- **Documentation** — `docs/` with features, architecture, page structure, API reference,
  and a development guide.

### Fixed

- **DASH playback** — manifests now rewrite `<BaseURL>` to an absolute upstream URL (instead
  of a relative proxied URL), fixing segment resolution for `$Number$`/`$Time$` templates.
  Resolved segments are wrapped back through the proxy client-side.
- **MP4 / CDN compatibility** — the proxy forwards the browser's real `User-Agent` instead of
  a fabricated one, avoiding `403` responses from CDNs that reject synthetic agents.
- **`start` script** — corrected the compiled server path to `dist-server/server/index.js`.

### Notes

- Pins `undici@8.9.0` to match Node 26's bundled undici; a mismatch breaks global `fetch`
  dispatchers.
- Metrics are stored in memory per session (capped at 500 entries) and are not persisted.
- HAR export captures request/response headers, timing, and sizes, but not response bodies.

[Unreleased]: https://example.com/compare/v1.1.0...HEAD
[1.1.0]: https://example.com/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
