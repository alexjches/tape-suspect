'use client';
// src/components/lobby/LobbyScreen.tsx
//
// Two panels and a footer, laid out like the reference lobby in the project
// root ("example lobby.png"): the roster of VCR consoles on the left, the
// game options on the right, INVITE and ROLL TAPE across the bottom.
//
// The right panel is two tabs. GAME MODE is the five genres from §4 as icon
// cards — that is the only choice most lobbies ever make, so it is the one
// that gets the space. Everything else (words, suspects, chat, ballot,
// visibility, cap) lives behind CUSTOM SETTINGS. Nothing is asked before the
// lobby exists any more; /dashboard formats the deck on click and the host
// sets it up here, in front of the people who are about to play it.
//
// The room code / header chrome is owned by CrtShell, so this renders only
// the lobby body.

import { useState } from 'react';
import { RoomPublic } from '@/types';
import type { RoomActions } from '@/hooks/useRoom';
import { CustomContentPanel } from './CustomContentPanel';
import {
  VIDEO_CATEGORIES,
  MODE_GROUPS,
  isDrawStyle,
  isPromptStyle,
  supportsCustomContent,
} from '@/lib/videoCategories';
import { vcrSkinStyles } from '@/lib/cosmetics';
import { Avatar } from '@/components/vhs/Avatar';
import { useRouter } from 'next/navigation';
import { useHomeHref } from '@/lib/useHomeHref';

// Lobby size is 3–10. Mirrors MIN_PLAYERS/MAX_PLAYERS in socketHandlers.ts —
// the server clamps regardless, this just greys buttons. The floor of 3 is an
// owner decision that overrides spec §20's 4; see CLAUDE.md.
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;

// Section 3: the 2-suspect mode unlocks at 7 players.
const TWO_IMPOSTER_MIN_PLAYERS = 7;

// ── CUSTOM SETTINGS controls ─────────────────────────────────────────
// Three pieces, because the tab is six rows of the same two shapes. They are
// styled as cards in the lobby's own language (dark fill, black border, offset
// shadow, Lilita labels) rather than in vhs.css's `.osd-menu`, which is a
// literal VCR on-screen display — right for the watch overlay it was written
// for, and a flat blue box in the middle of this screen.
//
// `editable` rather than `disabled`: a non-host has to be able to *read* what
// the lobby is set to, so they get the value as plain text instead of a greyed
// control they might think is broken.

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      {children}
    </div>
  );
}

function Stepper({
  id,
  value,
  min,
  max,
  editable,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  editable: boolean;
  onChange: (next: number) => void;
}) {
  if (!editable) return <span className="setting-value">{value}</span>;
  return (
    <span className="setting-stepper">
      <button
        id={`${id}-minus-btn`}
        className="setting-step-btn"
        disabled={value <= min}
        aria-label={`Decrease ${id}`}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="setting-stepper-value">{value}</span>
      <button
        id={`${id}-plus-btn`}
        className="setting-step-btn"
        disabled={value >= max}
        aria-label={`Increase ${id}`}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </span>
  );
}

interface ChoiceOption {
  id: string;
  value: string;
  label: string;
  disabled?: boolean;
  title?: string;
}

/**
 * Mutually exclusive options as one segmented control.
 *
 * The binary rows used to be a single button you clicked to cycle, which reads
 * as "press to change" without ever saying what it would change *to*. Both
 * options on screen at once matches the mode cards next door, and makes the
 * unreachable one (2 suspects under 7 players) visibly unreachable.
 */
