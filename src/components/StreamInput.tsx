import { useState } from 'react';
import type { HeaderPair, StreamFormat } from '../../shared/types';
import { detectFormat } from '../lib/stream';

interface Props {
  onLoad: (url: string, headers: HeaderPair[], format: StreamFormat, ipOverride: string) => void;
  onStop: () => void;
  loading: boolean;
  playing: boolean;
}

const FORMATS: StreamFormat[] = ['auto', 'mp4', 'hls', 'dash', 'cmaf'];

const SAMPLES: { label: string; url: string }[] = [
  { label: 'HLS VOD (Mux)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { label: 'HLS Live (Mux)', url: 'https://test-streams.mux.dev/pts_shift/master.m3u8' },
  { label: 'HLS (Apple bipbop)', url: 'https://d2zihajmogu5jn.cloudfront.net/bipbop-advanced/bipbop_16x9_variant.m3u8' },
  { label: 'DASH VOD', url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd' },
  { label: 'DASH Live', url: 'https://livesim2.dashif.org/livesim2/testpic_2s/Manifest.mpd' },
  { label: 'MP4 (W3C)', url: 'https://media.w3.org/2010/05/sintel/trailer.mp4' },
];

export function StreamInput({ onLoad, onStop, loading, playing }: Props) {
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderPair[]>([{ key: '', value: '' }]);
  const [format, setFormat] = useState<StreamFormat>('auto');
  const [ipOverride, setIpOverride] = useState('');

  const detected = url ? detectFormat(url) : null;

  // Extract the host so we can show the user what the override will target.
  let host = '';
  try { host = url ? new URL(url).host : ''; } catch { host = ''; }

  const ipLooksValid =
    ipOverride.trim() === '' ||
    /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ipOverride.trim()) ||
    /:/.test(ipOverride.trim()); // loose IPv6 check

  const updateHeader = (i: number, patch: Partial<HeaderPair>) => {
    setHeaders((prev) => prev.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  };
  const addHeader = () => setHeaders((prev) => [...prev, { key: '', value: '' }]);
  const removeHeader = (i: number) => setHeaders((prev) => prev.filter((_, idx) => idx !== i));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !ipLooksValid) return;
    onLoad(url.trim(), headers, format, ipOverride.trim());
  };

  return (
    <div className="panel">
      <h2>Stream Source</h2>
      <form onSubmit={submit}>
        <label htmlFor="url">Stream URL</label>
        <div className="row">
          <input
            id="url"
            type="text"
            placeholder="https://example.com/stream.m3u8"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="format-pills">
          {FORMATS.map((f) => (
            <span
              key={f}
              className={`pill ${format === f ? 'active' : ''}`}
              onClick={() => setFormat(f)}
              role="button"
              tabIndex={0}
            >
              {f === 'auto' && detected ? `auto (${detected})` : f}
            </span>
          ))}
        </div>

        <div style={{ marginTop: 16 }}>
          <label>Custom Request Headers</label>
          {headers.map((h, i) => (
            <div className="header-row" key={i}>
              <input
                type="text"
                placeholder="Header name (e.g. Authorization)"
                value={h.key}
                onChange={(e) => updateHeader(i, { key: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              <input
                type="text"
                placeholder="Value (e.g. Bearer token)"
                value={h.value}
                onChange={(e) => updateHeader(i, { value: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="ghost" onClick={() => removeHeader(i)} aria-label="Remove header">
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="secondary" onClick={addHeader}>
            + Add header
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <label htmlFor="ip">
            IP Override <span className="muted">(optional — connect to a specific IP, keep hostname for Host/SNI)</span>
          </label>
          <input
            id="ip"
            type="text"
            placeholder="e.g. 23.214.95.217"
            value={ipOverride}
            onChange={(e) => setIpOverride(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            style={!ipLooksValid ? { borderColor: 'var(--danger)' } : undefined}
          />
          {ipOverride.trim() !== '' && host && (
            <div className="muted small" style={{ marginTop: 4 }}>
              {ipLooksValid
                ? `→ ${host} will resolve to ${ipOverride.trim()}`
                : 'Enter a valid IPv4 or IPv6 address'}
            </div>
          )}
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button type="submit" disabled={loading || !url.trim() || !ipLooksValid}>
            {loading ? 'Loading…' : 'Load & Play'}
          </button>
          {playing && (
            <button type="button" className="danger" onClick={onStop}>
              Stop
            </button>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <label>Samples</label>
          <div className="format-pills">
            {SAMPLES.map((s) => (
              <span key={s.url} className="pill" role="button" tabIndex={0} onClick={() => setUrl(s.url)}>
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </form>
    </div>
  );
}
