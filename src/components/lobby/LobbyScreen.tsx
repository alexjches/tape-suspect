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
import { vcrSkinStyles } from '@/lib/cosmetics';
import { useRouter } from 'next/navigation';

// Section 20: lobby size is 4–10. Mirrors MIN_PLAYERS/MAX_PLAYERS in
// socketHandlers.ts — the server clamps regardless, this just greys buttons.
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;

// Genre order for the OSD's ‹ › stepper, Custom included (section 4).
const GENRE_IDS = Object.keys(VIDEO_CATEGORIES);

// Section 3: the 2-suspect mode unlocks at 7 players.
const TWO_IMPOSTER_MIN_PLAYERS = 7;

// .osd-menu-btn inverts on hover; this is the same treatment held on.
const activeOsdBtn: React.CSSProperties = { background: '#fff', color: '#0000aa' };

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

// The two host-only badges clipped to the top edge of a player's console.
const consoleBadgeStyle: React.CSSProperties = {
  position: 'absolute',
  top: -12,
  zIndex: 11,
  width: 22,
  height: 22,
  borderRadius: 6,
  border: '2px solid #000',
  color: '#000',
  fontFamily: 'var(--font-osd)',
  fontSize: '0.7rem',
  lineHeight: 1,
  cursor: 'pointer',
  boxShadow: '2px 2px 0px #000',
};

interface Props {
  room: RoomPublic;
  playerId: string;
  isHost: boolean;
  actions: RoomActions;
  code: string;
  error: string | null;
}

