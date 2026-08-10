// src/server/gameState.ts
// In-memory store for all active rooms.
//
// Phase model follows docs/BUILD-PLAN.md sections 6-8:
//   lobby -> playing -> words -> deliberation -> results
//
//   playing      video plays; each player gets a Ready button when their own
//                video ends (section 6 Ready Check)
//   words        randomized turn order, 10s each, one word per player (7)
//   deliberation ONE 90s window with chat and voting live simultaneously (8)
//   results      roles revealed, coins awarded (9)

import type {
  DrawStroke,
  EquippedCosmetics,
  GameResults,
  GameWord,
  VoteVisibility,
} from '../types';
// Client-safe metadata only — the drawing *pool* lives in server/drawLibrary.
import { isDrawStyle, supportsCustomContent } from '../lib/videoCategories';

export type PlayerStatus = 'connected' | 'disconnected';

export interface Player {
  /**
   * Durable player id — the browser's `imposter_player_id`, not the socket.
   *
   * Every other structure that names a player (votes, turnOrder, imposterIds,
   * accusedIds, wordsUsed…) holds this, so a reconnect that swaps `socketId`
   * leaves the whole round intact. See src/lib/playerId.ts.
   */
  id: string;
  /** Current transport. Empty while disconnected; changes on every reconnect. */
  socketId: string;
  userId: string | null; // DB user id (null for guests)
  name: string;
  avatar: string;
  /**
   * Equipped cosmetics (section 10). Broadcast to the whole room — a skin
   * nobody else can see is not a cosmetic. Carries no role information, so
   * it is safe alongside the secrecy invariant.
   */
  cosmetics: EquippedCosmetics;
  isHost: boolean;
  isReady: boolean;    // true when their video is loaded & ready to play
  /**
   * Sitting this round out (section 4). Set on whoever supplied the Custom
   * genre's links: they already know both answers, so they get no video, no
   * turn, no vote and no reward. Cleared between rounds — it follows the
   * tapes, not the person.
   */
  isSpectator: boolean;
  status: PlayerStatus;
  /**
   * A simulated player (src/server/bots.ts) — a testing aid, never a real
   * participant. Broadcast, unlike the runtime below it: a lobby must be
   * honest about which of its nine players are furniture, or the feature is
   * indistinguishable from padding a room with fake humans.
   */
  isBot?: boolean;
  /**
   * Bot scheduling state. Server-only and present only on bots; dies with the
   * room, so it needs no cleanup pass of its own.
   */
  bot?: import('./bots').BotRuntime;
  /**
   * When this player last got a reaction through (§5), for the send throttle.
   * Server-only — `sanitizeRoom()` picks its fields explicitly, so this never
   * reaches a client, and nothing outside the throttle should read it.
   * Optional so the reconnect and rejoin paths that rebuild a Player don't
   * have to carry a value that means nothing between rounds.
   */
  lastReactionAt?: number;
}

export type GamePhase =
  | 'lobby'
  | 'playing'
  | 'words'
  | 'drawing'
  | 'clue'
  | 'guessing'
  | 'writing'
  | 'bluffvote'
  | 'deliberation'
  | 'results';

export interface RoomSettings {
  isPublic: boolean;
  /**
   * Run the round on content the host supplied rather than on the mode's pool.
   *
   * This is what Custom is now: a switch on whatever mode is selected, not a
   * mode of its own. On a video mode it means the two URLs below; on a prompt
   * mode it means the two cards below. `supportsCustomContent()` says which
   * modes accept it at all — the switch is ignored on the other three, which
   * have nothing pair-shaped to type.
   */
  useCustomContent: boolean;
  normalVideoUrl: string;
  imposterVideoUrl: string;
  /**
   * The host's own word/question pair, when custom content is on for a prompt
   * mode. Under exactly the rule the URLs are under: `sanitizeRoom()` carries
   * only booleans for these, and the text itself reaches a player only through
   * `assignmentFor()`. A crew member who could read the suspect's card in a
   * room broadcast is the whole game given away.
   */
  customNormalPrompt: string;
  customImposterPrompt: string;
  maxPlayers: number;
  wordsPerPlayer: number;   // words each player gets in the word phase
  imposterCount: number;    // pinned to 1 in Phase 1 (section 16)
  // 'none' is for groups already talking on Discord/FaceTime — the app shows
  // no chat UI at all beyond turn indicators (section 4).
  chatType: 'text' | 'voice' | 'video' | 'none';
  /**
   * Public shows the live ballot to everyone; anonymous withholds it until
   * the final tally at results (sections 4 and 8). Applies per vote round, so
   * a 2-imposter game honours it twice.
   */
  voteVisibility: VoteVisibility;
  videoCategory: string | null;
  /**
   * Fake Artist: does the fake get a category hint alongside "you are the
   * fake"? Off means drawing blind off other people's strokes, which is much
   * harder and much funnier. Lobby-phase only, like every other setting.
   */
  themeHint: boolean;
}

export interface RoomState {
  code: string;
  hostId: string;       // socket.id of host
  phase: GamePhase;
  players: Player[];
  imposterId: string | null;      // primary imposter (backwards compat)
  imposterIds: string[];          // all imposters
  settings: RoomSettings;

