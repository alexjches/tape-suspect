'use client';
// src/components/game/DrawScreen.tsx
// Fake Artist: one shared canvas, one stroke each in turn order.
//
// The turn machinery is the word phase's, unchanged — same server clock, same
// skip-the-absent ordering, same exhaustion check. What differs is that a turn
// produces a stroke instead of a word, and that your own card sits on screen
// for the whole phase rather than being read once and dismissed.
//
// Two rules this file must keep:
//
//   1. **Nothing may vary with the *content* of the card.** A layout that
//      shifts for a long word, or a colour keyed off the theme, is a role tell
//      in the one place the game cannot afford one. The two cards are the same
//      box at the same fixed height whatever they hold. They *do* differ by
//      role — different label, different fill — and that is fine and wanted:
//      you are looking at your own screen and the game has already told you
//      which you are. What must never differ is anything derived from the
//      word or theme itself.
//   2. **Points go over the wire normalised 0..1.** A phone at 390px and a
//      laptop at 1440px have to agree on the picture, and the server clamps to
//      that range on arrival. Denormalising is this file's job alone.

import { useEffect, useRef, useState, useCallback } from 'react';
import type { RoomPublic, DrawStroke, TurnState, GameAssignment } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { Avatar } from '@/components/vhs/Avatar';

interface Props {
  room: RoomPublic;
  playerId: string;
  code: string;
  assignment: GameAssignment | null;
  strokes: DrawStroke[];
  turnState: TurnState | null;
  actions: RoomActions;
}

/** The canvas is authored against this box and scaled to whatever it renders at. */
const ASPECT = 4 / 3;

