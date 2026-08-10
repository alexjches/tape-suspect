'use client';
// src/components/game/GameScreen.tsx
// Locked-down fullscreen playback, then the Ready Check (section 6).
//
// The player is never told their role, so this screen looks identical for
// crew and imposter — that is the point (section 3).
//
// The load-in mirrors startWatchSequence() in vhs-frontend-example/app.js:
// the gate drops, a cassette slides up into it, then the overlay clears and
// the picture powers on with the CRT `vhs-power-on` bloom. The prototype runs
// that off a fixed 1.8s timeline because it has nobody to wait for; here the
// beats hang off the real sync instead — the tape "reads" while other players
// buffer, and the picture only powers on at the wall-clock moment the server
// picked. See docs/BUILD-PLAN.md §5.

import { useRef, useEffect, useState, useCallback } from 'react';
import type { GameAssignment, ReadyState } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { VideoPlayer, VideoPlayerHandle } from './VideoPlayer';
import { ReactionBar } from './ReactionBar';
import { getSocket } from '@/lib/socket';
import { useShop } from '@/hooks/useShop';
import { tapeSkinStyles, equippedSticker } from '@/lib/cosmetics';

interface Props {
  code: string;
  assignment: GameAssignment;
  loadedCount: { ready: number; total: number } | null;
  readyState: ReadyState | null;
  playerId: string;
  actions: RoomActions;
}

type PlayState = 'loading' | 'waiting' | 'countdown' | 'playing' | 'ended';

