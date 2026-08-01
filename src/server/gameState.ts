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

export type PlayerStatus = 'connected' | 'disconnected';

export interface Player {
  id: string;          // socket.id
  userId: string | null; // DB user id (null for guests)
  name: string;
  avatar: string;
  isHost: boolean;
  isReady: boolean;    // true when their video is loaded & ready to play
  status: PlayerStatus;
}

export type GamePhase = 'lobby' | 'playing' | 'words' | 'deliberation' | 'results';

export interface RoomSettings {
  isPublic: boolean;
  normalVideoUrl: string;
  imposterVideoUrl: string;
  maxPlayers: number;
  wordsPerPlayer: number;   // words each player gets in the word phase
  imposterCount: number;    // pinned to 1 in Phase 1 (section 16)
  // 'none' is for groups already talking on Discord/FaceTime — the app shows
  // no chat UI at all beyond turn indicators (section 4).
  chatType: 'text' | 'voice' | 'video' | 'none';
  videoCategory: string | null;
}

export interface RoomState {
  code: string;
  hostId: string;       // socket.id of host
  phase: GamePhase;
  players: Player[];
  imposterId: string | null;      // primary imposter (backwards compat)
  imposterIds: string[];          // all imposters
  settings: RoomSettings;

  // ── Ready check, section 6 ──
  videoEnded: Record<string, boolean>;      // socketId -> their video finished
  readyToAdvance: Record<string, boolean>;  // socketId -> clicked Ready
  imposterVideoEndedAt: number | null;      // epoch ms, starts the 10s grace

  // ── 2-imposter structure, section 3 ──
  // A 2-imposter game runs two full word+vote rounds. The player accused in
  // round 1 is removed from active play for round 2 — but their role is NOT
  // revealed until results, which is the whole point of splitting the vote.
  gameRound: number;                        // 1, or 2 in a 2-imposter game
  accusedIds: string[];                     // accused so far, in vote order

  // ── Word phase, section 7 ──
  wordsUsed: Record<string, number>;        // socketId -> words submitted
  turnOrder: string[];                      // randomized player ids
  turnIndex: number;
  activePlayerId: string | null;
  turnTimeLeft: number;                     // seconds left on the current turn

  // ── Deliberation, section 8 ──
  votes: Record<string, string>;            // voter socketId -> target socketId
  deliberationEndsAt: number | null;        // epoch ms the 90s window closes
  voteRound: number;                        // 1, then 2+ for tie re-votes
  revoteCandidates: string[] | null;        // non-null while a tie is unresolved

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
    videoEnded: {} as Record<string, boolean>,
    readyToAdvance: {} as Record<string, boolean>,
    imposterVideoEndedAt: null,
    gameRound: 1,
    accusedIds: [] as string[],
    wordsUsed: {} as Record<string, number>,
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

export function getPublicRooms(): RoomState[] {
  return Array.from(rooms.values()).filter(
    (r) => r.settings.isPublic && r.phase === 'lobby'
  );
}

export function addPlayer(code: string, player: Player): RoomState | null {
  const room = rooms.get(code);
  if (!room) return null;
  if (room.players.find((p) => p.id === player.id)) return room;
  room.players.push(player);
  return room;
}

export function removePlayer(code: string, socketId: string): RoomState | null {
  const room = rooms.get(code);
  if (!room) return null;
  room.players = room.players.filter((p) => p.id !== socketId);
  if (room.players.length === 0) {
    rooms.delete(code);
    return null;
  }
  // Host left — hand the lobby to someone who is still on the line.
  if (room.hostId === socketId) {
    const heir = room.players.find((p) => p.status === 'connected') ?? room.players[0];
    setHost(room, heir.id);
  }
  return room;
}

/** Makes `targetId` the only host. Callers validate who is allowed to ask. */
function setHost(room: RoomState, targetId: string): void {
  room.hostId = targetId;
  room.players.forEach((p) => (p.isHost = p.id === targetId));
}

export type HostTransferRejection = 'not_host' | 'no_such_player' | 'offline' | 'already_host';

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
  setHost(room, targetId);
  return { ok: true };
}

