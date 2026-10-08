import { useRef, useState } from 'react';
import { StreamInput } from './components/StreamInput';
import { Player } from './components/Player';
import { Diagnostics } from './components/Diagnostics';
import type { HeaderPair, PlayerStats, StreamFormat } from '../shared/types';
import { headersToObject } from './lib/stream';

interface ActiveStream {
  url: string;
  headers: Record<string, string>;
  format: StreamFormat;
  ip: string;
}

export function App() {
  const [active, setActive] = useState<ActiveStream | null>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Stable session id for correlating proxy metrics with this tab.
  const sessionId = useRef(Math.random().toString(36).slice(2)).current;

  const handleLoad = async (url: string, headerPairs: HeaderPair[], format: StreamFormat, ipOverride: string) => {
    setLoading(true);
    setError(null);
    setStats(null);
    // Clear previous metrics for a fresh session view.
    try {
      await fetch('/api/metrics/clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sid: sessionId }),
      });
    } catch { /* ignore */ }
    setActive({ url, headers: headersToObject(headerPairs), format, ip: ipOverride });
    setLoading(false);
  };

  const handleStop = () => {
    setActive(null);
    setStats(null);
    setError(null);
  };

  return (
    <div className="app">
      <h1>🎬 Stream Player</h1>
      <p className="subtitle">
        MP4 · HLS · DASH · CMAF — live &amp; VOD · custom headers · quality &amp; performance diagnostics
      </p>

      <div className="layout">
        <div>
          {active ? (
            <Player
              key={active.url + JSON.stringify(active.headers) + active.ip}
              url={active.url}
              format={active.format}
              headers={active.headers}
              ip={active.ip}
              sessionId={sessionId}
              onStats={setStats}
              onError={setError}
            />
          ) : (
            <div className="panel">
              <h2>Player</h2>
              <div className="muted" style={{ padding: '40px 0', textAlign: 'center' }}>
                Enter a stream URL and press <strong>Load &amp; Play</strong>.
              </div>
            </div>
          )}
          {error && <div className="panel"><div className="err">⚠ {error}</div></div>}
        </div>

        <div>
          <StreamInput onLoad={handleLoad} onStop={handleStop} loading={loading} playing={!!active} />
          <Diagnostics
            sessionId={sessionId}
            stats={stats}
            url={active?.url ?? null}
            headers={active?.headers ?? {}}
            ip={active?.ip ?? ''}
            active={!!active}
          />
        </div>
      </div>
    </div>
  );
}