export function GameScreen({
  code,
  assignment,
  loadedCount,
  readyState,
  playerId,
  actions,
}: Props) {
  // The cassette going into the deck is yours, so it wears your loadout —
  // straight off localStorage, no round trip (section 10).
  const { equipped } = useShop();
  const tape = tapeSkinStyles(equipped);
  const sticker = equippedSticker(equipped);

  const playerRef = useRef<VideoPlayerHandle>(null);
  const [playState, setPlayState] = useState<PlayState>('loading');
  const [hasSignaledLoaded, setHasSignaledLoaded] = useState(false);
  const [clickedReady, setClickedReady] = useState(false);
  const [graceLeft, setGraceLeft] = useState<number | null>(null);
  /** Drives the cassette up into the gate; set one tick after mount so the
      CSS transition has a from-state to animate out of. */
  const [inserting, setInserting] = useState(false);
  /** Overlay clears and the picture powers on. */
  const [poweredOn, setPoweredOn] = useState(false);
  /** Kept mounted through the 0.3s fade-out so the overlay doesn't snap away. */
  const [showInsertion, setShowInsertion] = useState(true);

  useEffect(() => {
    const id = setTimeout(() => setInserting(true), 50);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!poweredOn) return;
    const id = setTimeout(() => setShowInsertion(false), 600);
    return () => clearTimeout(id);
  }, [poweredOn]);

  const handleVideoReady = useCallback(() => {
    if (hasSignaledLoaded) return;
    setHasSignaledLoaded(true);
    setPlayState('waiting');
    actions.signalLoaded(code);
  }, [hasSignaledLoaded, code, actions]);

  // Synchronized start: the server picks a wall-clock moment ~1s out and
  // every client schedules against it.
  useEffect(() => {
    const socket = getSocket();

    const handlePlay = ({ playAt }: { playAt: number }) => {
      const delay = Math.max(0, playAt - Date.now());
      setPlayState('countdown');

      setTimeout(() => {
        playerRef.current?.play();
        setPlayState('playing');
        // Overlay fades and the CRT blooms in at the same instant the tape
        // rolls, so the picture arrives through the power-on rather than
        // being revealed already running.
        setPoweredOn(true);
      }, delay);
    };

    socket.on('game:play', handlePlay);
    return () => {
      socket.off('game:play', handlePlay);
    };
  }, []);

  // Section 6: the phase advances 10s after the imposter's video ends even if
  // someone never clicks Ready. Render that countdown so it isn't a surprise.
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

  const handleVideoEnded = useCallback(() => {
    setPlayState('ended');
    // Every player reports their own end — video lengths differ between the
    // crew tape and the imposter tape.
    actions.videoEnded(code);
  }, [code, actions]);

  const handleReady = useCallback(() => {
    if (clickedReady) return;
    setClickedReady(true);
    actions.readyToAdvance(code);
  }, [clickedReady, code, actions]);

  // One line, as in the prototype — see the .insertion-status note in
  // globals.css for why a second line breaks the cassette's landing. No
  // 3-2-1 over the top of it: the insertion is the countdown.
  const insertionStatus =
    playState === 'loading'
      ? 'TAPE INJECTING…'
      : `TAPE LOADED… READING…${
          loadedCount ? ` ${loadedCount.ready}/${loadedCount.total} PLAYERS` : ''
        }`;

  return (
    <div className="fixed inset-0 bg-black flex flex-col overflow-hidden">
      <div className={`video-screen${poweredOn ? ' vhs-starting' : ''}`}>
        <div className="absolute inset-0">
          <VideoPlayer
            ref={playerRef}
            // Only ever mounted on a video round — the room page routes a
            // prompt assignment to PromptScreen instead.
            url={assignment.videoUrl ?? ''}
            onReady={handleVideoReady}
            onEnded={handleVideoEnded}
          />
        </div>
      </div>

      {/* Head-drift bar. CrtShell owns this everywhere else, but the watch
          phase deliberately renders outside the CRT frame. */}
      <div className={`tracking-line${poweredOn ? ' vhs-starting-tracking' : ''}`} />

      {/* Tape insertion — covers load, the wait for other players, and the
          countdown, then clears as the picture powers on. */}
      {showInsertion && (
        <div
          className={`vcr-insertion-overlay${inserting ? ' inserting' : ''}${
            poweredOn ? ' fade-out' : ''
          }`}
        >
          <div className="insertion-container">
            <div className="vcr-gate">
              <div className="vcr-gate-door">INSERT TAPE</div>
            </div>
            <div className="inserting-tape">
              <div className="compact-tape" style={tape?.shell}>
                <div
                  className="compact-label"
                  style={
                    sticker
                      ? { background: sticker.bg, color: sticker.color, borderColor: sticker.border }
                      : tape?.label
                  }
                >
                  {sticker ? sticker.text : `📼 ${code}`}
                </div>
                <div className="compact-spools">
                  <div className="c-spool" style={tape?.spool} />
                  <div className="c-spool" style={tape?.spool} />
                </div>
              </div>
            </div>
            <div className="insertion-status osd-text">{insertionStatus}</div>
          </div>
        </div>
      )}

      {/* Ready Check (section 6) */}
      {playState === 'ended' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/85 z-20 px-4">
          <div className="brutal-card" style={{ maxWidth: 460, textAlign: 'center' }}>
            <h2 className="brutal-title" style={{ fontSize: '1.6rem', marginBottom: 8 }}>
              ⏏ TAPE FINISHED
            </h2>
            <p className="osd-text" style={{ color: '#aaa', marginBottom: 16 }}>
              Hit ready when you are done thinking about what you saw.
            </p>

            {readyState && (
              <div className="osd-text" style={{ color: 'var(--neon-cyan)', marginBottom: 12 }}>
                {readyState.ready}/{readyState.total} PLAYERS READY
              </div>
            )}

            {graceLeft !== null && (
              <div className="osd-text" style={{ color: 'var(--neon-magenta)', marginBottom: 12 }}>
                AUTO-ADVANCING IN {graceLeft}s
              </div>
            )}

            <button
              className="btn-brutal green"
              disabled={clickedReady}
              onClick={handleReady}
            >
              {clickedReady ? '✓ READY' : "I'M READY"}
            </button>
          </div>
        </div>
      )}

      {/* Ready is live during playback, not just after the tape runs out — a
          lobby that has all seen enough cuts it short (see markReadyToAdvance).
          Sits low and small so it doesn't fight the video. */}
      {playState === 'playing' && (
        <div
          className="watch-ready-bar"
          style={{ zIndex: 30 }}
        >
          {readyState && readyState.ready > 0 && (
            <span className="osd-text" style={{ color: 'var(--neon-cyan)' }}>
              {readyState.ready}/{readyState.total} READY
            </span>
          )}
          <button
            id="skip-ready-btn"
            className={`btn-brutal ${clickedReady ? 'dark' : 'green'}`}
            style={{ fontSize: '0.8rem', padding: '6px 14px', margin: 0 }}
            disabled={clickedReady}
            onClick={handleReady}
          >
            {clickedReady ? '✓ READY — WAITING' : "⏭ SEEN ENOUGH"}
          </button>
        </div>
      )}

      {/* Live reactions (section 5). Playback only: before it there is
          nothing to react to, and once your tape runs out the Ready Check
          modal owns the screen. Mounting it with playback also means the
          float list starts empty every round without needing to be cleared. */}
      {playState === 'playing' && <ReactionBar code={code} actions={actions} />}

      {playState === 'playing' && (
        <div className="scan-line pointer-events-none" style={{ zIndex: 5 }} />
      )}
    </div>
  );
}