  /**
   * The round's word or question pair, on a `word`/`question` mode. Server-only
   * and under exactly the rule the video URLs are under: `sanitizeRoom()` never
   * carries it, and each half reaches only the players it belongs to, through
   * the per-socket `game:assigned`. Both halves become public in `game:results`
   * and not one moment earlier — seeing the other card is seeing the answer.
   *
   * Null on a video round.
   */
  prompts: { normal: string; imposter: string } | null;

  /**
   * The Fake Artist word and its category hint. Server-only for the same
   * reason as `prompts` — `sanitizeRoom()` builds field by field and never
   * carries it, and `assignmentFor()` is the only way either half leaves.
   *
   * Null on every other mode.
   */
  drawWord: { word: string; theme: string } | null;

  // ── Wavelength ──
  // The spectrum is public and rides sanitizeRoom; the target and the psychic
  // are not. Splitting them is the whole secrecy surface of the mode: everyone
  // must see the scale they are guessing on, and exactly one player may see
  // where on it the answer sits.
  spectrum: { left: string; right: string } | null;
  /** 0-100. Server-only until the reveal. */
  spectrumTarget: number | null;
  /** The one player dealt the target. Server-only — naming them names the
   *  only player whose guess is not a guess. */
  psychicId: string | null;
  /** Public the moment it is submitted; that is the point of it. */
  psychicClue: string | null;
  /** playerId -> 0-100. Withheld until every guess is in, so nobody can
   *  anchor on somebody else's dial. */
  guesses: Record<string, number>;

  // ── Bluff Definitions ──
  // The word is public from the start of the writing phase; the true
  // definition is not, and only becomes visible sitting anonymously in the
  // ballot beside the fakes.
  bluffWord: { word: string; definition: string } | null;
  /** playerId -> their fake definition. Never broadcast with authors attached
   *  until results — that mapping IS the game. */
  definitions: Record<string, string>;
  /** The ballot order, fixed once so every client sees the same list. */
  bluffOrder: string[];
  /** voterId -> option id (a playerId, or REAL_DEFINITION_ID). */
  bluffVotes: Record<string, string>;
  /**
   * Every stroke on the shared canvas, in order.
   *
   * Unlike `words` this is not only for reconnects — it *is* the board. Each
   * client accumulates strokes as they arrive, and a late or returning player
   * gets the whole array replayed so they see the same picture as everyone
   * else. Carries no role information: crew and fake emit an identical shape.
   */
  strokes: DrawStroke[];

  // ── Ready check, section 6 ──
  videoEnded: Record<string, boolean>;      // playerId -> their video finished
  readyToAdvance: Record<string, boolean>;  // playerId -> clicked Ready
  imposterVideoEndedAt: number | null;      // epoch ms, starts the 10s grace
  /**
   * The wall-clock moment the tapes were told to roll, or null before the
   * lobby was all loaded. A player who reconnects mid-video is played in
   * immediately off this rather than waiting for a start that already fired.
   */
  playAt: number | null;

  // ── 2-imposter structure, section 3 ──
  // A 2-imposter game runs two full word+vote rounds. The player accused in
  // round 1 is removed from active play for round 2 — but their role is NOT
  // revealed until results, which is the whole point of splitting the vote.
  gameRound: number;                        // 1, or 2 in a 2-imposter game
  accusedIds: string[];                     // accused so far, in vote order

  // ── Word phase, section 7 ──
  wordsUsed: Record<string, number>;        // playerId -> words submitted
  turnOrder: string[];                      // randomized player ids
  turnIndex: number;
  activePlayerId: string | null;
  turnTimeLeft: number;                     // seconds left on the current turn
  /**
   * Every word said this round, in order. Kept server-side purely so a player
   * who reconnects gets the evidence back — the words are what deliberation
   * argues over, and a blank board is worse than not returning at all.
   */
  words: GameWord[];

  // ── Deliberation, section 8 ──
  votes: Record<string, string>;            // voter playerId -> target playerId
  deliberationEndsAt: number | null;        // epoch ms the 90s window closes
  voteRound: number;                        // 1, then 2+ for tie re-votes
  revoteCandidates: string[] | null;        // non-null while a tie is unresolved

  /**
   * Who last supplied the custom content — the two URLs, or the two prompt
   * cards. They sit the round out (section 4), because they have seen both
   * halves and so already know which one is the odd one out. Tracked rather
   * than assumed to be the host: the host can be handed on after the content
   * goes in, and it is the person who typed it who knows.
   */
  customContentAuthorId: string | null;

  /**
   * Roster snapshot taken when a finished lobby is re-formed. A round ending
   * puts everyone out of the lobby; this is what lets someone who clicks
   * Rejoin come back as themselves rather than as a fresh player, without the
   * server having to take their identity on the client's word.
   */
  pastPlayers: Player[];

  /**
   * The `game:results` payload as broadcast, kept so a player who refreshes on
   * the results screen gets the same reveal back instead of an empty room.
   * Cleared when the lobby re-forms.
   */
  lastResults: GameResults | null;

  // ── No-repeat on replay, section 14 ──
  // YouTube IDs already shown in this lobby session. Survives resetRound so a
  // Replay pulls fresh clips; dies with the room, which is the session.
  usedVideoIds: string[];

  createdAt: number;
  gameStartedAt: number | null;
}

