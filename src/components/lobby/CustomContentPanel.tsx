'use client';
// src/components/lobby/CustomContentPanel.tsx
//
// "Run this mode on my own content" — the switch that Custom became.
//
// Custom used to be a mode card of its own, sitting in the video group, which
// made it impossible to say the obvious thing: I want to play *Questions*, but
// with my own pair. So it is a modifier now. You pick the game upstairs in the
// mode grid, and this panel — at the bottom, under everything — decides whether
// that game is dealt from its pool or from what you type here.
//
// Two content shapes, because two mode styles have a pair a host can write: two
// links for a video round, two cards for a word or question round. The other
// three modes say so rather than offering a form that cannot work — see
// supportsCustomContent().
//
// Nothing typed here is ever broadcast. The host sees their own text because
// they are the one holding it; everybody else sees LOADED / EMPTY, and the
// server only ever sends the halves out through game:assigned.

import { useState, useEffect } from 'react';
import { RoomPublic } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import {
  VIDEO_CATEGORIES,
  isPromptStyle,
  isVideoStyle,
  supportsCustomContent,
  modeStyle,
} from '@/lib/videoCategories';
import { VideoSetupPanel } from './VideoSetupPanel';

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
  // the wrong thing to type a prompt into.
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  fontSize: '1rem',
  marginTop: 5,
};

/** Matches MAX_PROMPT_LENGTH in socketHandlers — the server clamps, this only
 *  keeps the field honest about it. */
const MAX_PROMPT_LENGTH = 120;

export function CustomContentPanel({ room, isHost, actions, code }: Props) {
  const mode = room.settings.videoCategory;
  const modeName = (mode && VIDEO_CATEGORIES[mode]?.name) || 'this mode';
  const supported = supportsCustomContent(mode);
  const on = room.settings.useCustomContent && supported;

  return (
    <section className="custom-content-panel">
      <div className="setting-row">
        <span className="setting-label">🎛️ CUSTOM CONTENT</span>
        {isHost && supported ? (
          <div className="setting-choice">
            <button
              id="custom-off-btn"
              className={`setting-choice-btn${!on ? ' active' : ''}`}
              onClick={() => actions.updateSettings(code, { useCustomContent: false })}
            >
              FROM POOL
            </button>
            <button
              id="custom-on-btn"
              className={`setting-choice-btn${on ? ' active' : ''}`}
              onClick={() => actions.updateSettings(code, { useCustomContent: true })}
            >
              MY OWN
            </button>
          </div>
        ) : (
          <span className="setting-value">
            {!supported ? 'NOT FOR THIS MODE' : on ? 'MY OWN' : 'FROM POOL'}
          </span>
        )}
      </div>

      {!supported && (
        <p className="setting-hint muted">
          {modeName.toUpperCase()} deals its own word — custom content is for the video and
          prompt modes.
        </p>
      )}

      {supported && !on && (
        <p className="setting-hint">
          {isVideoStyle(mode)
            ? 'Two clips will be pulled from the shelf when the deck rolls.'
            : 'A written pair will be dealt when the round starts.'}
        </p>
      )}

      {/* Whoever types it has seen both halves, so they cannot also play the
          round they just wrote (§4). Said here, before the round, rather than
          sprung when the deck rolls. */}
      {on && (
        <p className="setting-hint">
          Whoever fills this in sits the round out — they already know which is which.
        </p>
      )}

      {on && isVideoStyle(mode) && (
        <VideoSetupPanel room={room} isHost={isHost} actions={actions} code={code} />
      )}

      {on && isPromptStyle(mode) && (
        <CustomPromptFields room={room} isHost={isHost} actions={actions} code={code} />
      )}
    </section>
  );
}

/**
 * The two cards, typed.
 *
 * Deliberately mirrors VideoSetupPanel's shape — debounced writes, a non-host
 * read-only view — because they are the same job in two content types and a
 * host should not have to learn two panels.
 *
 * The pair has to be *comparable*: two independent words are not a round, since
 * a suspect handed PHOTOSYNTHESIS against everyone else's BEACH is caught on
 * their first clue. That is why content/prompts.json authors its pairs together,
 * and it is the one thing this form cannot check for the host.
 */
function CustomPromptFields({ room, isHost, actions, code }: Props) {
  const [normal, setNormal] = useState('');
  const [imposter, setImposter] = useState('');

  const question = modeStyle(room.settings.videoCategory) === 'question';
  const noun = question ? 'QUESTION' : 'WORD';

  useEffect(() => {
    if (!isHost) return;
    const t = setTimeout(() => {
      actions.updateSettings(code, { customNormalPrompt: normal.trim() });
    }, 800);
    return () => clearTimeout(t);
  }, [normal, isHost, code, actions]);

  useEffect(() => {
    if (!isHost) return;
    const t = setTimeout(() => {
      actions.updateSettings(code, { customImposterPrompt: imposter.trim() });
    }, 800);
    return () => clearTimeout(t);
  }, [imposter, isHost, code, actions]);

  if (!isHost) {
    return (
      <div className="brutal-card yellow" style={{ padding: 16, marginTop: 10 }}>
        <h3 className="brutal-title" style={{ fontSize: '1.1rem', color: '#000', textShadow: 'none' }}>
          🃏 THE HOST&apos;S PAIR
        </h3>
        <div className="osd-menu" style={{ marginTop: 12 }}>
          <div className="osd-menu-row">
            <span>CREW {noun}:</span>
            <span style={{ color: room.settings.hasNormalPrompt ? 'var(--neon-green)' : '#ff5577' }}>
              {room.settings.hasNormalPrompt ? 'LOADED' : 'EMPTY'}
            </span>
          </div>
          <div className="osd-menu-row">
            <span>SUSPECT {noun}:</span>
            <span
              style={{ color: room.settings.hasImposterPrompt ? 'var(--neon-green)' : '#ff5577' }}
            >
              {room.settings.hasImposterPrompt ? 'LOADED' : 'EMPTY'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="brutal-card yellow" style={{ padding: 16, marginTop: 10 }}>
      <h3 className="brutal-title" style={{ fontSize: '1.1rem', color: '#000', textShadow: 'none' }}>
        🃏 WRITE THE PAIR
      </h3>
      <p style={{ fontWeight: 600, fontSize: '0.8rem', marginTop: 8 }}>
        Write two that could pass for each other — a suspect who cannot bluff is caught on
        their first clue.
      </p>

      <div style={{ marginTop: 12 }}>
        <label
          htmlFor="custom-normal-prompt"
          style={{ fontFamily: 'var(--font-brutal)', fontSize: '0.85rem', textTransform: 'uppercase' }}
        >
          🃏 Crew {noun.toLowerCase()} — everyone but the suspect
        </label>
        <input
          id="custom-normal-prompt"
          type="text"
          value={normal}
          maxLength={MAX_PROMPT_LENGTH}
          onChange={(e) => setNormal(e.target.value)}
          style={inputStyle}
          placeholder={question ? 'Which pet would you never own?' : 'BEACH'}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <label
          htmlFor="custom-imposter-prompt"
          style={{ fontFamily: 'var(--font-brutal)', fontSize: '0.85rem', textTransform: 'uppercase' }}
        >
          👁️ Suspect {noun.toLowerCase()} — only they see it
        </label>
        <input
          id="custom-imposter-prompt"
          type="text"
          value={imposter}
          maxLength={MAX_PROMPT_LENGTH}
          onChange={(e) => setImposter(e.target.value)}
          style={inputStyle}
          placeholder={question ? 'Which pet would you most like to own?' : 'DESERT'}
        />
      </div>
    </div>
  );
}
