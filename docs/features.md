# Features

A detailed description of every feature in the Stream Player. For how these are implemented
internally, see [architecture.md](./architecture.md).

---

## 1. Stream URL input

Paste any stream URL into the **Stream URL** field and press **Load & Play**. The app
auto-detects the format from the URL extension, or you can force a format with the pills
below the field.

- **Auto-detection** maps extensions to engines:
  - `.m3u8` → HLS
  - `.mpd` → DASH
  - `.mp4`, `.m4v`, `.mov` → MP4
  - `.cmfv`, `.cmfa` → CMAF
  - URLs containing `m3u8` / `mpd` as a fallback → HLS / DASH
- **Format pills**: `auto`, `mp4`, `hls`, `dash`, `cmaf`. When `auto` is selected and a URL
  is present, the pill shows the detected format, e.g. `auto (hls)`.

## 2. Custom request headers

Add any number of header name/value pairs (for example `Authorization: Bearer <token>`).
These headers are applied to **every** upstream request — the manifest *and* all child
segment/media requests — not just the first one.

- Use **+ Add header** to add rows and **✕** to remove them.
- Empty header names are ignored.
- Headers are transported to the proxy and forwarded upstream. See
  [architecture.md](./architecture.md#custom-headers) for the transport mechanism.

Typical uses: bearer tokens, API keys, cookies, `Referer`, or a custom `User-Agent`.

## 3. In-browser playback

Playback happens entirely in the browser — no external player or CLI tool is launched. The
`Player` component selects one of three engines:

| Format | Engine | Notes |
|---|---|---|
| HLS, CMAF-over-HLS | **hls.js** | Adaptive bitrate; feeds the browser via Media Source Extensions. |
| HLS on Safari | native `<video>` | Safari plays HLS natively. |
| DASH, CMAF-over-DASH | **dash.js** | Adaptive bitrate; feeds the browser via Media Source Extensions. |
| MP4 | native `<video>` | Progressive playback by the browser. |

Both **live** and **VOD** are supported and auto-detected. The active engine is shown in
the Diagnostics → Quality tab (`engine: hls.js | dash.js | native`).

## 4. IP override

Optionally force the stream's host to connect to a **specific IP address** — useful for
targeting a particular CDN edge, origin, or staging box.

- The original **hostname is preserved** for the HTTP `Host` header and TLS SNI/certificate
  validation, so HTTPS still verifies correctly.
- The override applies to the manifest *and* all child segment/media requests.
- Accepts IPv4 or IPv6. Invalid input is rejected in the UI, and the server falls back to
  normal DNS if the value is not a valid IP.
- The field shows a preview: `→ host will resolve to <ip>`.

See [architecture.md](./architecture.md#ip-override) for how the connection is redirected
while keeping SNI intact.

## 5. Diagnostics

A three-tab panel updated live while a stream plays.

### Quality tab
- **Live / VOD** badge and active **engine**.
- **Resolution** of the current rendition.
- **Current bitrate** (kbps) of the selected level.
- **Estimated bandwidth** (player's throughput estimate).
- **Buffer ahead** (seconds buffered beyond the playhead).
- **Dropped frames** / total frames.
- **Live latency** (for live) or **progress** `current / duration` (for VOD).
- **Available quality levels** table (resolution + bitrate), highlighting the active one.

### Performance tab
- **Requests** count, **total transferred**, **average response time**, **average throughput**.
- **Request timeline**: horizontal bars per request, colored by kind
  (manifest / segment / media / other), sized by response time.
- **Recent requests** table: kind, status, time, size, throughput, and resource name.
- **Download HAR** button — see feature 6.
- Metrics are polled from the proxy roughly every 1.5 seconds.

### Media tab
- **Video codec** and **audio codec** of the current stream.
- **Source probe**: a lightweight request to the stream URL reporting HTTP status,
  content-type, content-length, accept-ranges, probe time, and the final (post-redirect) URL.
- **Response headers**: all headers returned by the probe.

### Manifests tab
- A list of every HLS/DASH manifest captured so far (type, size, resource name).
- Click a row to view that manifest's **original content** (the real upstream `.m3u8` /
  `.mpd` text, before the proxy rewrites child URLs) in a scrollable viewer.
- A **Copy** button copies the selected manifest's content to the clipboard.

## 6. HAR export

The Performance tab's **Download HAR** button exports every request the proxy observed as a
standards-compliant **HAR 1.2** file.

- Importable into Chrome DevTools (Network → Import HAR), Charles, Fiddler, or any HAR viewer.
- Each entry includes request/response headers (including your custom headers), status,
  timing, sizes, and content-type, plus custom `_kind` and `_throughputBps` extension fields.
- **Manifest bodies are included** as `response.content.text` (the original, pre-rewrite
  `.m3u8` / `.mpd` text). **Segment/media bodies are not** — that data is streamed through
  the proxy without buffering, so only headers/timing/sizes are captured for those.

See [api-reference.md](./api-reference.md#get-apihar) for the endpoint and output schema.

## 7. Sample streams

The input panel includes **Samples** pills that populate the URL field with known-working
test streams:

- HLS VOD (Mux)
- HLS Live (Mux)
- HLS (Apple bipbop)
- DASH VOD
- DASH Live
- MP4 (W3C)
