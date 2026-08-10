'use client';
// src/components/game/WavelengthScreen.tsx
// Wavelength: one player sees a hidden point on a public scale and clues the
// rest towards it. No hidden role, no accusation — the round ends in a score.
//
// Both phases live in one component because they are one screen with one
// element changing: the dial is present throughout, showing the target to the
// psychic during `clue` and taking a guess from everyone else during
// `guessing`. Splitting them would mean two copies of the scale.
//
// The rule this file must keep: **the psychic's dial and everyone else's must
// look identical to a spectator.** The target is rendered from
// `assignment.target`, which only the psychic is ever dealt, so the marker
// simply is not there for anyone else — no conditional styling, no dimmed
// placeholder that reveals a position.

import { useEffect, useState } from 'react';
import type { RoomPublic, GameAssignment } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';

interface Props {
  room: RoomPublic;
  playerId: string;
  code: string;
  phase: 'clue' | 'guessing';
  assignment: GameAssignment | null;
  spectrumState: { secondsLeft: number; guessesIn: number; totalGuessers: number } | null;
  actions: RoomActions;
}

export function WavelengthScreen({
  room,
  playerId,
  code,
  phase,
  assignment,
  spectrumState,
  actions,
}: Props) {
  const [clue, setClue] = useState('');
  const [dial, setDial] = useState(50);
  const [locked, setLocked] = useState(false);

  const isPsychic = !!assignment?.isPsychic;
  const target = assignment?.target ?? null;
  const spectrum = room.spectrum;
  const secondsLeft = spectrumState?.secondsLeft ?? 0;

  // A fresh phase is a fresh dial — a lock left over from the clue phase would
  // stop the psychic's own screen updating on the next round.
  useEffect(() => {
    setLocked(false);
  }, [phase]);

  const sendClue = () => {
    const text = clue.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!text || !isPsychic) return;
    actions.submitClue(code, text);
    setLocked(true);
  };

  const sendGuess = () => {
    if (isPsychic || locked) return;
    actions.submitGuess(code, dial);
    setLocked(true);
  };

  if (!spectrum) return null;

  return (
    <div className="view-panel active-view">
      <div className="wl-layout">
        <div className="wl-head">
          <h2 className="brutal-title wl-title">WAVELENGTH</h2>
          <span className="wl-timer">{secondsLeft}s</span>
        </div>

        {/* The scale. Public to everyone — it is what is being guessed on. */}
        <div className="wl-scale">
          <span className="wl-end left">{spectrum.left}</span>
          <div className="wl-track">
            {/* Only ever rendered when the server dealt a target, which it
                does for the psychic alone. */}
            {target !== null && (
              <div className="wl-target" style={{ left: `${target}%` }}>
                <span className="wl-target-flag">{target}</span>
              </div>
            )}
            {phase === 'guessing' && !isPsychic && (
              <div className="wl-dial-marker" style={{ left: `${dial}%` }} />
            )}
          </div>
          <span className="wl-end right">{spectrum.right}</span>
        </div>

        {phase === 'clue' ? (
          <div className="wl-panel">
            {isPsychic ? (
              <>
                <span className="wl-role-label psychic">YOU ARE THE PSYCHIC</span>
                <p className="wl-instruction">
                  Only you can see the target. Give one clue that lands the room on it.
                </p>
                <div className="wl-clue-row">
                  <input
                    className="brutal-input wl-clue-input"
                    value={clue}
                    maxLength={60}
                    disabled={locked}
                    placeholder="one clue…"
                    onChange={(e) => setClue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendClue()}
                  />
                  <button
                    id="wl-clue-btn"
                    className="btn-brutal magenta"
                    disabled={locked || clue.trim().length === 0}
                    onClick={sendClue}
                  >
                    {locked ? 'SENT' : 'SEND CLUE'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="wl-role-label">WAITING ON THE PSYCHIC</span>
                <p className="wl-instruction">
                  One of you can see a target on that scale. They are thinking of a clue.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="wl-panel">
            <span className="wl-role-label">THE CLUE</span>
            <p className="wl-clue-text">
              &ldquo;{room.psychicClue ?? '…'}&rdquo;
            </p>
            {isPsychic ? (
              <p className="wl-instruction">
                Nothing more to do — see how well they read you.
              </p>
            ) : (
              <>
                <input
                  id="wl-dial"
                  className="wl-dial"
                  type="range"
                  min={0}
                  max={100}
                  value={dial}
                  disabled={locked}
                  onChange={(e) => setDial(Number(e.target.value))}
                />
                <button
                  id="wl-guess-btn"
                  className="btn-brutal magenta"
                  disabled={locked}
                  onClick={sendGuess}
                >
                  {locked ? 'LOCKED IN' : `LOCK IN ${dial}`}
                </button>
              </>
            )}
            <span className="wl-progress">
              {spectrumState?.guessesIn ?? 0} / {spectrumState?.totalGuessers ?? 0} DIALLED IN
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