// In-memory room store
const rooms = new Map<string, RoomState>();

/** Fields reset between rounds and on every fresh game start. */
function freshRoundState() {
  return {
    // Cleared with the rest of the round: a lobby that switches from Words to
    // Sports must not carry last round's card into the reveal.
    prompts: null as { normal: string; imposter: string } | null,
    drawWord: null as { word: string; theme: string } | null,
    strokes: [] as DrawStroke[],
    spectrum: null as { left: string; right: string } | null,
    spectrumTarget: null as number | null,
    psychicId: null as string | null,
    psychicClue: null as string | null,
    guesses: {} as Record<string, number>,
    bluffWord: null as { word: string; definition: string } | null,
    definitions: {} as Record<string, string>,
    bluffOrder: [] as string[],
    bluffVotes: {} as Record<string, string>,
    videoEnded: {} as Record<string, boolean>,
    readyToAdvance: {} as Record<string, boolean>,
    imposterVideoEndedAt: null,
    playAt: null,
    gameRound: 1,
    accusedIds: [] as string[],
    wordsUsed: {} as Record<string, number>,
    words: [] as GameWord[],
    turnOrder: [] as string[],
    turnIndex: -1,
    activePlayerId: null,
    turnTimeLeft: 0,
    votes: {} as Record<string, string>,
    deliberationEndsAt: null,
    voteRound: 0,
    revoteCandidates: null,
  };
}

export function createRoom(code: string, host: Player, settings: RoomSettings): RoomState {
  const room: RoomState = {
    code,
    hostId: host.id,
    phase: 'lobby',
    players: [host],
    imposterId: null,
    imposterIds: [],
    settings,
    ...freshRoundState(),
    customContentAuthorId: null,
    pastPlayers: [],
    lastResults: null,
    usedVideoIds: [],
    createdAt: Date.now(),
    gameStartedAt: null,
  };
  rooms.set(code, room);
  return room;
}

export function resetRound(room: RoomState): void {
  Object.assign(room, freshRoundState());
}

export function getRoom(code: string): RoomState | undefined {
  return rooms.get(code);
}

export function deleteRoom(code: string): void {
  rooms.delete(code);
}

/**
 * The lobby this person currently hosts, if any. One open lobby per host is
 * the rule; this is what finds the one already open.
 *
 * Keyed on who is *currently* host rather than on who created the room. That
 * means handing the lobby on frees you to open another, and there is no
 * creator field to keep in step with `room:transferHost`. A signed-in host
 * matches on their account; a guest, who has none, matches on the durable
 * browser id from src/lib/playerId.ts — without that, guest mode would be an
 * unlimited lobby-spawner.
 *
 * The userId check is guarded on userId being set, or every guest-hosted room
 * (userId null) would match every other guest.
 */
export function findRoomHostedBy(
  userId: string | null,
  playerId: string
): RoomState | undefined {
  for (const room of rooms.values()) {
    const host = room.players.find((p) => p.id === room.hostId);
    if (!host) continue;
    if (userId && host.userId === userId) return room;
    if (host.id === playerId) return room;
  }
  return undefined;
}

export function getPublicRooms(): RoomState[] {
  return Array.from(rooms.values()).filter(
    // A lobby whose players are all inside their reconnect window is not a
    // lobby anyone should be shown — it either comes back or gets reaped.
    (r) =>
      r.settings.isPublic &&
      r.phase === 'lobby' &&
      r.players.some((p) => p.status === 'connected')
  );
}

/**
 * Drops any player row this socket already holds in the room under a *different*
 * id. Returns the ids that went.
 *
 * One connection is one player, and the room has to hold to that. Two rows on a
 * single socket means only one of them can ever act — every handler resolves the
 * actor through `socket.data.playerId`, which names exactly one — so the other
 * sits there `connected`, never ready, never voting, and every phase that waits
 * on all players waits forever. The observed symptom is a lobby showing three
 * players and reporting two.
 *
 * That is what a join with no durable id produced: `durableId()` fell back to
 * `socket.id`, and the room page then joined again on the same socket under the
 * real localStorage id. The client side is fixed, but the invariant belongs here
 * — this is the only place that can actually guarantee it.
 *
 * The stale row is dropped rather than re-keyed. Re-keying would have to rewrite
 * every id-keyed structure on RoomState (`votes`, `turnOrder`, `imposterIds`,
 * `accusedIds`, `readyToAdvance`, `wordsUsed`…) and a partial rewrite is a silent
 * corruption; the caller adds the replacement row immediately after.
 */
export function dropStaleSocketRows(
  room: RoomState,
  socketId: string,
  keepId: string
): string[] {
  // Bots carry socketId '' (they have no socket), so an empty id would match
  // every one of them at once.
  if (!socketId) return [];
  const stale = room.players.filter((p) => p.socketId === socketId && p.id !== keepId);
  if (stale.length === 0) return [];

  const staleIds = stale.map((p) => p.id);
  room.players = room.players.filter((p) => !staleIds.includes(p.id));

  // A phantom can be handed the lobby by `finalizeDrop`'s heir search, and a
  // hostId pointing at a row that no longer exists is a lobby nobody can start.
  if (staleIds.includes(room.hostId)) {
    const heir = room.players.find((p) => p.status === 'connected' && !p.isBot);
    // Falling back to keepId is the honest answer: the stale row was this same
    // person, and the caller is about to seat them.
    room.hostId = heir ? heir.id : keepId;
  }
  return staleIds;
}

