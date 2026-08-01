'use client';
// src/components/lobby/LobbyScreen.tsx
// Layout mirrors #view-lobby in vhs-frontend-example/index.html — each player
// is a VCR console in the tapes grid, settings live in the OSD menu column.
//
// The room code / header chrome is owned by CrtShell, so this renders only
// the lobby body.

import { useState } from 'react';
import { RoomPublic } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { VideoSetupPanel } from './VideoSetupPanel';
import { VIDEO_CATEGORIES, CUSTOM_CATEGORY } from '@/lib/videoCategories';
import { useRouter } from 'next/navigation';

// Section 20: lobby size is 4–10. Mirrors MIN_PLAYERS in socketHandlers.ts —
// the server rejects an early start regardless, this just greys the button.
const MIN_PLAYERS = 4;

// Console glow colours by seat, matching DeliberationScreen so a player keeps
// the same channel colour from lobby through to the vote.
const CHANNEL_COLORS = [
  'var(--neon-cyan)',
  'var(--neon-magenta)',
  '#ffee00',
  'var(--neon-green)',
  '#ff7700',
  '#9d4edd',
  '#00b4d8',
  '#f72585',
  '#4cc9f0',
  '#fca311',
];

interface Props {
  room: RoomPublic;
  socketId: string;
  isHost: boolean;
  actions: RoomActions;
  code: string;
  error: string | null;
}