export function DrawScreen({
  room,
  playerId,
  code,
  assignment,
  strokes,
  turnState,
  actions,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<number[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [sent, setSent] = useState(false);

  const activeId = turnState?.activePlayerId ?? null;
  const isMyTurn = activeId === playerId;
  const timeLeft = turnState?.turnTimeLeft ?? 0;
  const activePlayer = room.players.find((p) => p.id === activeId);

  const accusedIds = room.accusedIds ?? [];
  const isOut = (id: string) =>
    accusedIds.includes(id) || !!room.players.find((p) => p.id === id)?.isSpectator;
  const amSpectator = !!room.players.find((p) => p.id === playerId)?.isSpectator;

  const strokesEach = room.settings.wordsPerPlayer ?? 1;
  const used = turnState?.wordsUsed ?? {};

  // A new turn is a clean slate — a stroke left in `pending` from last turn
  // would paint over the next player's.
  useEffect(() => {
    setPending([]);
    setDrawing(false);
    setSent(false);
  }, [activeId, turnState?.turnIndex]);

  // ── Painting ──
  // Everything is redrawn from `strokes` on every change rather than appended
  // incrementally, because a resize, a reconnect replay and a late arrival all
  // have to produce the same picture and an append-only canvas cannot.
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fdfaf2';
    ctx.fillRect(0, 0, w, h);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, w * 0.006);

    const line = (points: number[], colour: string) => {
      if (points.length < 4) return;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(points[0] * w, points[1] * h);
      for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i] * w, points[i + 1] * h);
      ctx.stroke();
    };

    for (const s of strokes) line(s.points, s.colour);
    if (pending.length >= 4) line(pending, '#012442');
  }, [strokes, pending]);

  // Size the backing store to the element's real pixel size, so the drawing is
  // sharp on a 2x display and does not stretch when the panel changes width.
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = wrap.clientWidth;
      const cssH = cssW / ASPECT;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      paint();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [paint]);

  useEffect(() => {
    paint();
  }, [paint]);

  // ── Input ──
  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    ];
  };

  const canDraw = isMyTurn && !sent && !amSpectator;

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrawing(true);
    setPending(pointAt(e));
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing || !canDraw) return;
    const [x, y] = pointAt(e);
    setPending((prev) => {
      // Thin out micro-movements: the server caps points per stroke, and a
      // slow hand can otherwise spend the whole budget on the first inch.
      const n = prev.length;
      if (n >= 2) {
        const dx = x - prev[n - 2];
        const dy = y - prev[n - 1];
        if (dx * dx + dy * dy < 0.00004) return prev;
      }
      return [...prev, x, y];
    });
  };

  const onUp = () => {
    if (!drawing) return;
    setDrawing(false);
  };

  const commit = () => {
    if (!canDraw || pending.length < 4) return;
    actions.submitStroke(code, pending);
    setSent(true);
    setPending([]);
  };

  const clearPending = () => setPending([]);

  // ── The card ──
  // Same box, same size, whichever you got. See the note at the top.
  const card = assignment?.isFake ? (
    <>
      <span className="draw-card-label">YOU ARE THE FAKE</span>
      <span className="draw-card-value">
        {assignment.themeHint ? assignment.themeHint : 'NO HINT'}
      </span>
      <span className="draw-card-note">
        {assignment.themeHint
          ? 'ALL YOU GET IS THE CATEGORY — BLEND IN'
          : 'YOU HAVE NOTHING. READ THE CANVAS'}
      </span>
    </>
  ) : (
    <>
      <span className="draw-card-label">YOUR WORD</span>
      <span className="draw-card-value">{assignment?.drawWord ?? '…'}</span>
      <span className="draw-card-note">ONE OF YOU IS FAKING IT</span>
    </>
  );

  return (
    <div className="view-panel active-view">
      <div className="draw-layout">
        <div className="draw-main">
          <div className="draw-head">
            <h2 className="brutal-title draw-title">FAKE ARTIST</h2>
            <span className="draw-turn-pill">
              {activePlayer ? (
                isMyTurn ? (
                  <>YOUR STROKE — {timeLeft}s</>
                ) : (
                  <>
                    {activePlayer.name.toUpperCase()} IS DRAWING — {timeLeft}s
                  </>
                )
              ) : (
                'WAITING…'
              )}
            </span>
          </div>

          <div className="draw-canvas-wrap" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              className={`draw-canvas${canDraw ? ' live' : ''}`}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
            {!canDraw && (
              <div className="draw-canvas-lock">
                {amSpectator
                  ? 'SITTING THIS ONE OUT'
                  : sent
                    ? 'STROKE SENT'
                    : 'WAIT YOUR TURN'}
              </div>
            )}
          </div>

          <div className="draw-actions">
            <button
              id="draw-clear-btn"
              className="btn-brutal dark"
              disabled={!canDraw || pending.length < 4}
              onClick={clearPending}
            >
              ↺ REDO
            </button>
            <button
              id="draw-commit-btn"
              className="btn-brutal magenta"
              disabled={!canDraw || pending.length < 4}
              onClick={commit}
            >
              ✓ LOCK IN STROKE
            </button>
          </div>
        </div>

        {/* Card and turn order are siblings of .draw-main rather than nested in
            a column, so the mobile breakpoint can order the card *above* the
            canvas. Nested, you had to scroll past the drawing to re-read your
            own word, which on a phone is most of the round. */}
        <div className={`draw-card${assignment?.isFake ? ' fake' : ''}`}>{card}</div>

        <div className="draw-order">
            <span className="draw-order-title">TURN ORDER</span>
            <ul className="draw-order-list">
              {(room.players ?? [])
                .filter((p) => !isOut(p.id))
                .map((p) => {
                  const done = used[p.id] ?? 0;
                  return (
                    <li
                      key={p.id}
                      className={`draw-order-row${p.id === activeId ? ' active' : ''}`}
                    >
                      <span className="character-slot draw-order-face">
                        <Avatar code={p.avatar} size={26} />
                      </span>
                      <span className="draw-order-name">
                        {p.name}
                        {p.id === playerId ? ' (YOU)' : ''}
                      </span>
                      <span className="draw-order-count">
                        {done}/{strokesEach}
                      </span>
                    </li>
                  );
                })}
          </ul>
        </div>
      </div>
    </div>
  );
}