export function addPlayer(code: string, player: Player): RoomState | null {
  const room = rooms.get(code);
  if (!room) return null;
  if (room.players.find((p) => p.id === player.id)) return room;
  room.players.push(player);
  return room;
}

/** Everyone who is not a simulated player. */
export function humanPlayers(room: RoomState): Player[] {
  return room.players.filter((p) => !p.isBot);
}

/**
 * Drops every bot from a lobby. Returns how many went.
 *
 * Lobby phase only at the call sites — pulling simulated players out of a
 * running round would leave their ids in `turnOrder`, `votes` and possibly
 * `imposterIds`, which is the same mess `finalizeDrop` exists to clean up
 * and is not worth reproducing for a testing aid.
 */
export function removeBots(room: RoomState): number {
  const before = room.players.length;
  room.players = room.players.filter((p) => !p.isBot);
  return before - room.players.length;
}

export function removePlayer(code: string, playerId: string): RoomState | null {
  const room = rooms.get(code);
  if (!room) return null;
  room.players = room.players.filter((p) => p.id !== playerId);
  // A room whose last human has gone is over, even though bots never
  // disconnect and would otherwise hold it open forever — `players.length`
  // alone would never reach zero and the lobby would sit in the public list
  // being permanently unjoinable-but-listed.
  if (room.players.length > 0 && humanPlayers(room).length === 0) {
    room.players = [];
  }
  if (room.players.length === 0) {
    rooms.delete(code);
    return null;
  }
  // Host left — hand the lobby to someone who is still on the line.
  if (room.hostId === playerId) {
    const heir = room.players.find((p) => p.status === 'connected') ?? room.players[0];
    setHost(room, heir.id);
  }
  return room;
}

// ─── Reconnect ───────────────────────────────────────────────────────────────
//
// A dropped socket no longer removes the player. They are marked
// `disconnected`, which takes them out of `activePlayers()` — so no phase
// waits on them — while everything that names them by id (their vote, their
// slot in the turn order, their role) stays exactly where it was. The caller
// arms a grace timer; if the same player id comes back before it fires,
// `reattachPlayer` puts them straight back into the round they left.

/** Flags a player as off the line. Returns them, or null if unknown here. */
export function markDisconnected(room: RoomState, playerId: string): Player | null {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return null;
  player.status = 'disconnected';
  player.socketId = '';
  return player;
}

/** Points a known player at their new socket. Returns them, or null. */
export function reattachPlayer(
  room: RoomState,
  playerId: string,
  socketId: string
): Player | null {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return null;
  player.socketId = socketId;
  player.status = 'connected';
  return player;
}

/** Makes `targetId` the only host. Callers validate who is allowed to ask. */
function setHost(room: RoomState, targetId: string): void {
  room.hostId = targetId;
  room.players.forEach((p) => (p.isHost = p.id === targetId));
}

export type HostTransferRejection =
  | 'not_host'
  | 'no_such_player'
  | 'offline'
  | 'already_host'
  | 'is_bot';

/**
 * Manual host transfer (section 4): the host can hand the role to any other
 * player at any time, so a host who has to leave doesn't end the lobby.
 */
export function transferHost(
  room: RoomState,
  requesterId: string,
  targetId: string
): { ok: true } | { ok: false; reason: HostTransferRejection } {
  if (room.hostId !== requesterId) return { ok: false, reason: 'not_host' };
  if (targetId === room.hostId) return { ok: false, reason: 'already_host' };
  const target = room.players.find((p) => p.id === targetId);
  if (!target) return { ok: false, reason: 'no_such_player' };
  if (target.status !== 'connected') return { ok: false, reason: 'offline' };
  // A simulated player reports as connected but has no socket and never
  // acts on its own behalf, so handing it the lobby leaves a room nobody
  // can start and nobody can take back.
  if (target.isBot) return { ok: false, reason: 'is_bot' };
  setHost(room, targetId);
  return { ok: true };
}

/**
 * The room and player a live socket belongs to. Only the disconnect handler
 * needs this — everything else knows the player id from `socket.data`.
 */
export function findRoomBySocket(
  socketId: string
): { room: RoomState; player: Player } | undefined {
  for (const room of rooms.values()) {
    const player = room.players.find((p) => p.socketId === socketId);
    if (player) return { room, player };
  }
  return undefined;
}

export function setPlayerReady(code: string, playerId: string): RoomState | null {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.find((p) => p.id === playerId);
  if (player) player.isReady = true;
  return room;
}

/**
 * Everyone who will actually load a tape has loaded it.
 *
 * Measured against `activePlayers` rather than the whole roster: the Custom
 * genre's author is never sent a video (section 4) and someone inside their
 * reconnect window has no player running, so counting either would hold the
 * entire lobby at the insertion screen until the grace timer bailed it out.
 */
export function allPlayersReady(room: RoomState): boolean {
  const loading = activePlayers(room);
  return loading.length > 0 && loading.every((p) => p.isReady);
}

export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  // Ensure uniqueness
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

