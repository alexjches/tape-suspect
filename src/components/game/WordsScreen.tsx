'use client';
// src/components/game/WordsScreen.tsx
// Section 7: randomized turn order, 10s per player, one word each.
// Timing out auto-skips — the server owns the clock, this only renders it.

import { useEffect, useRef, useState } from 'react';
import type { RoomPublic, GameWord, TurnState } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';

interface Props {
  room: RoomPublic;
  socketId: string;
  code: string;
  words: GameWord[];
  turnState: TurnState | null;
  actions: RoomActions;
}

export function WordsScreen({ room, socketId, code, words, turnState, actions }: Props) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const activeId = turnState?.activePlayerId ?? null;
  const isMyTurn = activeId === socketId;
  const timeLeft = turnState?.turnTimeLeft ?? 0;
  const activePlayer = room.players.find((p) => p.id === activeId);

  // Section 3: in a 2-imposter game the round-1 accused sits round 2 out.
  // Their role is still hidden — all anyone knows is that they were ejected.
  const accusedIds = room.accusedIds ?? [];
  const totalRounds = room.totalRounds ?? 1;
  const gameRound = room.gameRound ?? 1;
  const amAccused = accusedIds.includes(socketId);
  const accusedNames = accusedIds
    .map((id) => room.players.find((p) => p.id === id)?.name ?? '???')
    .join(', ');

  // Grab focus the moment the turn lands so the 10s isn't spent clicking.
  useEffect(() => {
    if (isMyTurn) inputRef.current?.focus();
  }, [isMyTurn]);

  const submit = () => {
    // Section 7 is one word: collapse anything pasted with spaces.
    const word = draft.trim().replace(/\s+/g, '').slice(0, 30);
    if (!word || !isMyTurn) return;
    actions.submitWord(code, word);
    setDraft('');
  };

  return (
    <div className="view-panel active-view">
      <div className="watch-container" style={{ display: 'block', padding: '20px' }}>
        <h2 className="brutal-title" style={{ fontSize: '1.8rem', marginBottom: 8 }}>
          🎙️ WORD PHASE{totalRounds > 1 ? ` — ROUND ${gameRound} OF ${totalRounds}` : ''}
        </h2>
        <p className="osd-text" style={{ color: '#aaa', marginBottom: 20 }}>
          One word each about the tape you watched. {room.settings.wordsPerPlayer} word
          {room.settings.wordsPerPlayer === 1 ? '' : 's'} per player, 10 seconds a turn.
        </p>

        {accusedIds.length > 0 && (
          <div className="word-phase-banner" style={{ display: 'block', marginBottom: 20 }}>
            ⛔ {accusedNames.toUpperCase()} EJECTED — ROLE SEALED UNTIL THE FINAL COUNT
          </div>
        )}

        {amAccused && (
          <div className="word-phase-banner" style={{ display: 'block', marginBottom: 20 }}>
            👁️ YOU ARE OUT OF PLAY — WATCH THE REST UNFOLD
          </div>
        )}

        {/* Whose turn it is + the countdown */}
        <div className="brutal-card" style={{ marginBottom: 20, textAlign: 'center' }}>
          {activePlayer ? (
            <>
              <div className="osd-text" style={{ color: '#aaa' }}>
                NOW SPEAKING
              </div>
              <div
                className="brutal-title"
                style={{
                  fontSize: '2rem',
                  color: isMyTurn ? 'var(--neon-green)' : 'var(--neon-cyan)',
                }}
              >
                {activePlayer.avatar} {isMyTurn ? 'YOUR TURN' : activePlayer.name}
              </div>
              <div
                className="osd-text"
                style={{
                  fontSize: '1.6rem',
                  color: timeLeft <= 3 ? 'var(--neon-magenta)' : 'var(--neon-yellow)',
                }}
              >
                {timeLeft}s
              </div>
            </>
          ) : (
            <div className="osd-text">STANDBY…</div>
          )}
        </div>

        {/* Turn order, visible to everyone (section 7) */}
        <div className="pinned-words-strip" style={{ marginBottom: 20 }}>
          <div className="pinned-words-label">📼 TURN ORDER</div>
          <div className="pinned-words-chips">
            {room.players.map((p) => {
              const used = turnState?.wordsUsed?.[p.id] ?? 0;
              const done = used >= room.settings.wordsPerPlayer;
              const out = accusedIds.includes(p.id);
              return (
                <div
                  className="word-chip"
                  key={p.id}
                  style={{
                    opacity: out ? 0.35 : done ? 0.5 : 1,
                    textDecoration: out ? 'line-through' : undefined,
                    borderColor: p.id === activeId ? 'var(--neon-green)' : undefined,
                  }}
                >
                  <span className="word-chip-author">{p.avatar}</span>
                  <span className="word-chip-word">
                    {p.name}
                    {out ? ' ⛔' : done ? ' ✓' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Words said so far */}
        <div className="pinned-words-strip" style={{ marginBottom: 20 }}>
          <div className="pinned-words-label">📌 WORDS ON THE RECORD</div>
          <div className="pinned-words-chips">
            {words.length === 0 && (
              <span className="osd-text" style={{ color: '#666' }}>
                (nothing said yet)
              </span>
            )}
            {words.map((w, i) => (
              <div className="word-chip" key={`${w.playerId}-${i}`}>
                <span className="word-chip-author">{w.playerName}:</span>
                <span className="word-chip-word">{w.word}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Input, only live on your turn */}
        <div className="voting-chat-input-row" style={{ maxWidth: 520 }}>
          <input
            ref={inputRef}
            type="text"
            className="voting-chat-input"
            placeholder={isMyTurn ? 'Your 1 word…' : 'Wait for your turn…'}
            maxLength={30}
            disabled={!isMyTurn}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button
            className="btn-brutal cyan"
            style={{ padding: '8px 16px', margin: 0, fontSize: '0.9rem', height: 'auto' }}
            disabled={!isMyTurn}
            onClick={submit}
          >
            SAY IT
          </button>
        </div>
      </div>
    </div>
  );
}