export function LobbyScreen({ room, playerId, isHost, actions, code, error }: Props) {
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

  function applyMaxPlayers(val: number) {
    // The server clamps too; this just keeps the buttons honest.
    const clamped = Math.max(MIN_PLAYERS, room.players.length, Math.min(MAX_PLAYERS, val));
    actions.updateSettings(code, { maxPlayers: clamped });
  }

  const genre = room.settings.videoCategory;
  const hasRandomVideoCategory = !!genre && genre !== CUSTOM_CATEGORY;
  const genreLabel = hasRandomVideoCategory
    ? (VIDEO_CATEGORIES[genre!]?.name ?? genre!).toUpperCase()
    : 'LINE-1 (CUSTOM)';
  const maxPlayers = room.settings.maxPlayers;
  const chatType = room.settings.chatType ?? 'text';
  const anonymousBallot = room.settings.voteVisibility === 'anonymous';
  const imposterCount = room.settings.imposterCount ?? 1;
  const twoImpostersUnlocked = room.players.length >= TWO_IMPOSTER_MIN_PLAYERS;

  /** Steps the genre through the §4 list, wrapping at both ends. */
  function cycleGenre(step: number) {
    const ids = GENRE_IDS;
    const current = ids.indexOf(genre ?? CUSTOM_CATEGORY);
    const next = ids[(current + step + ids.length) % ids.length];
    actions.updateSettings(code, { videoCategory: next });
  }
  // Section 4: on a Custom round whoever loaded the tapes sits out, so the
  // lobby needs one more head than a pool round to field the same game.
  const sittingOut =
    !hasRandomVideoCategory && room.customVideoAuthorId
      ? room.players.find((p) => p.id === room.customVideoAuthorId)
      : undefined;
  const playingCount = room.players.length - (sittingOut ? 1 : 0);
  const enoughPlayers = playingCount >= MIN_PLAYERS;
  const videosReady =
    hasRandomVideoCategory || (room.settings.hasNormalVideo && room.settings.hasImposterVideo);
  const canStart = enoughPlayers && videosReady;

  // Keep at least MIN_PLAYERS slots on screen so the gap to a legal start is
  // visible rather than implied by a disabled button.
  const emptySlots = Math.max(0, MIN_PLAYERS - playingCount);

  return (
    <div className="view-panel active-view">
      <div className="lobby-layout">
        {/* ── Left: connected consoles ───────────────────────────── */}
        <div>
          <h2 className="brutal-title" style={{ fontSize: '1.8rem', marginBottom: 20 }}>
            📼 CONNECTED PLAYERS ({room.players.length}/{room.settings.maxPlayers})
          </h2>

          {error && (
            <div className="word-phase-banner" style={{ display: 'block', marginBottom: 16 }}>
              ⛔ {error}
            </div>
          )}

          {/* Section 4: say who is sitting out before anyone hits start —
              finding out when the tape rolls is a nasty surprise. */}
          {sittingOut && (
            <div className="word-phase-banner" style={{ display: 'block', marginBottom: 16 }}>
              👁️ {sittingOut.name.toUpperCase()} LOADED THE TAPES AND SITS THIS ROUND OUT —
              NEEDS {MIN_PLAYERS} OTHERS TO PLAY
            </div>
          )}

          <div className="tapes-grid">
            {room.players.map((player, i) => {
              const color = CHANNEL_COLORS[i % CHANNEL_COLORS.length];
              const isMe = player.id === playerId;
              const online = player.status === 'connected';
              // Section 10: a bought VCR skin repaints your console for
              // everyone, not just you — cosmetics ride along on the roster.
              const skin = vcrSkinStyles(player.cosmetics, color);

              return (
                <div
                  key={player.id}
                  className={`vhs-player${online ? ' ready' : ''}`}
                  style={{
                    ...skin.shell,
                    cursor: 'default',
                    opacity: online ? 1 : 0.45,
                  }}
                >
                  <div className="player-avatar-circle" style={{ fontSize: '1.4rem' }}>
                    {player.avatar}
                  </div>

                  {player.isHost && <span className="player-host-tag">LOBBY HOST</span>}
                  {player.id === sittingOut?.id && (
                    <span
                      className="player-host-tag"
                      style={{ top: 'auto', bottom: -10, background: 'var(--neon-cyan)' }}
                    >
                      SITTING OUT
                    </span>
                  )}

                  <div className="player-tag" style={skin.tag}>
                    PLAYER-{i + 1}
                  </div>

                  {isHost && !isMe && (
                    <button
                      id={`kick-${player.id}`}
                      title="Eject player"
                      onClick={() => actions.kick(code, player.id)}
                      style={{
                        ...consoleBadgeStyle,
                        left: 8,
                        background: 'var(--neon-magenta)',
                        color: '#fff',
                      }}
                    >
                      ✕
                    </button>
                  )}

                  {/* Manual host transfer, section 4 — the host can hand the
                      lobby over rather than ending it by leaving. */}
                  {isHost && !isMe && online && (
                    <button
                      id={`make-host-${player.id}`}
                      title={`Make ${player.name} the host`}
                      onClick={() => actions.transferHost(code, player.id)}
                      style={{ ...consoleBadgeStyle, right: 8, background: 'var(--neon-yellow)' }}
                    >
                      ♛
                    </button>
                  )}

                  <div className="player-display" style={skin.display}>
                    <div className="player-display-text" style={skin.displayText}>
                      {player.name}
                      {isMe ? ' (YOU)' : ''}
                    </div>
                    <div className="player-display-status" style={skin.status}>
                      <span>CH. {i + 1}</span>
                      <span>{online ? '● READY' : '○ SIGNAL LOST'}</span>
                    </div>
                  </div>

                  <div className="player-vcr-slot" style={skin.slot}>
                    <div className="player-vcr-door-flap" style={skin.flap} />
                  </div>

                  <div className="player-controls">
                    <div
                      className={`player-led${online ? ' active' : ''}`}
                      style={online ? skin.led : undefined}
                    />
                    <div className="vcr-btns">
                      <div className="vcr-btn" style={skin.button} />
                      <div className="vcr-btn" style={skin.button} />
                      <div className="vcr-btn" style={skin.button} />
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
                    ? `NEED ${MIN_PLAYERS} PLAYERS (${playingCount}/${MIN_PLAYERS})`
                    : !videosReady
                    ? 'LOAD BOTH TAPES FIRST'
                    : `${playingCount} PLAYERS ARMED`}
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

            {/* Section 4: every row below is live for the host between rounds
                — no need to close the lobby to change the setup. */}
            <div className="osd-menu-row">
              <span>VIDEO SOURCE:</span>
              {isHost ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    id="genre-prev-btn"
                    className="osd-menu-btn"
                    onClick={() => cycleGenre(-1)}
                  >
                    ‹
                  </button>
                  <span
                    style={{ color: 'var(--neon-yellow)', minWidth: 96, textAlign: 'center' }}
                  >
                    {genreLabel}
                  </span>
                  <button
                    id="genre-next-btn"
                    className="osd-menu-btn"
                    onClick={() => cycleGenre(1)}
                  >
                    ›
                  </button>
                </span>
              ) : (
                <span style={{ color: 'var(--neon-yellow)' }}>{genreLabel}</span>
              )}
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

            {/* Section 3: 2 suspects unlocks at 7 players and runs two full
                word+vote rounds instead of one. */}
            <div className="osd-menu-row">
              <span>SUSPECTS:</span>
              {isHost ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    id="imposters-1-btn"
                    className="osd-menu-btn"
                    style={imposterCount === 1 ? activeOsdBtn : undefined}
                    onClick={() => actions.updateSettings(code, { imposterCount: 1 })}
                  >
                    1
                  </button>
                  <button
                    id="imposters-2-btn"
                    className="osd-menu-btn"
                    style={imposterCount === 2 ? activeOsdBtn : undefined}
                    disabled={!twoImpostersUnlocked}
                    title={
                      twoImpostersUnlocked
                        ? 'Two suspects, two word-and-vote rounds'
                        : `Unlocks at ${TWO_IMPOSTER_MIN_PLAYERS} players`
                    }
                    onClick={() => actions.updateSettings(code, { imposterCount: 2 })}
                  >
                    2
                  </button>
                </span>
              ) : (
                <span style={{ color: 'var(--neon-yellow)' }}>
                  {imposterCount} PLAYER{imposterCount === 1 ? '' : 'S'}
                </span>
              )}
            </div>

            {imposterCount === 2 && (
              <div
                className="osd-text"
                style={{ fontSize: '0.7rem', color: '#aaa', padding: '0 4px 6px' }}
              >
                TWO ROUNDS: WORDS → VOTE → WORDS → VOTE. BOTH SUSPECTS REVEALED AT THE END.
              </div>
            )}
            {!twoImpostersUnlocked && isHost && (
              <div
                className="osd-text"
                style={{ fontSize: '0.7rem', color: '#666', padding: '0 4px 6px' }}
              >
                2 SUSPECTS UNLOCKS AT {TWO_IMPOSTER_MIN_PLAYERS} PLAYERS.
              </div>
            )}

            <div className="osd-menu-row">
              <span>MAX PLAYERS:</span>
              {isHost ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    id="max-players-minus-btn"
                    className="osd-menu-btn"
                    disabled={maxPlayers <= Math.max(MIN_PLAYERS, room.players.length)}
                    onClick={() => applyMaxPlayers(maxPlayers - 1)}
                  >
                    −
                  </button>
                  <span style={{ color: 'var(--neon-yellow)', minWidth: 16, textAlign: 'center' }}>
                    {maxPlayers}
                  </span>
                  <button
                    id="max-players-plus-btn"
                    className="osd-menu-btn"
                    disabled={maxPlayers >= MAX_PLAYERS}
                    onClick={() => applyMaxPlayers(maxPlayers + 1)}
                  >
                    +
                  </button>
                </span>
              ) : (
                <span style={{ color: 'var(--neon-yellow)' }}>{maxPlayers}</span>
              )}
            </div>

            {/* Phase 1 chat scope is text on/off (§16); voice and video return
                to this row in Phase 2 alongside the host form buttons. */}
            <div className="osd-menu-row">
              <span>AUDIO OUT:</span>
              {isHost ? (
                <button
                  id="chat-toggle-btn"
                  className="osd-menu-btn"
                  onClick={() =>
                    actions.updateSettings(code, { chatType: chatType === 'none' ? 'text' : 'none' })
                  }
                >
                  {chatType.toUpperCase()}
                </button>
              ) : (
                <span style={{ color: 'var(--neon-yellow)' }}>{chatType.toUpperCase()}</span>
              )}
            </div>

            <div className="osd-menu-row">
              <span>TAPE MODE:</span>
              {isHost ? (
                <button
                  id="visibility-toggle-btn"
                  className="osd-menu-btn"
                  onClick={() => actions.updateSettings(code, { isPublic: !room.settings.isPublic })}
                >
                  {room.settings.isPublic ? 'SP (PUBLIC)' : 'EP (PRIVATE)'}
                </button>
              ) : (
                <span style={{ color: 'var(--neon-yellow)' }}>
                  {room.settings.isPublic ? 'SP (PUBLIC)' : 'EP (PRIVATE)'}
                </span>
              )}
            </div>

            {/* §4: whether the ballot is live. Changeable between rounds like
                everything else here — the server refuses it mid-round, which
                stops a flip from retroactively publishing votes. */}
            <div className="osd-menu-row">
              <span>BALLOT:</span>
              {isHost ? (
                <button
                  id="vote-visibility-toggle-btn"
                  className="osd-menu-btn"
                  onClick={() =>
                    actions.updateSettings(code, {
                      voteVisibility: anonymousBallot ? 'public' : 'anonymous',
                    })
                  }
                >
                  {anonymousBallot ? 'ANONYMOUS' : 'PUBLIC'}
                </button>
              ) : (
                <span style={{ color: 'var(--neon-yellow)' }}>
                  {anonymousBallot ? 'ANONYMOUS' : 'PUBLIC'}
                </span>
              )}
            </div>
            <div
              className="osd-text"
              style={{ fontSize: '0.7rem', color: '#aaa', padding: '0 4px 6px' }}
            >
              {anonymousBallot
                ? 'NOBODY SEES A VOTE UNTIL THE FINAL TALLY.'
                : 'EVERYONE WATCHES THE VOTES LAND LIVE.'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