// ─── Ready check (section 6) ─────────────────────────────────────────────────

/** Marks a player's video as finished. Returns true if that was the imposter. */
export function markVideoEnded(room: RoomState, playerId: string): boolean {
  room.videoEnded[playerId] = true;
  const isImposter = room.imposterIds.includes(playerId);
  if (isImposter && room.imposterVideoEndedAt === null) {
    room.imposterVideoEndedAt = Date.now();
  }
  return isImposter;
}

/**
 * Flags a player as ready to leave the video phase.
 *
 * Deliberately NOT gated on their own video having ended. Section 6 describes
 * the check as something that happens once your tape finishes, but a lobby
 * that has collectively seen enough shouldn't have to sit through the rest of
 * a five-minute clip — so Ready is live for the whole `playing` phase and a
 * unanimous lobby cuts the tape short. One impatient player still can't skip
 * anything: `allReadyToAdvance` needs every connected player.
 */
export function markReadyToAdvance(room: RoomState, playerId: string): void {
  room.readyToAdvance[playerId] = true;
}

export function connectedPlayers(room: RoomState): Player[] {
  return room.players.filter((p) => p.status === 'connected');
}

/**
 * Everyone still in the game: connected, not sitting out, not yet accused.
 * This is what drives the Ready Check, the turn order, the ballot and the
 * "everyone has voted" test — anyone missing from it is a spectator of some
 * kind and must not be able to hold a phase open.
 *
 * Two ways out of it. The Custom genre's author never plays at all
 * (section 4), and in a 2-imposter game the round-1 accused drops out for
 * round 2 (section 3) — they still see everything, they just can't act.
 */
export function activePlayers(room: RoomState): Player[] {
  return room.players.filter(
    (p) => p.status === 'connected' && !p.isSpectator && !room.accusedIds.includes(p.id)
  );
}

/**
 * Marks whoever supplied the custom content as sitting this round out, and
 * clears the flag for everyone else. Returns that player, or null when the
 * round is running off a pool or the author has left.
 */
export function assignSpectator(room: RoomState, isCustomRound: boolean): Player | null {
  let sitter: Player | null = null;
  if (isCustomRound && room.customContentAuthorId) {
    sitter = room.players.find((p) => p.id === room.customContentAuthorId) ?? null;
  }
  room.players.forEach((p) => (p.isSpectator = p.id === sitter?.id));
  return sitter;
}

/**
 * Is this round running on the host's own content rather than on a pool?
 *
 * The single answer to that question, because four places need it and they must
 * agree: the start check (which needs a spare head, since the author sits out),
 * the bot-fill default (same reason), the deal (skip the pool, use what was
 * typed) and the spectator assignment.
 *
 * The switch alone is not enough — it stays on when the host flips to Fake
 * Artist, and a mode with nothing pair-shaped to type must not end up with a
 * player sitting out for content that was never used.
 */
export function usesCustomContent(room: RoomState): boolean {
  return room.settings.useCustomContent && supportsCustomContent(room.settings.videoCategory);
}

/** 2 for a 2-imposter game, 1 otherwise (section 3). */
export function totalGameRounds(room: RoomState): number {
  return room.settings.imposterCount >= 2 ? 2 : 1;
}

export function allReadyToAdvance(room: RoomState): boolean {
  // Spectators get no video, so they can never report ready — counting them
  // would hold the phase open until the grace timer fired.
  const active = activePlayers(room);
  return active.length > 0 && active.every((p) => room.readyToAdvance[p.id]);
}

// ─── Word phase (section 7) ──────────────────────────────────────────────────

/** Fisher-Yates. `sort(() => Math.random() - 0.5)` is not a uniform shuffle. */
function shuffle<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Opens a turn-taking phase — the word round, or Fake Artist's drawing round.
 *
 * One engine for both, deliberately. The two phases differ only in what a turn
 * *produces* (a word, a stroke) and how long it lasts; the ordering, the skip
 * over absent players, the exhaustion check and the hand-off to deliberation
 * are identical, and a second copy would be a second place for the 2-imposter
 * round-2 path and the reconnect path to drift out of step.
 *
 * `wordsUsed` and `settings.wordsPerPlayer` therefore count strokes on a
 * drawing round. The names are left alone for the same reason
 * `settings.videoCategory` still holds mode ids: renaming them ripples through
 * RoomState, RoomPublic, two socket events and both screens for no behavioural
 * gain.
 */
function beginTurnPhase(room: RoomState, phase: 'words' | 'drawing'): void {
  room.phase = phase;
  room.wordsUsed = {};
  // Turn order is randomized each round and visible to all players (section 7).
  // The round-1 accused is not in it (section 3).
  room.turnOrder = shuffle(activePlayers(room).map((p) => p.id));
  room.turnIndex = 0;
  room.activePlayerId = room.turnOrder[0] ?? null;
  room.turnTimeLeft = turnSeconds(room);
}

export function beginWordPhase(room: RoomState): void {
  beginTurnPhase(room, 'words');
}

export function beginDrawPhase(room: RoomState): void {
  room.strokes = [];
  beginTurnPhase(room, 'drawing');
}