export function LobbyScreen({ room, socketId, isHost, actions, code, error }: Props) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [wordsInput, setWordsInput] = useState<number>(room.settings.wordsPerPlayer ?? 1);

  function copyCode() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function applyWords(val: number) {
    const clamped = Math.max(1, Math.min(10, val));
    setWordsInput(clamped);
    actions.updateSettings(code, { wordsPerPlayer: clamped });
  }

  const genre = room.settings.videoCategory;
  const hasRandomVideoCategory = !!genre && genre !== CUSTOM_CATEGORY;
  const enoughPlayers = room.players.length >= MIN_PLAYERS;
  const videosReady =
    hasRandomVideoCategory || (room.settings.hasNormalVideo && room.settings.hasImposterVideo);
  const canStart = enoughPlayers && videosReady;

  // Keep at least MIN_PLAYERS slots on screen so the gap to a legal start is
  // visible rather than implied by a disabled button.
  const emptySlots = Math.max(0, MIN_PLAYERS - room.players.length);

  return (
    <div className="view-panel active-view">
      <div className="lobby-layout">
        {/* ── Left: connected consoles ───────────────────────────── */}
        <div>
          <h2 className="brutal-title" style={{ fontSize: '1.8rem', marginBottom: 20 }}>
            📼 CONNECTED VCRS ({room.players.length}/{room.settings.maxPlayers})
          </h2>

          {error && (
            <div className="word-phase-banner" style={{ display: 'block', marginBottom: 16 }}>
              ⛔ {error}
            </div>
          )}

          <div className="tapes-grid">
            {room.players.map((player, i) => {
              const color = CHANNEL_COLORS[i % CHANNEL_COLORS.length];
              const isMe = player.id === socketId;
              const online = player.status === 'connected';

              return (
                <div
                  key={player.id}
                  className={`vhs-player${online ? ' ready' : ''}`}
                  style={{
                    borderColor: color,
                    boxShadow: `4px 4px 0px ${color}`,
                    cursor: 'default',
                    opacity: online ? 1 : 0.45,
                  }}
                >
                  <div className="player-avatar-circle" style={{ fontSize: '1.4rem' }}>
                    {player.avatar}
                  </div>

                  {player.isHost && <span className="player-host-tag">LOBBY HOST</span>}

                  <div className="player-tag" style={{ backgroundColor: color, color: '#000' }}>
                    PLAYER-{i + 1}
                  </div>

                  {isHost && !isMe && (
                    <button
                      id={`kick-${player.id}`}
                      title="Eject player"
                      onClick={() => actions.kick(code, player.id)}
                      style={{
                        position: 'absolute',
                        top: -12,
                        left: 8,
                        zIndex: 11,
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        border: '2px solid #000',
                        background: 'var(--neon-magenta)',
                        color: '#fff',
                        fontFamily: 'var(--font-osd)',
                        fontSize: '0.7rem',
                        lineHeight: 1,
                        cursor: 'pointer',
                        boxShadow: '2px 2px 0px #000',
                      }}
                    >
                      ✕
                    </button>
                  )}

                  <div className="player-display">
                    <div className="player-display-text">
                      {player.name}
                      {isMe ? ' (YOU)' : ''}
                    </div>
                    <div className="player-display-status">
                      <span>CH. {i + 1}</span>
                      <span>{online ? '● READY' : '○ SIGNAL LOST'}</span>
                    </div>
                  </div>

                  <div className="player-vcr-slot">
                    <div className="player-vcr-door-flap" />
                  </div>

                  <div className="player-controls">
                    <div className={`player-led${online ? ' active' : ''}`} />
                    <div className="vcr-btns">
                      <div className="vcr-btn" />
                      <div className="vcr-btn" />
                      <div className="vcr-btn" />
                    </div>
                  </div>
                </div>
              );
            })}

            {Array.from({ length: emptySlots }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="vhs-player"
                style={{ opacity: 0.3, cursor: 'default', borderStyle: 'dashed' }}
              >
                <div className="player-display">
                  <div className="player-display-text" style={{ color: '#666' }}>
                    NO SIGNAL
                  </div>
                  <div className="player-display-status" style={{ color: '#666' }}>
                    <span>CH. {room.players.length + i + 1}</span>
                    <span>○ WAITING</span>
                  </div>
                </div>
                <div className="player-vcr-slot">
                  <div className="player-vcr-door-flap" />
                </div>
                <div className="player-controls">
                  <div className="player-led" />
                  <div className="vcr-btns">
                    <div className="vcr-btn" />
                    <div className="vcr-btn" />
                    <div className="vcr-btn" />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* ── Start / waiting ─────────────────────────────────── */}
          <div style={{ marginTop: 30, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            {isHost ? (
              <>
                <button
                  id="start-game-btn"
                  className="btn-brutal green"
                  disabled={!canStart}
                  onClick={() => actions.startGame(code)}
                >
                  ⏵ ROLL TAPE
                </button>
                <span className="osd-text" style={{ color: canStart ? 'var(--neon-green)' : '#aaa' }}>
                  {!enoughPlayers
                    ? `NEED ${MIN_PLAYERS} DECKS (${room.players.length}/${MIN_PLAYERS})`
                    : !videosReady
                    ? 'LOAD BOTH TAPES FIRST'
                    : `${room.players.length} DECKS ARMED`}
                </span>
              </>
            ) : (
              <span className="osd-text" style={{ color: 'var(--neon-cyan)' }}>
                ⏳ WAITING FOR HOST TO ROLL TAPE…
              </span>
            )}
            <button className="btn-brutal dark" onClick={() => router.push('/dashboard')}>
              ⏏ LEAVE
            </button>
          </div>
        </div>

        {/* ── Right: sleeve code, tape setup, OSD config ─────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="sleeve-case">
            <h3
              className="brutal-title"
              style={{ fontSize: '1.2rem', color: '#fff', textShadow: 'none' }}
            >
              TAPE SLEEVE CODE
            </h3>
            <div className="sleeve-label">
              <div className="sleeve-code">{code}</div>
            </div>
            <button
              id="copy-code-btn"
              className="btn-brutal cyan"
              style={{ fontSize: '0.9rem', padding: '8px 16px' }}
              onClick={copyCode}
            >
              {copied ? '✓ COPIED' : '📋 COPY LINK'}
            </button>
            <p className="osd-text" style={{ fontSize: '0.75rem', color: '#aaa', marginTop: 10 }}>
              Share this label code with crewmates
            </p>
          </div>

          <VideoSetupPanel room={room} isHost={isHost} actions={actions} code={code} />

          {/* Camcorder config — the host edits here, everyone else reads it. */}
          <div className="osd-menu">
            <div className="osd-menu-title">--- Camcorder Config ---</div>

            <div className="osd-menu-row">
              <span>VIDEO SOURCE:</span>
              <span style={{ color: 'var(--neon-yellow)' }}>
                {hasRandomVideoCategory
                  ? (VIDEO_CATEGORIES[genre!]?.name ?? genre!).toUpperCase()
                  : 'LINE-1 (CUSTOM)'}
              </span>
            </div>

            <div className="osd-menu-row">
              <span>WORDS EACH:</span>
              {isHost ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    id="words-minus-btn"
                    className="osd-menu-btn"
                    disabled={wordsInput <= 1}
                    onClick={() => applyWords(wordsInput - 1)}
                  >
                    −
                  </button>
                  <span style={{ color: 'var(--neon-yellow)', minWidth: 16, textAlign: 'center' }}>
                    {wordsInput}
                  </span>
                  <button
                    id="words-plus-btn"
                    className="osd-menu-btn"
                    disabled={wordsInput >= 10}
                    onClick={() => applyWords(wordsInput + 1)}
                  >
                    +
                  </button>
                </span>
              ) : (
                <span style={{ color: 'var(--neon-yellow)' }}>
                  {room.settings.wordsPerPlayer ?? 1}
                </span>
              )}
            </div>

            {/* Pinned to 1 for Phase 1 (section 16). The 2-imposter option
                unlocks at 7+ players and needs the two-round word/vote
                structure from section 3. */}
            <div className="osd-menu-row">
              <span>SUSPECTS:</span>
              <span style={{ color: 'var(--neon-yellow)' }}>1 PLAYER</span>
            </div>

            <div className="osd-menu-row">
              <span>AUDIO OUT:</span>
              <span style={{ color: 'var(--neon-yellow)' }}>
                {(room.settings.chatType ?? 'text').toUpperCase()}
              </span>
            </div>

            <div className="osd-menu-row">
              <span>TAPE MODE:</span>
              <span style={{ color: 'var(--neon-yellow)' }}>
                {room.settings.isPublic ? 'SP (PUBLIC)' : 'EP (PRIVATE)'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
