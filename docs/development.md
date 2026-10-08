# Development Guide

Setup, scripts, project layout, and troubleshooting.

---

## Prerequisites

- **Node.js 26.x** (the project pins `undici@8.10.2`, compatible with Node 26's bundled
  undici 8.9.x — see
  the note under [architecture → IP override](./architecture.md#ip-override)). Other Node
  versions may require a matching `undici` version.
- **npm** (comes with Node).

## Install

```bash
npm install
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs backend (`:8787`) and Vite dev server (`:5173`) together via `concurrently`. Open http://localhost:5173. |
| `npm run dev:server` | Backend only, with `tsx watch` (auto-restart on change). |
| `npm run dev:client` | Vite dev server only. |
| `npm run build` | Type-checks and builds the frontend into `dist/`. |
| `npm run build:server` | Compiles the server (TypeScript → `dist-server/`). |
| `npm start` | Runs the compiled server (`node dist-server/server/index.js`). |
| `npm run preview` | Serves the built frontend with Vite's preview server. |

## Running in development

```bash
npm run dev
# backend on http://localhost:8787
# frontend on http://localhost:5173  ← open this
```

Vite proxies `/api` and `/proxy` to the backend, so you only interact with the frontend
origin.

## Production build

```bash
npm run build          # frontend → dist/
npm run build:server   # server   → dist-server/
npm start              # serve the compiled server on :8787
```

For a full deployment, serve the `dist/` static files and run the Express server, with a
reverse proxy routing `/api` and `/proxy` to the Express process.

## Project layout

```
streamplayer/
├─ index.html              # HTML shell
├─ package.json            # scripts + dependencies
├─ vite.config.ts          # Vite config + dev proxy to :8787
├─ tsconfig.json           # client TS config
├─ tsconfig.server.json    # server TS config (outDir dist-server)
├─ README.md               # general overview
├─ CHANGELOG.md            # version history
├─ docs/                   # this documentation
├─ shared/
│  └─ types.ts             # types shared by client and server
├─ server/
│  └─ index.ts             # Express proxy + API
└─ src/
   ├─ main.tsx             # React entry
   ├─ App.tsx              # top-level component / state
   ├─ styles.css           # global dark theme
   ├─ lib/
   │  └─ stream.ts         # format detection, header encoding, proxyUrl
   └─ components/
      ├─ StreamInput.tsx   # URL + headers + IP + samples form
      ├─ Player.tsx        # engine selection + playback + stats
      └─ Diagnostics.tsx   # quality / performance / media tabs + HAR
```

## Shared types

`shared/types.ts` is imported by both the client and server to keep the metric and stats
shapes in sync: `StreamFormat`, `HeaderPair`, `RequestMetric`, `ProxyMetricsResponse`,
`PlayerStats`.

## How playback is wired (quick pointer)

- Engine selection and header/IP wiring: `src/components/Player.tsx`.
- Format detection and URL/header helpers: `src/lib/stream.ts`.
- Proxy, manifest rewriting, metrics, HAR, probe: `server/index.ts`.

See [architecture.md](./architecture.md) for the full picture.

## Troubleshooting

**`invalid onError method` from the server / fetch fails for every request**
The standalone `undici` version doesn't match Node's bundled version. Check
`node -e "console.log(process.versions.undici)"` and install the matching `undici` version.

**A stream shows a `403` or won't load**
Some CDNs reject requests based on `User-Agent`, `Referer`, or missing auth. Try adding the
appropriate custom headers. Also check the Diagnostics → Performance tab for the failing
request's status, or the Media tab's source probe.

**HLS live sample fails with "level load error"**
The specific test stream may be offline or serving broken variant URLs. Try a different
sample; the proxy and rewriting are independent of any one stream's availability.

**CORS errors in the browser**
All stream traffic should go through `/proxy`. If you see CORS errors, confirm the request is
hitting the proxy (not the origin directly) and that the dev server proxy is running.

**Metrics are empty**
Metrics are per-session (`sid`) and in-memory. They clear on new loads and on server restart.
Make sure a stream has actually started fetching.

**A request returns `403 request blocked`**
The SSRF guard refuses to fetch private/loopback/link-local/metadata addresses. If you are
intentionally testing against a localhost or internal origin, start the server with
`ALLOW_PRIVATE_HOSTS=1` (e.g. `ALLOW_PRIVATE_HOSTS=1 npm run dev:server`).

## Notes & limitations

- Metrics are in-memory only (not persisted); capped at 500 per session.
- HAR export does not include response bodies (segments stream through unbuffered).
- `npm install` may report npm audit advisories from transitive dependencies; review before
  running `audit fix --force`, which can introduce breaking changes.