function Choice({
  options,
  value,
  editable,
  onChange,
}: {
  options: ChoiceOption[];
  value: string;
  editable: boolean;
  onChange: (next: string) => void;
}) {
  if (!editable) {
    const active = options.find((o) => o.value === value);
    return <span className="setting-value">{active?.label ?? value}</span>;
  }
  return (
    <span className="setting-choice" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          id={o.id}
          className={`setting-choice-btn${o.value === value ? ' active' : ''}`}
          disabled={o.disabled}
          title={o.title}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

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
  // LEAVE goes to the lobby router, not to the landing page — and for a guest
  // that means /dashboard?guest=1, since a bare /dashboard bounces them.
  const homeHref = useHomeHref();
  const [copied, setCopied] = useState(false);
  const [wordsInput, setWordsInput] = useState<number>(room.settings.wordsPerPlayer ?? 1);
  const [botError, setBotError] = useState<string | null>(null);
  const [tab, setTab] = useState<'mode' | 'custom'>('mode');

  const botCount = room.players.filter((p) => p.isBot).length;

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
  // Custom is a switch on the mode now, not a mode — and it only takes effect
  // on the two styles that have a pair a host can type.
  const customContent = room.settings.useCustomContent && supportsCustomContent(genre);
  const maxPlayers = room.settings.maxPlayers;
  const chatType = room.settings.chatType ?? 'text';
  const anonymousBallot = room.settings.voteVisibility === 'anonymous';
  // The hint row only means anything on Fake Artist, so it only appears there
  // rather than sitting greyed out on every other mode's settings tab.
  const drawRound = isDrawStyle(room.settings.videoCategory);
  const themeHintOn = room.settings.themeHint !== false;
  const imposterCount = room.settings.imposterCount ?? 1;
  const twoImpostersUnlocked = room.players.length >= TWO_IMPOSTER_MIN_PLAYERS;

  // Section 4: on a custom round whoever typed the content sits out, so the
  // lobby needs one more head than a pool round to field the same game.
  const sittingOut =
    customContent && room.customContentAuthorId
      ? room.players.find((p) => p.id === room.customContentAuthorId)
      : undefined;
  const playingCount = room.players.length - (sittingOut ? 1 : 0);
  const enoughPlayers = playingCount >= MIN_PLAYERS;
  // A pool round is always loaded. A custom one is waiting on both halves of
  // whichever pair its mode takes.
  const contentReady =
    !customContent ||
    (isPromptStyle(genre)
      ? room.settings.hasNormalPrompt && room.settings.hasImposterPrompt
      : room.settings.hasNormalVideo && room.settings.hasImposterVideo);
  const canStart = enoughPlayers && contentReady;

  // Keep at least MIN_PLAYERS slots on screen so the gap to a legal start is
  // visible rather than implied by a disabled button.
  const emptySlots = Math.max(0, MIN_PLAYERS - playingCount);

  return (
    <div className="view-panel active-view">
      {/* .lobby-layout is also the reference's outer box — it is capped,
          centred and bordered in globals.css so the lobby sits on a card of
          its own with the background showing all the way round it, rather
          than running edge to edge. One element, because a grid can be the
          card as easily as it can sit inside one. */}
      <div className="lobby-layout">
        {/* ── Left: the roster ───────────────────────────────────── */}
        <section className="lobby-panel lobby-roster-panel">
          <h2 className="lobby-panel-title">
            PLAYERS {room.players.length}/{maxPlayers}
          </h2>

          {error && (
            <div className="word-phase-banner" style={{ display: 'block', marginBottom: 12 }}>
              ⛔ {error}
            </div>
          )}

          {/* Section 4: say who is sitting out before anyone hits start —
              finding out when the tape rolls is a nasty surprise. */}
          {sittingOut && (
            <div className="word-phase-banner" style={{ display: 'block', marginBottom: 12 }}>
              👁️ {sittingOut.name.toUpperCase()} WROTE THIS ROUND AND SITS IT OUT —
              NEEDS {MIN_PLAYERS} OTHERS TO PLAY
            </div>
          )}

          <div className="lobby-roster-list">
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
                  <div className="player-avatar-circle character-slot">
                    <Avatar code={player.avatar} size={46} />
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
                    {player.isBot ? 'SIM' : `PLAYER-${i + 1}`}
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
                      lobby over rather than ending it by leaving.

                      Never to a bot: a simulated player has no socket and can
                      never press Roll Tape, so handing it the lobby strands
                      the room with nobody able to start it and no way back.
                      The server refuses this too — this only stops the button
                      being offered. */}
                  {isHost && !isMe && online && !player.isBot && (
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

          {/* ── Simulated players (testing) ──────────────────────────
              Only for the host, and only on a server that allows it —
              `botsAllowed` comes off the room rather than a NEXT_PUBLIC env
              var so the button and the handler can never disagree about
              whether this works. Set apart from the real controls above,
              and labelled as a test tool, because it is one. */}
          {isHost && room.botsAllowed && (
            <div className="sim-players-bar">
              <span className="osd-text sim-players-label">🧪 TESTING</span>
              <button
                className="btn-brutal cyan sim-players-btn"
                onClick={() => {
                  setBotError(null);
                  actions.addBots(code).catch((e: Error) => setBotError(e.message));
                }}
              >
                🤖 SIMULATE PLAYERS
              </button>
              {botCount > 0 && (
                <button
                  className="btn-brutal dark sim-players-btn"
                  onClick={() => {
                    setBotError(null);
                    actions.removeBots(code).catch((e: Error) => setBotError(e.message));
                  }}
                >
                  ✕ CLEAR {botCount} BOT{botCount === 1 ? '' : 'S'}
                </button>
              )}
              {botError && <span className="osd-text sim-players-note">⛔ {botError}</span>}
            </div>
          )}
        </section>

        {/* ── Right: game options ────────────────────────────────── */}
        <section className="lobby-panel lobby-config-panel">
          <div className="lobby-tabs">
            <button
              id="tab-mode-btn"
              className={`lobby-tab${tab === 'mode' ? ' active' : ''}`}
              onClick={() => setTab('mode')}
            >
              GAME MODE
            </button>
            <button
              id="tab-custom-btn"
              className={`lobby-tab${tab === 'custom' ? ' active' : ''}`}
              onClick={() => setTab('custom')}
            >
              CUSTOM SETTINGS
            </button>
          </div>

          <div className="lobby-tab-body">
            {tab === 'mode' ? (
              <>
                {/* The mode list, in two sections: the games, then the videos.
                    One undivided grid would say these are ten flavours of the
                    same thing — the one distinction that changes the next five
                    minutes is whether there is a tape everyone has to watch
                    together, so that is the only line the headings draw.

                    The host picks; everyone else reads it — a non-host's card
                    is inert rather than hidden, so the lobby always agrees on
                    what it is about to play. */}
                {MODE_GROUPS.map((group) => (
                  <section key={group.id} className="mode-group">
                    <h4 className="mode-group-title">
                      <span>{group.label}</span>
                      <span className="mode-group-rule" aria-hidden="true" />
                    </h4>
                    <div className="mode-grid">
                      {group.modeIds.map((id) => {
                        const c = VIDEO_CATEGORIES[id];
                        if (!c) return null;
                        const active = genre === c.id;
                        return (
                          <button
                            key={c.id}
                            id={`mode-${c.id}`}
                            className={`mode-card${active ? ' active' : ''}`}
                            disabled={!isHost}
                            title={c.description}
                            onClick={() => actions.updateSettings(code, { videoCategory: c.id })}
                          >
                            <span className="mode-card-icon">{c.icon}</span>
                            <span className="mode-card-name">{c.name.toUpperCase()}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}

                {/* Custom sits under everything, on purpose: it is a switch on
                    the mode you just pressed rather than a mode of its own, so
                    it has to come after the choice it modifies. It stays in
                    this tab and not in CUSTOM SETTINGS because what it needs —
                    two links, or two cards — is content for the round, not a
                    rule about it. */}
                <CustomContentPanel room={room} isHost={isHost} actions={actions} code={code} />
              </>
            ) : (
              /* Section 4: every row below is live for the host between rounds
                 — no need to close the lobby to change the setup. */
              <div className="settings-list">
                <SettingRow label="WORDS EACH">
                  <Stepper
                    id="words"
                    value={wordsInput}
                    min={1}
                    max={10}
                    editable={isHost}
                    onChange={applyWords}
                  />
                </SettingRow>

                {/* Section 3: 2 suspects unlocks at 7 players and runs two full
                    word+vote rounds instead of one. */}
                <SettingRow label="SUSPECTS">
                  <Choice
                    value={String(imposterCount)}
                    editable={isHost}
                    onChange={(v) => actions.updateSettings(code, { imposterCount: Number(v) })}
                    options={[
                      { id: 'imposters-1-btn', value: '1', label: '1' },
                      {
                        id: 'imposters-2-btn',
                        value: '2',
                        label: '2',
                        disabled: !twoImpostersUnlocked,
                        title: twoImpostersUnlocked
                          ? 'Two suspects, two word-and-vote rounds'
                          : `Unlocks at ${TWO_IMPOSTER_MIN_PLAYERS} players`,
                      },
                    ]}
                  />
                </SettingRow>

                {/* The lock itself says "not yet" — the disabled 2 and its
                    tooltip carry it, so the line that used to spell it out
                    only broke the run of rows. */}
                {imposterCount === 2 && (
                  <p className="setting-hint">
                    TWO ROUNDS: WORDS → VOTE → WORDS → VOTE. BOTH SUSPECTS REVEALED AT THE END.
                  </p>
                )}

                <SettingRow label="MAX PLAYERS">
                  <Stepper
                    id="max-players"
                    value={maxPlayers}
                    min={Math.max(MIN_PLAYERS, room.players.length)}
                    max={MAX_PLAYERS}
                    editable={isHost}
                    onChange={applyMaxPlayers}
                  />
                </SettingRow>

                {/* Phase 1 chat scope is text on/off (§16); voice and video
                    return to this row in Phase 2, at which point the label
                    goes back to naming the channel rather than switching it. */}
                <SettingRow label="ENABLE TEXT CHAT">
                  <Choice
                    value={chatType === 'none' ? 'none' : 'text'}
                    editable={isHost}
                    onChange={(v) =>
                      actions.updateSettings(code, { chatType: v as typeof chatType })
                    }
                    options={[
                      { id: 'chat-text-btn', value: 'text', label: 'ON' },
                      { id: 'chat-none-btn', value: 'none', label: 'OFF' },
                    ]}
                  />
                </SettingRow>
                {/* Off does more than hide the chat box — it drops the word
                    round, which is the one consequence a host cannot see
                    coming from the switch itself. */}
                {chatType === 'none' && (
                  <p className="setting-hint">
                    NO WORD ROUND — STRAIGHT TO THE EJECT VOTE, WITH LONGER ON THE CLOCK.
                  </p>
                )}

                <SettingRow label="LOBBY PRIVACY">
                  <Choice
                    value={room.settings.isPublic ? 'public' : 'private'}
                    editable={isHost}
                    onChange={(v) => actions.updateSettings(code, { isPublic: v === 'public' })}
                    options={[
                      { id: 'visibility-public-btn', value: 'public', label: 'PUBLIC' },
                      { id: 'visibility-private-btn', value: 'private', label: 'PRIVATE' },
                    ]}
                  />
                </SettingRow>

                {/* §4: whether the ballot is live. Changeable between rounds
                    like everything else here — the server refuses it mid-round,
                    which stops a flip from retroactively publishing votes. */}
                <SettingRow label="BALLOT">
                  <Choice
                    value={anonymousBallot ? 'anonymous' : 'public'}
                    editable={isHost}
                    onChange={(v) =>
                      actions.updateSettings(code, {
                        voteVisibility: v as 'public' | 'anonymous',
                      })
                    }
                    options={[
                      { id: 'ballot-public-btn', value: 'public', label: 'PUBLIC' },
                      { id: 'ballot-anon-btn', value: 'anonymous', label: 'ANONYMOUS' },
                    ]}
                  />
                </SettingRow>

                {/* Fake Artist only — a difficulty dial, not a comms setting.
                    Broadcast rather than secret: everyone has to know whether
                    the fake is drawing blind, because it changes how damning a
                    bad stroke is. */}
                {drawRound && (
                  <SettingRow label="FAKE'S HINT">
                    <Choice
                      value={themeHintOn ? 'on' : 'off'}
                      editable={isHost}
                      onChange={(v) => actions.updateSettings(code, { themeHint: v === 'on' })}
                      options={[
                        { id: 'hint-on-btn', value: 'on', label: 'CATEGORY' },
                        { id: 'hint-off-btn', value: 'off', label: 'NOTHING' },
                      ]}
                    />
                  </SettingRow>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── Footer: invite, code, start ────────────────────────── */}
        <div className="lobby-actions">
          {/* Tell the server before routing: the socket survives client-side
              navigation, so walking away is not leaving unless we say so. */}
          <button
            className="btn-brutal dark lobby-action-btn"
            onClick={() => {
              actions.leave(code);
              router.push(homeHref);
            }}
          >
            ⏏ LEAVE
          </button>

          <button
            id="copy-code-btn"
            className="btn-brutal lobby-invite-btn lobby-action-btn"
            onClick={copyCode}
          >
            {copied ? '✓ COPIED' : '🔗 INVITE'}
            <span className="lobby-invite-code">{code}</span>
          </button>

          {isHost ? (
            <>
              {/* The head count rides on the button rather than in a note
                  beside it: it is the answer to "can I press this yet", so it
                  belongs on the thing being pressed. */}
              <button
                id="start-game-btn"
                className="btn-brutal green lobby-action-btn"
                disabled={!canStart}
                onClick={() => actions.startGame(code)}
              >
                ⏵ ROLL TAPE ({playingCount}/{MIN_PLAYERS})
              </button>
              {/* The only state the count cannot speak for: a custom lobby with
                  enough people but only half a pair typed. */}
              {enoughPlayers && !contentReady && (
                <span className="osd-text lobby-actions-note" style={{ color: '#aaa' }}>
                  {isPromptStyle(genre) ? 'WRITE BOTH CARDS FIRST' : 'LOAD BOTH TAPES FIRST'}
                </span>
              )}
            </>
          ) : (
            <span className="osd-text lobby-actions-note" style={{ color: 'var(--neon-cyan)' }}>
              ⏳ WAITING FOR HOST TO ROLL TAPE…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