// ─── Wavelength ──────────────────────────────────────────────────────────────
//
// No turn order, no ballot, no hidden role to catch. The psychic writes one
// clue, everyone else dials a number, and the round scores by distance. It
// shares the lobby, the roster and the reward plumbing and nothing else — which
// is why `GameResults.kind` exists rather than an accusation being faked up.

export const CLUE_SECONDS = 60;
export const GUESS_SECONDS = 60;

/** Picks the psychic and opens the clue phase. */
export function beginCluePhase(room: RoomState, psychicId: string): void {
  room.phase = 'clue';
  room.psychicId = psychicId;
  room.psychicClue = null;
  room.guesses = {};
  room.activePlayerId = psychicId;
  room.turnTimeLeft = CLUE_SECONDS;
}

export function beginGuessPhase(room: RoomState, clue: string): void {
  room.phase = 'guessing';
  room.psychicClue = clue;
  room.activePlayerId = null;
  room.turnTimeLeft = GUESS_SECONDS;
}

export function recordGuess(room: RoomState, playerId: string, value: number): void {
  room.guesses[playerId] = Math.min(100, Math.max(0, Math.round(value)));
}

/** Everyone who owes a guess: active players minus the psychic. */
export function guessers(room: RoomState): Player[] {
  return activePlayers(room).filter((p) => p.id !== room.psychicId);
}

// ─── Bluff Definitions ───────────────────────────────────────────────────────

export const WRITING_SECONDS = 90;
export const BLUFF_VOTE_SECONDS = 75;

export function beginWritingPhase(room: RoomState): void {
  room.phase = 'writing';
  room.definitions = {};
  room.bluffVotes = {};
  room.bluffOrder = [];
  room.activePlayerId = null;
  room.turnTimeLeft = WRITING_SECONDS;
}

export function recordDefinition(room: RoomState, playerId: string, text: string): void {
  room.definitions[playerId] = text;
}

export function allDefinitionsIn(room: RoomState): boolean {
  const owed = activePlayers(room);
  return owed.length > 0 && owed.every((p) => room.definitions[p.id] !== undefined);
}

/**
 * Freezes the ballot order and opens the vote.
 *
 * The order is shuffled once and stored rather than sorted per client: the
 * true definition must not sit in a predictable slot, and two clients showing
 * different orders would make "the third one" unsayable in chat.
 */
export function beginBluffVote(room: RoomState, realId: string): void {
  room.phase = 'bluffvote';
  room.bluffOrder = shuffle([...Object.keys(room.definitions), realId]);
  room.bluffVotes = {};
  room.turnTimeLeft = BLUFF_VOTE_SECONDS;
}

/** Refuses a vote for your own fake — you already know it is not the answer. */
export function castBluffVote(room: RoomState, voterId: string, optionId: string): boolean {
  if (room.phase !== 'bluffvote') return false;
  if (optionId === voterId) return false;
  if (!room.bluffOrder.includes(optionId)) return false;
  if (!activePlayers(room).some((p) => p.id === voterId)) return false;
  room.bluffVotes[voterId] = optionId;
  return true;
}

export function allBluffVotesIn(room: RoomState): boolean {
  const owed = activePlayers(room);
  return owed.length > 0 && owed.every((p) => room.bluffVotes[p.id] !== undefined);
}

export function allGuessesIn(room: RoomState): boolean {
  const owed = guessers(room);
  return owed.length > 0 && owed.every((p) => room.guesses[p.id] !== undefined);
}

/**
 * Opens word round 2 of a 2-imposter game (section 3): the round-1 accused is
 * removed from active play and everyone else says one more word. Roles and the
 * videos stay put — there is no second Ready Check, and crucially no reveal.
 */
export function beginNextGameRound(room: RoomState, accusedId: string | null): void {
  if (accusedId) room.accusedIds.push(accusedId);
  room.gameRound++;
  room.votes = {};
  room.voteRound = 0;
  room.revoteCandidates = null;
  room.deliberationEndsAt = null;
  beginWordPhase(room);
}

// ─── Rejoin after a round ────────────────────────────────────────────────────

/**
 * Rebuilds a finished room as a fresh lobby containing only `keeperId`.
 *
 * Results ends the lobby: everyone is out, and the first person to click
 * Rejoin re-forms it around themselves. Settings and the no-repeat history
 * carry over — it is the same lobby, not a new one — while roles, votes and
 * words are cleared. Everyone else moves to `pastPlayers` and comes back if
 * and when they click Rejoin too. Returns the players who were dropped so the
 * caller can take their sockets out of the broadcast room.
 */
export function reformLobby(room: RoomState, keeperId: string): Player[] {
  const dropped = room.players.filter((p) => p.id !== keeperId);
  // Simulated players are discarded rather than parked. `pastPlayers` exists
  // so a real player can click Rejoin and be restored from it; a bot has no
  // socket and can never click anything, so parking them would just leave
  // garbage in the room for as long as it lives. The host presses the button
  // again for the next round, which is right anyway — they may want a
  // different number of them.
  room.pastPlayers = dropped.filter((p) => !p.isBot);
  room.players = room.players.filter((p) => p.id === keeperId);
  resetRound(room);
  room.phase = 'lobby';
  room.imposterId = null;
  room.imposterIds = [];
  room.lastResults = null;
  room.gameStartedAt = null;
  room.players.forEach((p) => {
    p.isReady = false;
    p.isSpectator = false;
  });
  // Whoever gets back first runs the lobby — the old host may never return.
  if (room.players.length > 0) setHost(room, keeperId);
  return dropped;
}

