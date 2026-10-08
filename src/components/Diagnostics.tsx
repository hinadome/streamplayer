import { useEffect, useState } from 'react';
import type { PlayerStats, RequestMetric } from '../../shared/types';
import { encodeHeaders } from '../lib/stream';

interface Props {
  sessionId: string;
  stats: PlayerStats | null;
  url: string | null;
  headers: Record<string, string>;
  ip: string;
  active: boolean;
}

interface ProbeResult {
  status: number;
  finalUrl: string;
  responseTimeMs: number;
  contentType: string;
  contentLength: string;
  acceptRanges: string;
  headers: Record<string, string>;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtBps(bps: number): string {
  if (bps <= 0) return '—';
  if (bps < 1000) return `${bps.toFixed(0)} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} Kbps`;
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

function fmtTime(s: number): string {
  if (!isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function Diagnostics({ sessionId, stats, url, headers, ip, active }: Props) {
  const [metrics, setMetrics] = useState<RequestMetric[]>([]);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'quality' | 'performance' | 'media' | 'manifests'>('quality');
  const [selectedManifestId, setSelectedManifestId] = useState<string | null>(null);

  // Poll proxy metrics while active.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/metrics?sid=${encodeURIComponent(sessionId)}`);
        const data = await res.json();
        if (!cancelled) setMetrics(data.metrics || []);
      } catch { /* ignore */ }
    };
    poll();
    const t = window.setInterval(poll, 1500);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [active, sessionId]);

  // Probe media info when url changes.
  useEffect(() => {
    if (!url) { setProbe(null); return; }
    setProbeErr(null);
    const enc = encodeHeaders(headers);
    const ipSuffix = ip ? `&ip=${encodeURIComponent(ip)}` : '';
    fetch(`/api/probe?url=${encodeURIComponent(url)}&h=${encodeURIComponent(enc)}${ipSuffix}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) setProbeErr(d.detail || d.error); else setProbe(d); })
      .catch((e) => setProbeErr(String(e)));
  }, [url, headers, ip]);

  // Aggregate performance numbers.
  const totalBytes = metrics.reduce((a, m) => a + m.bytes, 0);
  const segMetrics = metrics.filter((m) => m.kind === 'segment' || m.kind === 'media');
  const avgResp = metrics.length ? metrics.reduce((a, m) => a + m.responseTimeMs, 0) / metrics.length : 0;
  const avgThroughput = segMetrics.length
    ? segMetrics.reduce((a, m) => a + m.throughputBps, 0) / segMetrics.length
    : 0;
  const maxResp = Math.max(1, ...metrics.map((m) => m.responseTimeMs));

  // Manifests captured so far (m3u8 / mpd) with their original body text.
  const manifests = metrics.filter((m) => m.kind === 'manifest' && typeof m.body === 'string');

  // Download the collected requests as a HAR 1.2 file via the server endpoint.
  const downloadHar = () => {
    const a = document.createElement('a');
    a.href = `/api/har?sid=${encodeURIComponent(sessionId)}`;
    a.download = `streamplayer-${sessionId}.har`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="panel">
      <h2>Diagnostics</h2>
      <div className="format-pills" style={{ marginBottom: 14 }}>
        {(['quality', 'performance', 'media', 'manifests'] as const).map((t) => (
          <span key={t} className={`pill ${tab === t ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => setTab(t)}>
            {t}
          </span>
        ))}
      </div>

      {tab === 'quality' && (
        <>
          <div style={{ marginBottom: 10 }}>
            {stats?.isLive ? <span className="badge live">● LIVE</span> : <span className="badge vod">VOD</span>}
            {stats?.engine && <span className="muted small" style={{ marginLeft: 8 }}>engine: {stats.engine}</span>}
          </div>
          <div className="stat-grid">
            <div className="stat">
              <div className="k">Resolution</div>
              <div className="v">{stats?.levelWidth ? `${stats.levelWidth}×${stats.levelHeight}` : '—'}</div>
            </div>
            <div className="stat">
              <div className="k">Current Bitrate</div>
              <div className="v">{stats?.levelBitrateKbps ? stats.levelBitrateKbps : '—'} <small>kbps</small></div>
            </div>
            <div className="stat">
              <div className="k">Est. Bandwidth</div>
              <div className="v">{stats?.estimatedBandwidthKbps ? stats.estimatedBandwidthKbps : '—'} <small>kbps</small></div>
            </div>
            <div className="stat">
              <div className="k">Buffer Ahead</div>
              <div className="v">{stats ? stats.bufferSeconds.toFixed(1) : '—'} <small>s</small></div>
            </div>
            <div className="stat">
              <div className="k">Dropped Frames</div>
              <div className="v">{stats ? stats.droppedFrames : '—'} <small>/ {stats?.totalFrames ?? 0}</small></div>
            </div>
            <div className="stat">
              <div className="k">{stats?.isLive ? 'Live Latency' : 'Progress'}</div>
              <div className="v">
                {stats?.isLive
                  ? (stats.liveLatencySeconds != null ? `${stats.liveLatencySeconds.toFixed(1)}s` : '—')
                  : `${fmtTime(stats?.currentTime ?? 0)} / ${fmtTime(stats?.duration ?? 0)}`}
              </div>
            </div>
          </div>

          {stats?.levels && stats.levels.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <label>Available Quality Levels ({stats.levels.length})</label>
              <div className="metrics-scroll" style={{ maxHeight: 140 }}>
                <table className="metrics">
                  <thead><tr><th>#</th><th>Resolution</th><th>Bitrate</th></tr></thead>
                  <tbody>
                    {stats.levels.map((l, i) => (
                      <tr key={i} style={i === stats.currentLevel ? { color: 'var(--accent)' } : undefined}>
                        <td>{i}{i === stats.currentLevel ? ' ◀' : ''}</td>
                        <td>{l.width}×{l.height}</td>
                        <td>{l.bitrateKbps} kbps</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {stats?.lastError && <div className="err">{stats.lastError}</div>}
        </>
      )}

      {tab === 'performance' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <span className="muted small">
              {metrics.length} request{metrics.length === 1 ? '' : 's'} captured
            </span>
            <button
              type="button"
              className="secondary"
              onClick={downloadHar}
              disabled={metrics.length === 0}
              title={metrics.length === 0 ? 'No requests captured yet' : 'Export requests as a HAR 1.2 file'}
            >
              ⬇ Download HAR
            </button>
          </div>
          <div className="stat-grid">
            <div className="stat">
              <div className="k">Requests</div>
              <div className="v">{metrics.length}</div>
            </div>
            <div className="stat">
              <div className="k">Total Transferred</div>
              <div className="v">{fmtBytes(totalBytes)}</div>
            </div>
            <div className="stat">
              <div className="k">Avg Response Time</div>
              <div className="v">{avgResp.toFixed(0)} <small>ms</small></div>
            </div>
            <div className="stat">
              <div className="k">Avg Throughput</div>
              <div className="v" style={{ fontSize: 15 }}>{fmtBps(avgThroughput)}</div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <label>Request Timeline (response time)</label>
            <div className="legend">
              <span><i style={{ background: 'var(--warn)' }} /> manifest</span>
              <span><i style={{ background: 'var(--accent)' }} /> segment</span>
              <span><i style={{ background: 'var(--accent-2)' }} /> media</span>
              <span><i style={{ background: 'var(--muted)' }} /> other</span>
            </div>
            <div className="timeline">
              {metrics.slice(-40).reverse().map((m) => (
                <div className="tl-bar" key={m.id}>
                  <span className="lbl">{m.kind}</span>
                  <span className="track">
                    <span
                      className={`fill ${m.kind}`}
                      style={{ width: `${Math.max(2, (m.responseTimeMs / maxResp) * 100)}%` }}
                    />
                  </span>
                  <span className="ms">{m.responseTimeMs}ms</span>
                </div>
              ))}
              {metrics.length === 0 && <div className="muted small">No requests yet.</div>}
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <label>Recent Requests</label>
            <div className="metrics-scroll">
              <table className="metrics">
                <thead>
                  <tr><th>Kind</th><th>Status</th><th>Time</th><th>Size</th><th>Throughput</th><th>URL</th></tr>
                </thead>
                <tbody>
                  {metrics.slice(-60).reverse().map((m) => (
                    <tr key={m.id}>
                      <td>{m.kind}</td>
                      <td className={m.status >= 200 && m.status < 300 ? 'ok' : 'err'}>{m.status || 'ERR'}</td>
                      <td>{m.responseTimeMs}ms</td>
                      <td>{fmtBytes(m.bytes)}</td>
                      <td>{fmtBps(m.throughputBps)}</td>
                      <td className="url" title={m.url}>{m.url.split('/').pop()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'media' && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="k">Video Codec</div>
              <div className="v" style={{ fontSize: 14 }}>{stats?.videoCodec || '—'}</div>
            </div>
            <div className="stat">
              <div className="k">Audio Codec</div>
              <div className="v" style={{ fontSize: 14 }}>{stats?.audioCodec || '—'}</div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <label>Source Probe</label>
            {probeErr && <div className="err">{probeErr}</div>}
            {!probe && !probeErr && <div className="muted small">Probing…</div>}
            {probe && (
              <div className="kv">
                <span className="k">HTTP Status</span><span className="v">{probe.status}</span>
                <span className="k">Content-Type</span><span className="v">{probe.contentType || '—'}</span>
                <span className="k">Content-Length</span><span className="v">{probe.contentLength ? fmtBytes(Number(probe.contentLength)) : '—'}</span>
                <span className="k">Accept-Ranges</span><span className="v">{probe.acceptRanges || '—'}</span>
                <span className="k">Probe Time</span><span className="v">{probe.responseTimeMs} ms</span>
                <span className="k">Final URL</span><span className="v">{probe.finalUrl}</span>
              </div>
            )}
          </div>

          {probe && (
            <div style={{ marginTop: 14 }}>
              <label>Response Headers</label>
              <div className="kv">
                {Object.entries(probe.headers).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <span className="k">{k}</span>
                    <span className="v">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'manifests' && (
        <>
          {manifests.length === 0 && (
            <div className="muted small">
              No manifests captured yet. Load an HLS (.m3u8) or DASH (.mpd) stream.
            </div>
          )}
          {manifests.length > 0 && (() => {
            const selected =
              manifests.find((m) => m.id === selectedManifestId) ?? manifests[manifests.length - 1];
            return (
              <>
                <label>Captured Manifests ({manifests.length})</label>
                <div className="metrics-scroll" style={{ maxHeight: 120, marginBottom: 10 }}>
                  <table className="metrics">
                    <thead><tr><th>Type</th><th>Size</th><th>URL</th></tr></thead>
                    <tbody>
                      {manifests.map((m) => {
                        const isMpd = m.url.toLowerCase().includes('.mpd') || m.contentType.includes('dash');
                        return (
                          <tr
                            key={m.id}
                            onClick={() => setSelectedManifestId(m.id)}
                            style={{
                              cursor: 'pointer',
                              color: m.id === selected.id ? 'var(--accent)' : undefined,
                            }}
                          >
                            <td>{isMpd ? 'DASH' : 'HLS'}</td>
                            <td>{fmtBytes(m.bytes)}</td>
                            <td className="url" title={m.url}>{m.url.split('/').pop()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className="muted small" title={selected.url}>
                    {selected.url.length > 60 ? '…' + selected.url.slice(-60) : selected.url}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => navigator.clipboard?.writeText(selected.body ?? '')}
                    title="Copy manifest content to clipboard"
                  >
                    ⧉ Copy
                  </button>
                </div>
                <pre
                  style={{
                    background: 'var(--panel-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: 10,
                    maxHeight: 320,
                    overflow: 'auto',
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: 'pre',
                    margin: 0,
                  }}
                >
                  {selected.body}
                </pre>
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
