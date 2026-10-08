# API Reference

The backend (`server/index.ts`) is an Express server on port **8787** exposing a streaming
proxy and a small set of JSON APIs. All responses include permissive CORS headers.

Common concepts:

- **`sid`** — a per-tab **session id** used to group metrics. The frontend generates one per
  page load.
- **Custom headers** — passed either as the `x-sp-headers` request header (base64-encoded
  JSON object) or an `h=` query parameter (same base64 JSON). Decoded and forwarded upstream.
- **`ip`** — optional IP override. When a valid IPv4/IPv6 is supplied, the upstream
  connection is dialed to that IP while preserving the hostname for `Host`/TLS SNI. Invalid
  values are ignored (normal DNS is used).

---

## GET /proxy

The core streaming proxy. Fetches an upstream resource, injects custom headers, optionally
applies the IP override, rewrites manifests, records a metric, and streams the response back.

**Query parameters**

| Param | Required | Description |
|---|---|---|
| `url` | yes | The absolute upstream URL (URL-encoded). Must be `http`/`https`. |
| `sid` | no | Session id for metrics grouping. Defaults to `default`. |
| `ip` | no | IP override (IPv4/IPv6). |
| `h` | no | Base64 JSON custom headers (used by native `<video>`). |

**Request headers**

| Header | Description |
|---|---|
| `x-sp-headers` | Base64 JSON custom headers (used by hls.js/dash.js). |
| `range` | Forwarded upstream for byte-range/seek support. |

**Behavior**

- **Manifests** (`.m3u8` / `.mpd` or matching content-type) are buffered and rewritten:
  - HLS: child URLs rewritten to `/proxy?url=…&sid=…[&ip=…]`.
  - DASH: `<BaseURL>` made absolute (or injected); segments wrapped client-side.
  - Adds `x-sp-kind`, `x-sp-response-ms`, `x-sp-bytes` response headers.
- **Segments / media** are streamed through unbuffered while counting bytes.
- Passes through `content-type`, `cache-control`, `accept-ranges`, `content-range`, `etag`,
  `last-modified`.

**Responses**

- `200` / `206` — proxied body (or redirected status from upstream).
- `400` — missing/invalid `url`, or non-http(s) protocol.
- `502` — upstream fetch failed (e.g. bad IP override, DNS failure). JSON:
  `{ "error": "upstream fetch failed", "detail": "…" }`.

---

## GET /api/metrics

Returns the metrics recorded for a session.

**Query parameters**

| Param | Required | Description |
|---|---|---|
| `sid` | no | Session id. Defaults to `default`. |

**Response** `200`

```json
{
  "metrics": [
    {
      "id": "uuid",
      "url": "https://…/segment.ts",
      "kind": "manifest | segment | media | other",
      "method": "GET",
      "status": 200,
      "statusText": "OK",
      "httpVersion": "HTTP/1.1",
      "responseTimeMs": 42,
      "bytes": 123456,
      "throughputBps": 23510000,
      "contentType": "video/mp4",
      "startedAt": 1700000000000,
      "finishedAt": 1700000000042,
      "requestHeaders": [{ "name": "user-agent", "value": "…" }],
      "responseHeaders": [{ "name": "content-type", "value": "video/mp4" }]
    }
  ]
}
```

Metrics are stored in memory, capped at 500 entries per session (ring buffer).

---

## POST /api/metrics/clear

Clears all metrics for a session. Called automatically when a new stream is loaded.

**Body** (JSON)

| Field | Required | Description |
|---|---|---|
| `sid` | no | Session id. Defaults to `default`. |

**Response** `200`: `{ "ok": true }`

---

## GET /api/har

Exports the session's recorded requests as a **HAR 1.2** document, served as a file download.

**Query parameters**

| Param | Required | Description |
|---|---|---|
| `sid` | no | Session id. Defaults to `default`. |

**Response** `200`

- `Content-Type: application/json`
- `Content-Disposition: attachment; filename="streamplayer-<sid>-<ts>.har"`

**Body** — a valid HAR 1.2 log:

```json
{
  "log": {
    "version": "1.2",
    "creator": { "name": "StreamPlayer", "version": "1.1.0" },
    "pages": [],
    "entries": [
      {
        "startedDateTime": "2026-10-08T16:39:25.910Z",
        "time": 151,
        "request": {
          "method": "GET", "url": "https://…", "httpVersion": "HTTP/1.1",
          "cookies": [], "headers": [ … ], "queryString": [ … ],
          "headersSize": -1, "bodySize": 0
        },
        "response": {
          "status": 200, "statusText": "OK", "httpVersion": "HTTP/1.1",
          "cookies": [], "headers": [ … ],
          "content": { "size": 752, "mimeType": "application/vnd.apple.mpegurl" },
          "redirectURL": "", "headersSize": -1, "bodySize": 752
        },
        "cache": {},
        "timings": { "blocked": -1, "dns": -1, "connect": -1, "ssl": -1, "send": 0, "wait": 0, "receive": 151 },
        "_kind": "manifest",
        "_throughputBps": 39841
      }
    ]
  }
}
```

**Notes**

- Validates against the HAR 1.2 schema.
- **Manifest bodies are captured** as `response.content.text` (original pre-rewrite text).
  **Segment/media bodies are not** (they stream through unbuffered) — only headers, timing,
  and sizes are present for those.
- `statusText` may be empty for HTTP/2 responses (no status text in HTTP/2).

---

## GET /api/probe

A lightweight request to a stream URL to report metadata for the Media tab, without playing
it. Sends a `Range: bytes=0-1` request.

**Query parameters**

| Param | Required | Description |
|---|---|---|
| `url` | yes | The stream URL (URL-encoded). |
| `ip` | no | IP override. |
| `h` | no | Base64 JSON custom headers. |

**Response** `200`

```json
{
  "status": 206,
  "finalUrl": "https://…",
  "responseTimeMs": 140,
  "contentType": "application/vnd.apple.mpegurl",
  "contentLength": "752",
  "acceptRanges": "bytes",
  "headers": { "content-type": "…", "…": "…" }
}
```

- `400` — missing `url`.
- `502` — probe failed: `{ "error": "probe failed", "detail": "…" }`.

---

## GET /api/health

Liveness check.

**Response** `200`: `{ "ok": true }`