/** Puts a player from `pastPlayers` back into a re-formed lobby. */
export function restorePlayer(
  room: RoomState,
  playerId: string,
  socketId: string
): Player | null {
  const past = room.pastPlayers.find((p) => p.id === playerId);
  if (!past) return null;
  room.pastPlayers = room.pastPlayers.filter((p) => p.id !== playerId);
  past.socketId = socketId;
  past.isHost = false;
  past.isReady = false;
  past.isSpectator = false;
  past.status = 'connected';
  room.players.push(past);
  return past;
}

/** Picks `count` imposters uniformly. They all share one video (section 3). */
export function pickImposters(room: RoomState, count: number): string[] {
  return shuffle(activePlayers(room).map((p) => p.id)).slice(0, Math.max(1, count));
}

/** True when this lobby withholds the live ballot (sections 4, 8). */
export function isAnonymousVote(room: RoomState): boolean {
  return room.settings.voteVisibility === 'anonymous';
}

export const TURN_SECONDS = 10;
/**
 * A drawing turn is longer than a typing turn. 10s is plenty to type one word
 * and not enough to place a considered stroke with a mouse — and unlike a word,
 * a rushed stroke is unreadable evidence for the rest of the round rather than
 * just a weak clue.
 */
export const DRAW_TURN_SECONDS = 20;
export const DELIBERATION_SECONDS = 90;

/** How long the current phase gives each player. */
export function turnSeconds(room: RoomState): number {
  return room.phase === 'drawing' ? DRAW_TURN_SECONDS : TURN_SECONDS;
}

/**
 * The window when there is no word phase to precede it.
 *
 * Turning text chat off skips the word round entirely (see `skipsWordPhase`),
 * which takes away both the evidence board and the minute or so the turns used
 * to buy. A lobby on voice has to do all of that talking inside the vote
 * window instead, so the window is longer. Not a setting: it is a consequence
 * of one, and a host who turned text off has already made the choice.
 */
export const DELIBERATION_SECONDS_NO_WORDS = 180;

/**
 * Text off means no typing at all — including the word phase, which is nothing
 * but typing. The round goes watch/read straight to the eject vote.
 *
 * This is the only reading of the 'none' comms mode that holds together: §4
 * describes it as "we're already on Discord", and a turn-based typing round in
 * a lobby that has deliberately turned typing off is a phase nobody can play.
 *
 * Fake Artist is exempt, and the distinction is *typing*, not turn-taking. A
 * drawing turn involves no keyboard, so a text-off lobby can play it exactly as
 * written — and skipping it would leave a round with no evidence at all to vote
 * on, which is not a shorter game but a broken one.
 */
export function skipsWordPhase(room: RoomState): boolean {
  return room.settings.chatType === 'none' && !isDrawStyle(room.settings.videoCategory);
}

/** How long this room's vote window runs, in seconds. */
export function deliberationSeconds(room: RoomState): number {
  return skipsWordPhase(room) ? DELIBERATION_SECONDS_NO_WORDS : DELIBERATION_SECONDS;
}

export function recordWord(room: RoomState, playerId: string, word: GameWord): void {
  room.wordsUsed[playerId] = (room.wordsUsed[playerId] || 0) + 1;
  room.words.push(word);
}

export function playerFinishedTurn(room: RoomState, playerId: string): boolean {
  return (room.wordsUsed[playerId] || 0) >= room.settings.wordsPerPlayer;
}

/**
 * Advances to the next player. Returns false when the phase is over.
 *
 * Skips anyone who has dropped out of active play since the order was drawn —
 * a player inside their reconnect window has no client to type into, so
 * landing on them would burn a full 10s turn on nobody.
 */
export function advanceTurn(room: RoomState): boolean {
  const playable = new Set(activePlayers(room).map((p) => p.id));
  do {
    room.turnIndex++;
  } while (
    room.turnIndex < room.turnOrder.length &&
    !playable.has(room.turnOrder[room.turnIndex])
  );

  if (room.turnIndex >= room.turnOrder.length) {
    room.activePlayerId = null;
    room.turnTimeLeft = 0;
    return false;
  }
  room.activePlayerId = room.turnOrder[room.turnIndex];
  room.turnTimeLeft = turnSeconds(room);
  return true;
}

/**
 * Records one stroke and counts it against the player's turn allowance.
 *
 * Shares `wordsUsed` with the word phase — see beginTurnPhase. The cap is
 * enforced here rather than at the handler so the bot path and the socket path
 * cannot disagree about when a player is out of turns.
 */
export function recordStroke(room: RoomState, playerId: string, stroke: DrawStroke): void {
  room.wordsUsed[playerId] = (room.wordsUsed[playerId] || 0) + 1;
  room.strokes.push(stroke);
}

// ─── Deliberation & voting (section 8) ───────────────────────────────────────

export function beginDeliberation(room: RoomState): void {
  room.phase = 'deliberation';
  // A no-op when the word phase ran to its end — advanceTurn already cleared
  // these. It matters on the text-off path, which reaches deliberation without
  // any turn ever being taken and must not leave a speaker standing.
  room.activePlayerId = null;
  room.turnTimeLeft = 0;
  room.votes = {};
  room.voteRound = 1;
  room.revoteCandidates = null;
  room.deliberationEndsAt = Date.now() + deliberationSeconds(room) * 1000;
}

