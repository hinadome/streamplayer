# Stream Player — Documentation

Detailed documentation for the Stream Player application. For a quick overview and
getting-started instructions, see the [root README](../README.md).

## Contents

| Document | Description |
|---|---|
| [features.md](./features.md) | Every user-facing feature in detail: URL input, custom headers, playback engines, IP override, diagnostics tabs, and HAR export. |
| [architecture.md](./architecture.md) | How the system is put together — frontend, backend proxy, data flow, and the mechanisms behind custom headers, manifest rewriting, and IP override. |
| [page-structure.md](./page-structure.md) | The UI layout, React component tree, each component's responsibility, and how state flows through the app. |
| [api-reference.md](./api-reference.md) | The backend proxy and API endpoints: `/proxy`, `/api/metrics`, `/api/metrics/clear`, `/api/har`, `/api/probe`, `/api/health`. |
| [development.md](./development.md) | Project setup, scripts, folder layout, build/run instructions, and troubleshooting. |

## What is this app?

A web-based stream player that plays **MP4, HLS, DASH, and CMAF** streams (both **live**
and **VOD**) directly in the browser. It lets you attach **custom request headers**, force
the stream host to connect to a **specific IP address**, and inspect **quality and
performance diagnostics** including a per-request timeline and an exportable **HAR 1.2** file.

## High-level shape

- **Frontend**: Vite + React + TypeScript single-page app.
- **Backend**: a small Express proxy (Node) that injects headers, applies the IP override,
  rewrites manifests, sidesteps CORS, and measures per-request metrics.
- **Playback engines**: `hls.js` (HLS/CMAF), `dash.js` (DASH/CMAF), native `<video>` (MP4,
  and HLS on Safari). The browser's own Media Source Extensions pipeline does the decoding.
