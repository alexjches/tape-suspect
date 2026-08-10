'use client';
// src/components/lobby/VideoSetupPanel.tsx
// The host loads the two tapes here. Non-hosts only ever see booleans —
// the URLs themselves never leave the server (see sanitizeRoom).

import { useState, useEffect } from 'react';
import { RoomPublic, Preset } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { isValidVideoUrl, parseVideoUrl } from '@/lib/videoParser';
import { PresetLibrary } from './PresetLibrary';

interface Props {
  room: RoomPublic;
  isHost: boolean;
  actions: RoomActions;
  code: string;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px',
  border: '3px solid #000',
  borderRadius: 6,
  color: '#000',
  background: '#fff',
  // The UI face, as every other field in the app takes — a handwriting font is
  // a poor thing to read a pasted URL back in.
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  fontSize: '1rem',
  marginTop: 5,
};

export function VideoSetupPanel({ room, isHost, actions, code }: Props) {
  const [normalUrl, setNormalUrl] = useState('');
  const [imposterUrl, setImposterUrl] = useState('');
  const [showPresets, setShowPresets] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);

  const normalValid = !normalUrl || isValidVideoUrl(normalUrl);
  const imposterValid = !imposterUrl || isValidVideoUrl(imposterUrl);

  // Debounce updates to server
  useEffect(() => {
    if (!isHost) return;
    const t = setTimeout(() => {
      if (normalUrl !== '' && isValidVideoUrl(normalUrl)) {
        actions.updateSettings(code, { normalVideoUrl: normalUrl });
      }
    }, 800);
    return () => clearTimeout(t);
  }, [normalUrl, isHost, code, actions]);

  useEffect(() => {
    if (!isHost) return;
    const t = setTimeout(() => {
      if (imposterUrl !== '' && isValidVideoUrl(imposterUrl)) {
        actions.updateSettings(code, { imposterVideoUrl: imposterUrl });
      }
    }, 800);
    return () => clearTimeout(t);
  }, [imposterUrl, isHost, code, actions]);

  function handlePresetLoad(preset: Preset) {
    setNormalUrl(preset.normalVideoUrl);
    setImposterUrl(preset.imposterVideoUrl);
    setShowPresets(false);
  }

  async function handleSavePreset() {
    if (!saveName.trim() || !normalUrl || !imposterUrl) return;
    setSaving(true);
    await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: saveName, normalVideoUrl: normalUrl, imposterVideoUrl: imposterUrl }),
    });
    setSaving(false);
    setSaveName('');
  }

  // Whether this panel should be on screen at all is CustomContentPanel's
  // call — it renders this only for a video mode with custom content switched
  // on. The panel used to make that decision itself, off a `genre !== custom`
  // test that stopped meaning anything the moment Custom stopped being a genre.
  const heading = (
    <h3
      className="brutal-title"
      style={{ fontSize: '1.1rem', color: '#000', textShadow: 'none' }}
    >
      📼 TAPE LIBRARY
    </h3>
  );

  if (!isHost) {
    return (
      <div className="brutal-card yellow" style={{ padding: 16, marginTop: 10 }}>
        {heading}
        <div className="osd-menu" style={{ marginTop: 12 }}>
          <div className="osd-menu-row">
            <span>CREW TAPE:</span>
            <span
              style={{
                color: room.settings.hasNormalVideo ? 'var(--neon-green)' : '#ff5577',
              }}
            >
              {room.settings.hasNormalVideo ? 'LOADED' : 'EMPTY'}
            </span>
          </div>
          <div className="osd-menu-row">
            <span>SUSPECT TAPE:</span>
            <span
              style={{
                color: room.settings.hasImposterVideo ? 'var(--neon-green)' : '#ff5577',
              }}
            >
              {room.settings.hasImposterVideo ? 'LOADED' : 'EMPTY'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="brutal-card yellow" style={{ padding: 16, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {heading}
        <button
          id="toggle-presets-btn"
          className="btn-brutal dark"
          style={{ fontSize: '0.75rem', padding: '4px 10px' }}
          onClick={() => setShowPresets(!showPresets)}
        >
          📚 PRESETS
        </button>
      </div>

      {showPresets && <PresetLibrary onSelect={handlePresetLoad} />}

      <div style={{ marginTop: 12 }}>
        <label
          htmlFor="panel-normal-url"
          style={{ fontFamily: 'var(--font-brutal)', fontSize: '0.85rem', textTransform: 'uppercase' }}
        >
          🎬 Crew tape — everyone but the suspect
        </label>
        <input
          id="panel-normal-url"
          type="url"
          value={normalUrl}
          onChange={(e) => setNormalUrl(e.target.value)}
          style={{
            ...inputStyle,
            borderColor: normalUrl ? (normalValid ? '#00ff88' : '#ff0055') : '#000',
          }}
          placeholder="https://youtube.com/watch?v=…"
        />
        {normalUrl && normalValid && (
          <p className="osd-text" style={{ fontSize: '0.7rem', color: '#0a5c33', marginTop: 4 }}>
            ✓ {parseVideoUrl(normalUrl).type.toUpperCase()} DETECTED
          </p>
        )}
        {normalUrl && !normalValid && (
          <p className="osd-text" style={{ fontSize: '0.7rem', color: '#8c0030', marginTop: 4 }}>
            ⚠ UNRECOGNIZED URL FORMAT
          </p>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <label
          htmlFor="panel-imposter-url"
          style={{ fontFamily: 'var(--font-brutal)', fontSize: '0.85rem', textTransform: 'uppercase' }}
        >
          👁️ Suspect tape — only they see it
        </label>
        <input
          id="panel-imposter-url"
          type="url"
          value={imposterUrl}
          onChange={(e) => setImposterUrl(e.target.value)}
          style={{
            ...inputStyle,
            borderColor: imposterUrl ? (imposterValid ? '#00ff88' : '#ff0055') : '#000',
          }}
          placeholder="https://youtube.com/watch?v=…"
        />
        {imposterUrl && imposterValid && (
          <p className="osd-text" style={{ fontSize: '0.7rem', color: '#0a5c33', marginTop: 4 }}>
            ✓ {parseVideoUrl(imposterUrl).type.toUpperCase()} DETECTED
          </p>
        )}
        {imposterUrl && !imposterValid && (
          <p className="osd-text" style={{ fontSize: '0.7rem', color: '#8c0030', marginTop: 4 }}>
            ⚠ UNRECOGNIZED URL FORMAT
          </p>
        )}
      </div>

      {normalUrl && imposterUrl && normalValid && imposterValid && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
          <input
            id="preset-name-input"
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            style={{ ...inputStyle, flex: 1, fontSize: '0.9rem' }}
            placeholder="Label this pair…"
          />
          <button
            id="save-preset-btn"
            className="btn-brutal dark"
            style={{ fontSize: '0.75rem', padding: '8px 12px' }}
            onClick={handleSavePreset}
            disabled={saving || !saveName.trim()}
          >
            {saving ? '…' : '💾 SAVE'}
          </button>
        </div>
      )}
    </div>
  );
}