export type VoteRejection = 'not_voting' | 'self' | 'already_voted' | 'not_a_candidate' | 'not_eligible';

export function castVote(
  room: RoomState,
  voterId: string,
  targetId: string
): { ok: true } | { ok: false; reason: VoteRejection } {
  if (room.phase !== 'deliberation') return { ok: false, reason: 'not_voting' };
  if (voterId === targetId) return { ok: false, reason: 'self' };
  if (room.votes[voterId]) return { ok: false, reason: 'already_voted' };
  // Anyone out of play neither votes nor stands: the round-1 accused in a
  // 2-imposter game (section 3), and the Custom author all round (section 4).
  const eligible = new Set(activePlayers(room).map((p) => p.id));
  if (!eligible.has(voterId)) return { ok: false, reason: 'not_eligible' };
  if (!eligible.has(targetId)) return { ok: false, reason: 'not_a_candidate' };

  // During a tie re-vote the ballot is restricted to the tied players, and
  // only the voters asked to recast may vote (section 8).
  if (room.revoteCandidates) {
    if (!room.revoteCandidates.includes(targetId)) {
      return { ok: false, reason: 'not_a_candidate' };
    }
  }

  room.votes[voterId] = targetId;
  return { ok: true };
}

export function getVoteTally(room: RoomState): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const targetId of Object.values(room.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }
  return tally;
}

/** Everyone still in the game who has not yet cast a vote this round. */
export function pendingVoters(room: RoomState): string[] {
  return activePlayers(room)
    .map((p) => p.id)
    .filter((id) => !room.votes[id]);
}

export type VoteOutcome =
  | { kind: 'accused'; accusedId: string | null }
  | { kind: 'revote'; candidates: string[]; eligibleVoters: string[] }
  /** Section 3: the deadlocked ballot named exactly the imposters. */
  | { kind: 'allImpostersCaught' };

/**
 * Resolves the current ballot per section 8.
 *
 * Single leader -> accused. On a tie, players who backed neither tied
 * candidate become the swing voters and recast, restricted to those
 * candidates; players already behind a tied candidate keep their vote. If
 * there are no swing voters the whole ballot re-runs among the tied players
 * and loops until somebody switches — the round cannot conclude on a tie.
 *
 * The one exception is the 2-imposter rule in section 3: a deadlock with no
 * swing voters, between exactly the imposters, means the group collectively
 * pinned precisely the right people. That resolves in the crew's favour
 * instead of looping. A tie between an imposter and a crewmate gets no such
 * shortcut and loops like any other.
 */
export function resolveVote(room: RoomState): VoteOutcome {
  const tally = getVoteTally(room);
  const counts = Object.values(tally);

  // Nobody voted at all (e.g. the timer expired on an idle room): no
  // accusation, which means the imposter escapes.
  if (counts.length === 0) return { kind: 'accused', accusedId: null };

  const maxVotes = Math.max(...counts);
  const topIds = Object.keys(tally).filter((id) => tally[id] === maxVotes);

  if (topIds.length === 1) {
    return { kind: 'accused', accusedId: topIds[0] };
  }

  const stillPlaying = new Set(activePlayers(room).map((p) => p.id));
  const swingVoters = Object.entries(room.votes)
    .filter(([, target]) => !topIds.includes(target))
    .map(([voterId]) => voterId)
    .filter((id) => stillPlaying.has(id));

  if (
    swingVoters.length === 0 &&
    topIds.length === room.imposterIds.length &&
    topIds.every((id) => room.imposterIds.includes(id))
  ) {
    return { kind: 'allImpostersCaught' };
  }

  // A deadlock the electorate physically cannot break: the only two players
  // left in the game are the two tied candidates, and nobody may vote for
  // themselves — so every re-vote produces the same 1-1 forever. Looping here
  // would leave the room running its deliberation timer with no way out, so
  // the round ends with no accusation. Reachable whenever a lobby shrinks to
  // two active players, which since reconnect landed includes two people
  // simply losing signal. Larger deadlocks are left to loop: with three or
  // more voters somebody can always switch and break it.
  if (
    swingVoters.length === 0 &&
    topIds.length === 2 &&
    stillPlaying.size === 2 &&
    topIds.every((id) => stillPlaying.has(id))
  ) {
    return { kind: 'accused', accusedId: null };
  }

  const eligibleVoters =
    swingVoters.length > 0 ? swingVoters : [...stillPlaying];

  return { kind: 'revote', candidates: topIds, eligibleVoters };
}

/** Clears the ballots that need recasting and opens the next re-vote round. */
export function beginRevote(room: RoomState, outcome: Extract<VoteOutcome, { kind: 'revote' }>): void {
  for (const voterId of outcome.eligibleVoters) {
    delete room.votes[voterId];
  }
  room.voteRound++;
  room.revoteCandidates = outcome.candidates;
  // A re-vote gets its own fresh window so it cannot expire instantly.
  room.deliberationEndsAt = Date.now() + deliberationSeconds(room) * 1000;
}
