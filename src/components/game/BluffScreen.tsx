'use client';
// src/components/game/BluffScreen.tsx
// Bluff Definitions: an obscure word, everyone writes a fake meaning, then the
// room votes on which of them is the real one.
//
// Two phases in one component because they are the same screen with the same
// word at the top — writing swaps the ballot for a textarea and nothing else.
//
// The rule this file must keep: **the ballot carries no authors.** The server
// sends `{ id, text }` and nothing more, and the only thing this file may infer
// from an id is whether it is *yours* — which it needs, to grey out your own
// fake. Rendering anything else per-option (a name, an avatar, a colour) would
// hand over the mapping the whole round is built on hiding.

import { useEffect, useState } from 'react';
import type { RoomPublic, BluffOption } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';

interface Props {
  room: RoomPublic;
  playerId: string;
  code: string;
  phase: 'writing' | 'bluffvote';
  bluffState: {
    word: string;
    options: BluffOption[];
    secondsLeft: number;
    doneIn: number;
    total: number;
  } | null;
  actions: RoomActions;
}

export function BluffScreen({ room, playerId, code, phase, bluffState, actions }: Props) {
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  // A phase change is a clean slate, or the lock from writing carries into the
  // ballot and the player can never vote.
  useEffect(() => {
    setLocked(false);
    setPicked(null);
  }, [phase]);

  if (!bluffState) return null;
  const { word, options, secondsLeft, doneIn, total } = bluffState;

  const amSpectator = !!room.players.find((p) => p.id === playerId)?.isSpectator;

  const send = () => {
    const text = draft.trim().replace(/\s+/g, ' ').slice(0, 180);
    if (!text || locked || amSpectator) return;
    actions.submitDefinition(code, text);
    setLocked(true);
  };

  const vote = (id: string) => {
    if (locked || amSpectator || id === playerId) return;
    setPicked(id);
    actions.submitBluffVote(code, id);
    setLocked(true);
  };

  return (
    <div className="view-panel active-view">
      <div className="bluff-layout">
        <div className="bluff-head">
          <h2 className="brutal-title bluff-title">BLUFF</h2>
          <span className="bluff-timer">{secondsLeft}s</span>
        </div>

        <div className="bluff-word-card">
          <span className="bluff-word-label">THE WORD</span>
          <span className="bluff-word">{word}</span>
        </div>

        {phase === 'writing' ? (
          <div className="bluff-panel">
            <p className="bluff-instruction">
              Write a definition convincing enough that somebody votes for it.
            </p>
            <textarea
              id="bluff-input"
              className="brutal-input bluff-input"
              rows={3}
              maxLength={180}
              value={draft}
              disabled={locked || amSpectator}
              placeholder="a plausible-sounding meaning…"
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              id="bluff-submit-btn"
              className="btn-brutal magenta"
              disabled={locked || amSpectator || draft.trim().length === 0}
              onClick={send}
            >
              {locked ? 'SUBMITTED' : 'SUBMIT DEFINITION'}
            </button>
            <span className="bluff-progress">
              {doneIn} / {total} WRITTEN
            </span>
          </div>
        ) : (
          <div className="bluff-panel">
            <p className="bluff-instruction">
              One of these is the truth. The rest are each other&apos;s.
            </p>
            <ul className="bluff-options">
              {options.map((o, i) => {
                const mine = o.id === playerId;
                return (
                  <li key={o.id}>
                    <button
                      className={`bluff-option${picked === o.id ? ' picked' : ''}${mine ? ' mine' : ''}`}
                      disabled={locked || mine || amSpectator}
                      onClick={() => vote(o.id)}
                    >
                      <span className="bluff-option-index">{i + 1}</span>
                      <span className="bluff-option-text">{o.text}</span>
                      {mine && <span className="bluff-option-tag">YOURS</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <span className="bluff-progress">
              {doneIn} / {total} VOTED
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