export function getPlayerRoom(socketId: string): RoomState | undefined {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.id === socketId)) {
      return room;
    }
  }
  return undefined;
}

export function setPlayerReady(code: string, socketId: string): RoomState | null {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.find((p) => p.id === socketId);
  if (player) player.isReady = true;
  return room;
}

export function allPlayersReady(room: RoomState): boolean {
  return room.players.every((p) => p.isReady);
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
export function markVideoEnded(room: RoomState, socketId: string): boolean {
  room.videoEnded[socketId] = true;
  const isImposter = room.imposterIds.includes(socketId);
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
export function markReadyToAdvance(room: RoomState, socketId: string): void {
  room.readyToAdvance[socketId] = true;
}

export function connectedPlayers(room: RoomState): Player[] {
  return room.players.filter((p) => p.status === 'connected');
}

/**
 * Everyone still in the game: connected and not yet accused. In a 1-imposter
 * game this is the same as connectedPlayers, because nobody is ever removed
 * mid-game. In a 2-imposter game the round-1 accused drops out of the turn
 * order and the round-2 ballot (section 3) — they still see everything, they
 * just can't speak or vote.
 */
export function activePlayers(room: RoomState): Player[] {
  return room.players.filter(
    (p) => p.status === 'connected' && !room.accusedIds.includes(p.id)
  );
}

/** 2 for a 2-imposter game, 1 otherwise (section 3). */
export function totalGameRounds(room: RoomState): number {
  return room.settings.imposterCount >= 2 ? 2 : 1;
}

export function allReadyToAdvance(room: RoomState): boolean {
  const active = connectedPlayers(room);
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

export function beginWordPhase(room: RoomState): void {
  room.phase = 'words';
  room.wordsUsed = {};
  // Turn order is randomized each round and visible to all players (section 7).
  // The round-1 accused is not in it (section 3).
  room.turnOrder = shuffle(activePlayers(room).map((p) => p.id));
  room.turnIndex = 0;
  room.activePlayerId = room.turnOrder[0] ?? null;
  room.turnTimeLeft = TURN_SECONDS;
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

/** Picks `count` imposters uniformly. They all share one video (section 3). */
export function pickImposters(room: RoomState, count: number): string[] {
  return shuffle(room.players.map((p) => p.id)).slice(0, Math.max(1, count));
}

export const TURN_SECONDS = 10;
export const DELIBERATION_SECONDS = 90;

export function recordWord(room: RoomState, socketId: string): void {
  room.wordsUsed[socketId] = (room.wordsUsed[socketId] || 0) + 1;
}

export function playerFinishedTurn(room: RoomState, socketId: string): boolean {
  return (room.wordsUsed[socketId] || 0) >= room.settings.wordsPerPlayer;
}

/** Advances to the next player. Returns false when the phase is over. */
export function advanceTurn(room: RoomState): boolean {
  room.turnIndex++;
  if (room.turnIndex >= room.turnOrder.length) {
    room.activePlayerId = null;
    room.turnTimeLeft = 0;
    return false;
  }
  room.activePlayerId = room.turnOrder[room.turnIndex];
  room.turnTimeLeft = TURN_SECONDS;
  return true;
}

// ─── Deliberation & voting (section 8) ───────────────────────────────────────

export function beginDeliberation(room: RoomState): void {
  room.phase = 'deliberation';
  room.votes = {};
  room.voteRound = 1;
  room.revoteCandidates = null;
  room.deliberationEndsAt = Date.now() + DELIBERATION_SECONDS * 1000;
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
  // Section 3: the round-1 accused neither votes nor stands in round 2.
  if (room.accusedIds.includes(voterId)) return { ok: false, reason: 'not_eligible' };
  if (room.accusedIds.includes(targetId)) return { ok: false, reason: 'not_a_candidate' };

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
  room.deliberationEndsAt = Date.now() + DELIBERATION_SECONDS * 1000;
}
