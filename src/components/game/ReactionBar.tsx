'use client';
// src/components/game/ReactionBar.tsx
// Live emoji reactions during the video (spec §5).
//
// A small button in the corner of the player expands into a row of the five
// emoji §5 names; tapping one broadcasts it, and every reaction in the room —
// including your own — floats up the same corner.
//
// Two things this deliberately does NOT do:
//
//   * It does not go through useRoom. Reactions are ephemeral and arrive
//     several a second from a full lobby; routing them through the room hook
//     would re-render every subscribed screen on each one. The socket
//     subscription is local, the way GameScreen already handles `game:play`.
//   * It does not read or expose anything role-shaped. The payload is a
//     player, an emoji and a timestamp, identical for crew and imposter.
//     §5's "subtle tell" comes from *when* a reaction lands relative to
//     everyone else's, which the player works out by watching — not from
//     anything in the event.
//
// **Only the emoji is rendered, not the sender.** The float used to carry a
// name beside the glyph; showing just the emoji keeps the corner clean over
// a video nobody can pause. `playerName` stays on the payload — it costs
// nothing, and the event is the room's reaction feed rather than this one
// component's props — but nothing draws it, so §5's tell now rests purely on
// timing: you can see a reaction land at the wrong moment, not whose it was.
//
// Emoji artwork comes from --font-emoji: Apple Color Emoji where it exists
// (iPhone, iPad, Mac — Apple's font is proprietary and licensed to Apple
// hardware, so asking for it is the only legitimate way to get it), and a
// bundled 3KB five-glyph Noto subset everywhere else so the same reaction
// does not look different on every machine in the lobby. See
// public/fonts/README.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '@/lib/socket';
import { REACTION_EMOJI, type GameReaction, type ReactionEmoji } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';

interface Props {
  code: string;
  actions: RoomActions;
}

/** How long one floating reaction lives, matching the CSS animation. */
const FLOAT_MS = 2600;

/**
 * Cap on simultaneous floaters. The server throttles each player to one
 * reaction per 500ms, so a full 10-player lobby can legitimately produce ~20
 * inside one float lifetime — this is a rendering ceiling for that worst
 * case, not a second rate limit. Oldest fall off first.
 */
const MAX_VISIBLE = 18;

export function ReactionBar({ code, actions }: Props) {
  const [open, setOpen] = useState(false);
  const [floating, setFloating] = useState<GameReaction[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const socket = getSocket();

    const handleReaction = (reaction: GameReaction) => {
      setFloating((prev) => [...prev, reaction].slice(-MAX_VISIBLE));
      // Reap on a timer rather than an animation event: an `animationend`
      // never fires for a node dropped by the MAX_VISIBLE slice, and the
      // list would grow for the rest of the tape.
      const id = setTimeout(() => {
        setFloating((prev) => prev.filter((r) => r.id !== reaction.id));
      }, FLOAT_MS);
      timers.current.push(id);
    };

    socket.on('game:reaction', handleReaction);
    return () => {
      socket.off('game:reaction', handleReaction);
    };
  }, []);

  // Unmounting mid-tape (advancing to the word phase) leaves every pending
  // reap scheduled against a gone component.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
    };
  }, []);

  const send = useCallback(
    (emoji: ReactionEmoji) => {
      actions.sendReaction(code, emoji);
      // The row stays open: reacting twice to the same moment is the point,
      // and re-opening a picker between two laughs is the wrong feel.
    },
    [actions, code]
  );

  return (
    <>
      {/* The floats. `pointer-events: none` throughout — this sits over the
          video and must never be what a tap lands on. */}
      <div className="reaction-float-layer" aria-hidden="true">
        {floating.map((r) => (
          <div
            key={r.id}
            className="reaction-float"
            // Randomised drift keeps a burst of the same emoji from stacking
            // into one thick column. Seeded off the id so a re-render during
            // the float does not teleport it sideways.
            style={{ '--drift': `${driftFor(r.id)}px` } as React.CSSProperties}
          >
            <span className="reaction-float-emoji">{r.emoji}</span>
          </div>
        ))}
      </div>

      <div className={`reaction-bar${open ? ' open' : ''}`}>
        {/* Rendered always rather than mounted on open, so the row can
            transition out as well as in. `inert` would be cleaner than the
            tabIndex/aria pair but is not in this React version's typings. */}
        <div className="reaction-row" role="group" aria-label="Send a reaction">
          {REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="reaction-emoji-btn"
              onClick={() => send(emoji)}
              tabIndex={open ? 0 : -1}
              aria-hidden={!open}
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="reaction-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Close reactions' : 'Open reactions'}
        >
          {open ? '✕' : '😀'}
        </button>
      </div>
    </>
  );
}

/** Stable −34…+34px horizontal offset derived from the reaction id. */
function driftFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 69) - 34;
}
