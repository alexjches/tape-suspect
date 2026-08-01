'use client';
// src/components/game/DeliberationScreen.tsx
// Section 8: ONE 90s window with chat and voting live at the same time.
// Layout mirrors #view-voting in vhs-frontend-example/index.html.

import { useEffect, useRef, useState } from 'react';
import type {
  RoomPublic,
  GameWord,
  ChatMessage,
  VoteTally,
  DeliberationState,
} from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { vcrSkinStyles } from '@/lib/cosmetics';

// Console glow colours, assigned by seat so they stay stable across renders.
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
  code: string;
  words: GameWord[];
  chatMessages: ChatMessage[];
  voteTally: VoteTally | null;
  deliberation: DeliberationState | null;
  secondsLeft: number | null;
  actions: RoomActions;
}

export function DeliberationScreen({
  room,
  socketId,
  code,
  words,
  chatMessages,
  voteTally,
  deliberation,
  secondsLeft,
  actions,
}: Props) {
  const [myVote, setMyVote] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [voteError, setVoteError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const revoteCandidates = deliberation?.revoteCandidates ?? null;
  const eligibleVoters = deliberation?.eligibleVoters ?? null;
  const voteRound = deliberation?.voteRound ?? 1;

  // A re-vote clears the ballots of whoever must recast, so let them vote
  // again. Players who kept their vote stay locked (section 8).
  useEffect(() => {
    if (!revoteCandidates) return;
    if (!eligibleVoters || eligibleVoters.includes(socketId)) {
      setMyVote(null);
      setVoteError(null);
    }
  }, [revoteCandidates, eligibleVoters, socketId, voteRound]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chatMessages.length, words.length]);

  const chatEnabled = room.settings.chatType === 'text';
  const inRevote = !!revoteCandidates;
  const canRecast = !eligibleVoters || eligibleVoters.includes(socketId);

  // Section 3: someone ejected in round 1 neither votes nor stands in round 2.
  const accusedIds = room.accusedIds ?? [];
  const amAccused = accusedIds.includes(socketId);
  // Section 4: the Custom author neither votes nor stands, all round.
  const isOut = (id: string) =>
    accusedIds.includes(id) || !!room.players.find((p) => p.id === id)?.isSpectator;
  const amSpectator = !!room.players.find((p) => p.id === socketId)?.isSpectator;
  const totalRounds = room.totalRounds ?? 1;
  const gameRound = room.gameRound ?? 1;

  const locked = (inRevote && !canRecast) || amAccused || amSpectator;

  const handleVote = (targetId: string) => {
    if (myVote || targetId === socketId || locked) return;
    if (isOut(targetId)) return;
    if (inRevote && !revoteCandidates!.includes(targetId)) return;

    setMyVote(targetId);
    setVoteError(null);
    actions.castVote(code, targetId).catch((err: Error) => {
      setMyVote(null);
      setVoteError(err.message);
    });
  };

  const handleSend = () => {
    const msg = draft.trim();
    if (!msg || !chatEnabled) return;
    actions.sendChat(code, msg);
    setDraft('');
  };

  const timerColor =
    secondsLeft === null || secondsLeft > 30
      ? 'var(--neon-green)'
      : secondsLeft > 10
      ? 'var(--neon-yellow)'
      : 'var(--neon-magenta)';

  return (
    <div className="view-panel active-view">
      <div className="voting-layout">
        {/* ── Left: player consoles ─────────────────────────────── */}
        <div>
          <div className="voting-instructions">
            <div>
              <h2 className="brutal-title" style={{ fontSize: '1.8rem' }}>
                🚨 EJECT VOTING SYSTEM
                {totalRounds > 1 ? ` — VOTE ${gameRound} OF ${totalRounds}` : ''}
              </h2>
              <p className="osd-text" style={{ color: '#aaa', marginTop: 4 }}>
                {amSpectator
                  ? 'You loaded the tapes — you can watch, but not vote'
                  : amAccused
                  ? 'You were ejected — you can watch, but the ballot is closed to you'
                  : locked
                  ? 'Your vote stands — waiting on the swing voters to break the tie'
                  : inRevote
                  ? 'TIE DETECTED — recast, restricted to the tied players'
                  : myVote
                  ? 'Vote locked in. Keep talking until the tape runs out.'
                  : "Click a player's console to cast your suspect vote"}
              </p>
            </div>
          </div>

          {inRevote && (
            <div className="word-phase-banner" style={{ display: 'block' }}>
              ⚠️ RE-VOTE {voteRound > 1 ? `#${voteRound - 1}` : ''} — ballot limited to{' '}
              {revoteCandidates!
                .map((id) => room.players.find((p) => p.id === id)?.name ?? '???')
                .join(' vs ')}
            </div>
          )}

          {voteError && (
            <div className="word-phase-banner" style={{ display: 'block' }}>
              ⛔ {voteError}
            </div>
          )}

          <div className="voting-monitor-grid">
            {room.players.map((player, i) => {
              const color = CHANNEL_COLORS[i % CHANNEL_COLORS.length];
              const votes = voteTally?.tally?.[player.id] ?? 0;
              const isMe = player.id === socketId;
              const ejected = isOut(player.id);
              const onBallot =
                !ejected && (!inRevote || revoteCandidates!.includes(player.id));
              const selectable = !myVote && !isMe && !locked && onBallot;
              // Same console, same skin as the lobby (section 10).
              const skin = vcrSkinStyles(player.cosmetics, color);

              return (
                <div
                  key={player.id}
                  className={`vhs-player monitor-screen ready${
                    myVote === player.id ? ' voted' : ''
                  }`}
                  onClick={() => selectable && handleVote(player.id)}
                  style={{
                    ...skin.shell,
                    cursor: selectable ? 'pointer' : 'not-allowed',
                    opacity: onBallot ? 1 : 0.4,
                  }}
                >
                  <div className="monitor-osd">
                    CH. {i + 1} {isMe ? '- YOU' : '- REC'}
                  </div>
                  <div className="player-tag" style={skin.tag}>
                    {player.avatar} {player.isHost ? 'HOST' : `PLAYER-${i + 1}`}
                  </div>
                  <div className="player-display" style={skin.display}>
                    <div className="player-display-text" style={skin.displayText}>
                      {player.name}
                    </div>
                    <div className="player-display-status" style={skin.status}>
                      <span>CH. {i + 1}</span>
                      <span style={{ color: 'var(--neon-yellow)' }}>
                        {votes} VOTE{votes === 1 ? '' : 'S'}
                      </span>
                    </div>
                  </div>
                  <div className="player-vcr-slot loaded" style={skin.slot}>
                    <div className="player-vcr-door-flap" style={skin.flap} />
                    <div className="player-vcr-inserted-tape">
                      <div className="inserted-tape-label" />
                      <div className="inserted-tape-spools">
                        <div className="i-spool" />
                        <div className="i-spool" />
                      </div>
                    </div>
                  </div>
                  <div className="player-controls">
                    <div
                      className={`player-led${
                        player.status === 'connected' ? ' active' : ''
                      }`}
                      style={player.status === 'connected' ? skin.led : undefined}
                    />
                    <div className="vcr-btns">
                      <div className="vcr-btn" style={skin.button} />
                      <div className="vcr-btn" style={skin.button} />
                      <div className="vcr-btn" style={skin.button} />
                    </div>
                  </div>
                  {myVote === player.id && <div className="vote-stamp">SUSPECT</div>}
                  {ejected && myVote !== player.id && (
                    <div className="vote-stamp">EJECTED</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: timer + words + chat ────────────────────────── */}
        <div className="voting-right-column">
          <div className="osd-text voting-timer-block">
            TIMER: <span style={{ color: timerColor }}>{secondsLeft ?? '--'}</span>s
            {voteTally && (
              <span style={{ marginLeft: 12, color: '#aaa' }}>
                {voteTally.votescast}/{voteTally.totalVoters} VOTED
              </span>
            )}
          </div>

          <div className="voting-chat-box">
            <div className="voting-chat-header">
              <span>💬 COMMUNICATE TERMINAL</span>
            </div>

            {/* Words carried over from the word phase */}
            <div className="pinned-words-strip">
              <div className="pinned-words-label">📌 PINNED — VIDEO WORDS</div>
              <div className="pinned-words-chips">
                {words.length === 0 && (
                  <span className="osd-text" style={{ color: '#666' }}>
                    (no words recorded)
                  </span>
                )}
                {words.map((w, i) => {
                  const seat = room.players.findIndex((p) => p.id === w.playerId);
                  return (
                    <div className="word-chip" key={`${w.playerId}-${i}`}>
                      <span
                        className="word-chip-author"
                        style={{
                          color:
                            CHANNEL_COLORS[
                              (seat < 0 ? i : seat) % CHANNEL_COLORS.length
                            ],
                        }}
                      >
                        {w.playerName}:
                      </span>
                      <span className="word-chip-word">{w.word}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="voting-chat-log" ref={logRef}>
              {!chatEnabled && (
                <div className="chat-log-msg system">
                  {room.settings.chatType === 'none'
                    ? 'External comms lobby — talk on your own call.'
                    : `${room.settings.chatType.toUpperCase()} lobby — no text chat.`}
                </div>
              )}
              {chatMessages.map((m, i) => (
                <div className="chat-log-msg" key={`${m.timestamp}-${i}`}>
                  <span className="author">{m.playerName}:</span> {m.message}
                </div>
              ))}
            </div>

            {chatEnabled && (
              <div className="voting-chat-input-row">
                <input
                  type="text"
                  className="voting-chat-input"
                  placeholder="Make your case..."
                  maxLength={300}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                />
                <button
                  className="btn-brutal cyan"
                  style={{ padding: '8px 16px', margin: 0, fontSize: '0.9rem', height: 'auto' }}
                  onClick={handleSend}
                >
                  SEND
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
