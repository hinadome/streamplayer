# Page Structure

The UI layout, the React component tree, and how state flows through the app.

---

## Layout

The page is a single screen with a header and a two-column responsive grid. Below ~980px the
grid collapses to one column.

```
┌─────────────────────────────────────────────────────────────┐
│ 🎬 Stream Player                                              │
│ MP4 · HLS · DASH · CMAF — live & VOD · custom headers · …     │
├───────────────────────────────┬─────────────────────────────┤
│ LEFT COLUMN                   │ RIGHT COLUMN                 │
│ ┌───────────────────────────┐ │ ┌─────────────────────────┐ │
│ │ Player                    │ │ │ Stream Source           │ │
│ │  <video> + format badge   │ │ │  URL input              │ │
│ └───────────────────────────┘ │ │  format pills           │ │
│ ┌───────────────────────────┐ │ │  custom headers         │ │
│ │ Error (if any)            │ │ │  IP override            │ │
│ └───────────────────────────┘ │ │  Load & Play / Stop     │ │
│                               │ │  Samples                │ │
│                               │ ├─────────────────────────┤ │
│                               │ │ Diagnostics             │ │
│                               │ │  [Quality|Perf|Media]   │ │
│                               │ └─────────────────────────┘ │
└───────────────────────────────┴─────────────────────────────┘
```

## Component tree

```
main.tsx
└─ App                     (src/App.tsx)
   ├─ Player               (src/components/Player.tsx)      — left column
   ├─ (inline error panel)
   ├─ StreamInput          (src/components/StreamInput.tsx) — right column, top
   └─ Diagnostics          (src/components/Diagnostics.tsx) — right column, bottom
```

## Entry points

| File | Role |
|---|---|
| `index.html` | HTML shell with `<div id="root">` and the module script. |
| `src/main.tsx` | Mounts `<App>` into `#root`; imports global `styles.css`. |
| `src/styles.css` | Dark theme, layout grid, panels, stats, tables, timeline, badges. |

## Components

### App (`src/App.tsx`)
The top-level container and single source of truth for shared state.

- **State**: `active` (the loaded stream: url, headers, format, ip), `stats` (latest
  `PlayerStats`), `error`, `loading`, and a stable per-tab `sessionId`.
- **`handleLoad`**: clears previous metrics (`POST /api/metrics/clear`), then sets the active
  stream, which mounts/remounts `Player`.
- **`handleStop`**: clears the active stream and resets stats/error.
- Passes `sessionId` to both `Player` and `Diagnostics` so they correlate on the same metrics
  session. The `Player`'s React `key` includes url+headers+ip, so changing any of them fully
  remounts the player (clean engine teardown/retry).

### Player (`src/components/Player.tsx`)
Owns the `<video>` element and the active playback engine.

- Chooses hls.js / dash.js / native based on resolved format and browser support.
- Wires custom headers and the IP override into each engine's request path.
- Runs a ~1s stats loop reading buffer, dropped frames, time, duration, and engine-specific
  bandwidth/latency, emitting `PlayerStats` via the `onStats` callback.
- Reports fatal errors via `onError`.
- Cleans up (destroys the engine, clears timers, resets `<video>`) on unmount or when
  url/format/sessionId/ip change.

### StreamInput (`src/components/StreamInput.tsx`)
The source-configuration form (right column, top).

- **State**: `url`, `headers[]` (name/value rows), `format`, `ipOverride`.
- Shows auto-detected format on the `auto` pill, validates the IP, previews the override
  target host, and disables **Load & Play** until the URL is present and the IP is valid.
- Calls `onLoad(url, headers, format, ipOverride)` on submit.
- Renders the **Samples** pills.

### Diagnostics (`src/components/Diagnostics.tsx`)
The four-tab metrics panel (right column, bottom).

- **State**: `metrics[]` (polled from `/api/metrics`), `probe` (`/api/probe` result),
  `probeErr`, and the active `tab`.
- **Quality tab**: renders from the `stats` prop (live `PlayerStats`).
- **Performance tab**: renders aggregates + timeline + table from `metrics`, and hosts the
  **Download HAR** button (`downloadHar` → `/api/har`).
- **Media tab**: codecs from `stats`, plus the source probe and its response headers.
- **Manifests tab**: lists captured HLS/DASH manifests (from `metrics` where `kind` is
  `manifest` and a `body` is present) and shows the selected manifest's original content.

## State flow

```
StreamInput.onLoad ──▶ App.handleLoad ──▶ App.active ──▶ Player (plays)
                                           │
                                           ├──▶ Player.onStats ──▶ App.stats ──▶ Diagnostics (Quality/Media)
                                           └──▶ Diagnostics polls /api/metrics ──▶ Performance
```

- `App` holds shared state; children receive props and communicate up via callbacks.
- `sessionId` ties the player's proxied requests to the metrics the Diagnostics panel reads.

## Styling

A single `src/styles.css` defines a dark theme using CSS custom properties (`--bg`,
`--panel`, `--accent`, etc.). Key classes: `.app`, `.layout`, `.panel`, `.stat-grid`,
`.stat`, `.metrics` (tables), `.timeline` / `.tl-bar`, `.pill` / `.format-pills`, and
`.badge` (live/vod/format). No CSS framework is used.
