'use client';
// src/components/game/PromptScreen.tsx
// The watch phase for the two non-video modes: you are dealt a card, you read
// it, you say you're ready.
//
// This is GameScreen's counterpart, not a variant of it. There is no tape to
// buffer, nothing to synchronise and nothing to end, so none of the sync
// machinery applies — the card is on screen the moment the round starts and
// the phase ends when everyone clicks Ready or the server's read grace runs
// out, whichever comes first.
//
// The player is never told their role, so this screen looks identical for crew
// and suspect (section 3). Only one card exists on this client: the other half
// of the pair is on the server until results. Do not add anything here that
// hints at which half you were dealt — no "yours differs", no colour change,
// nothing conditional on the text.

import { useEffect, useState, useCallback } from 'react';
import type { GameAssignment, ReadyState, RoomPublic } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { VIDEO_CATEGORIES, modeStyle } from '@/lib/videoCategories';

interface Props {
  code: string;
  room: RoomPublic;
  assignment: GameAssignment;
  readyState: ReadyState | null;
  actions: RoomActions;
}

export function PromptScreen({ code, room, assignment, readyState, actions }: Props) {
  const [clickedReady, setClickedReady] = useState(false);
  const [graceLeft, setGraceLeft] = useState<number | null>(null);
  /** Set a tick after mount so the card has a from-state to animate out of. */
  const [dealt, setDealt] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDealt(true), 60);
    return () => clearTimeout(id);
  }, []);

  // The server advances on its own when the read grace expires, so show that
  // countdown rather than letting the phase end out of nowhere.
  useEffect(() => {
    const endsAt = readyState?.graceEndsAt;
    if (!endsAt) {
      setGraceLeft(null);
      return;
    }
    const tick = () => setGraceLeft(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [readyState?.graceEndsAt]);

  const handleReady = useCallback(() => {
    if (clickedReady) return;
    setClickedReady(true);
    actions.readyToAdvance(code);
  }, [clickedReady, code, actions]);

  const mode = room.settings.videoCategory;
  const style = modeStyle(mode);
  const isQuestion = style === 'question';
  const icon = (mode && VIDEO_CATEGORIES[mode]?.icon) || '🔤';

  return (
    <div className="prompt-stage">
      <div className={`prompt-card${dealt ? ' dealt' : ''}`}>
        <div className="prompt-card-head osd-text">
          <span>{icon}</span>
          <span>{isQuestion ? 'YOUR QUESTION' : 'YOUR WORD'}</span>
        </div>

        <p className={`prompt-card-text${isQuestion ? ' question' : ''}`}>
          {assignment.prompt}
        </p>

        <p className="prompt-card-note osd-text">
          {isQuestion
            ? 'Answer it out loud when your turn comes. Someone was asked something else.'
            : 'Describe it in one word when your turn comes. Someone has a different word.'}
        </p>
      </div>

      <div className="prompt-actions">
        {readyState && (
          <span className="osd-text" style={{ color: 'var(--neon-cyan)' }}>
            {readyState.ready}/{readyState.total} READY
          </span>
        )}
        {graceLeft !== null && (
          <span className="osd-text" style={{ color: 'var(--neon-magenta)' }}>
            MOVING ON IN {graceLeft}s
          </span>
        )}
        <button
          id="prompt-ready-btn"
          className={`btn-brutal ${clickedReady ? 'dark' : 'green'}`}
          disabled={clickedReady}
          onClick={handleReady}
        >
          {clickedReady ? '✓ READY — WAITING' : "I'VE GOT IT"}
        </button>
      </div>
    </div>
  );
}
