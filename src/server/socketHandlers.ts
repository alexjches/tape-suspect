// src/server/socketHandlers.ts
// All Socket.io event handlers.
//
// Phase flow (docs/BUILD-PLAN.md sections 6-9):
//   lobby -> playing -> words -> deliberation -> results

import { Server, Socket } from 'socket.io';
import {
  createRoom,
  getRoom,
  getPublicRooms,
  addPlayer,
  removePlayer,
  reformLobby,
  restorePlayer,
  findRoomBySocket,
  markDisconnected,
  reattachPlayer,
  setPlayerReady,
  allPlayersReady,
  resetRound,
  generateRoomCode,
  markVideoEnded,
  markReadyToAdvance,
  allReadyToAdvance,
  activePlayers,
  connectedPlayers,
  isAnonymousVote,
  totalGameRounds,
  beginNextGameRound,
  pickImposters,
  assignSpectator,
  beginWordPhase,
  recordWord,
  playerFinishedTurn,
  advanceTurn,
  beginDeliberation,
  castVote,
  getVoteTally,
  pendingVoters,
  resolveVote,
  beginRevote,
  transferHost,
  DELIBERATION_SECONDS,
  HostTransferRejection,
  VoteOutcome,
  Player,
  RoomSettings,
  RoomState,
} from './gameState';
import { CUSTOM_CATEGORY, isKnownCategory } from '../lib/videoCategories';
import { sanitizeCosmetics } from '../lib/cosmetics';
import { pickVideoPair, watchUrl } from './videoLibrary';
import { verifySocketUser } from './socketAuth';
import { awardCoins } from './wallet';
import type { CoinReward, GameResults, GameWord } from '../types';

// ── Phase 1 rule constants (docs/BUILD-PLAN.md) ──────────────────────
// Lobby size 4–10 (section 20). Phase 1 ships a single imposter only
// (section 16) — 2-imposter lobbies unlock at 7+ players in Phase 2.
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;

// Section 6: the word phase starts once everyone is ready, or 10s after the
// imposter's video ends — whichever comes first — so one straggler cannot
// hold up the lobby.
const READY_GRACE_SECONDS = 10;

// Reward values are confirmed, not placeholders (section 9):
//   crew win 50+25=75 / crew lose 50 / imposter win 50+50=100 / imposter lose 50
const BASE_COINS = 50;
const CREW_WIN_BONUS = 25;
const IMPOSTER_WIN_BONUS = 50;

// A 2-imposter game pays on how many of the two were caught (section 3), not
// on a win/lose flip. Indexed by imposters caught: 0, 1, both.
const TWO_IMPOSTER_CREW_TOTALS = [50, 100, 150];
const TWO_IMPOSTER_SUSPECT_TOTALS = [150, 75, 50];

// Section 3: 2 imposters unlock at 7+ players, mirroring Among Us.
const TWO_IMPOSTER_MIN_PLAYERS = 7;

// How long a dropped player keeps their seat, their vote and their role before
// the room gives up on them. Long enough to cover a refresh, a tab restore or
// a lift ride; short enough that a lobby isn't held open by a ghost.
const DISCONNECT_GRACE_SECONDS = 60;

/**
 * The durable player id behind a socket, set on create/join.
 *
 * Falls back to `socket.id` so a client that never sent one still behaves
 * exactly as it did before reconnect existed — it just can't come back.
 */
function actorId(socket: Socket): string {
  return (socket.data?.playerId as string | undefined) || socket.id;
}

/**
 * The id a create/join should record for this socket. Client-supplied, so it
 * is length-capped like any other user input; an absent or junk value falls
 * back to `socket.id`, which is what the room used to key on anyway.
 */
function durableId(supplied: unknown, socket: Socket): string {
  if (typeof supplied !== 'string') return socket.id;
  const trimmed = supplied.trim().slice(0, 64);
  return trimmed || socket.id;
}

function sanitizeRoom(room: RoomState) {
  // Never send video URLs or roles to clients. URLs go out individually in
  // game:assigned; roles are revealed only in game:results (section 3).
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    // Safe to broadcast: who was accused in round 1, not what they were.
    gameRound: room.gameRound,
    totalRounds: totalGameRounds(room),
    accusedIds: room.accusedIds,
    // Not secret — it's whoever typed the Custom URLs, and the lobby needs to
    // say who will be sitting out before anyone hits start (section 4).
    customVideoAuthorId: room.customVideoAuthorId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isHost: p.isHost,
      isReady: p.isReady,
      isSpectator: p.isSpectator,
      status: p.status,
      cosmetics: p.cosmetics,
    })),
    settings: {
      isPublic: room.settings.isPublic,
      maxPlayers: room.settings.maxPlayers,
      // Deliberately exclude video URLs from broadcast
      hasNormalVideo: !!room.settings.normalVideoUrl,
      hasImposterVideo: !!room.settings.imposterVideoUrl,
      wordsPerPlayer: room.settings.wordsPerPlayer,
      imposterCount: room.settings.imposterCount,
      chatType: room.settings.chatType,
      voteVisibility: room.settings.voteVisibility,
      videoCategory: room.settings.videoCategory,
    },
    // Individual ballots. An anonymous lobby never publishes them — not
    // during the vote and not after it, since §4 promises only the final
    // tally is revealed, and this object is who-voted-for-whom.
    votes: isAnonymousVote(room) ? {} : room.votes,
    createdAt: room.createdAt,
  };
}

// One timer per room — phases are sequential so only one can be active.
const roomTimers = new Map<string, NodeJS.Timeout>();

function clearRoomTimer(code: string) {
  const existing = roomTimers.get(code);
  if (existing) {
    clearInterval(existing);
    roomTimers.delete(code);
  }
}

function setRoomTimer(code: string, fn: () => void, ms = 1000) {
  clearRoomTimer(code);
  roomTimers.set(code, setInterval(fn, ms));
}

// ─── Reconnect grace ─────────────────────────────────────────────────────────
//
// Separate from roomTimers on purpose: those are the one-per-room phase clocks
// and phases are sequential, whereas several players can be inside their grace
// window at once. Keyed `code:playerId`.

const dropTimers = new Map<string, NodeJS.Timeout>();

function dropKey(code: string, playerId: string) {
  return `${code}:${playerId}`;
}

function cancelDrop(code: string, playerId: string) {
  const key = dropKey(code, playerId);
  const existing = dropTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    dropTimers.delete(key);
  }
}

function clearRoomDrops(code: string) {
  for (const key of Array.from(dropTimers.keys())) {
    if (key.startsWith(`${code}:`)) {
      clearTimeout(dropTimers.get(key)!);
      dropTimers.delete(key);
    }
  }
}

// ─── Ready check (section 6) ─────────────────────────────────────────────────

function broadcastReadyState(room: RoomState, io: Server) {
  // Spectators have no tape to finish, so they are not part of the count.
  const active = activePlayers(room);
  io.to(room.code).emit('game:readyState', {
    videoEnded: room.videoEnded,
    readyToAdvance: room.readyToAdvance,
    ready: active.filter((p) => room.readyToAdvance[p.id]).length,
    total: active.length,
    graceEndsAt: room.imposterVideoEndedAt
      ? room.imposterVideoEndedAt + READY_GRACE_SECONDS * 1000
      : null,
  });
}

/** Starts the 10s countdown that begins once the imposter's video ends. */
function startReadyGrace(room: RoomState, io: Server) {
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== 'playing') {
      clearRoomTimer(room.code);
      return;
    }
    const deadline = (current.imposterVideoEndedAt ?? 0) + READY_GRACE_SECONDS * 1000;
    if (Date.now() >= deadline) {
      startWordPhase(current, io);
    }
  });
}

// ─── Word phase (section 7) ──────────────────────────────────────────────────

function startWordPhase(room: RoomState, io: Server) {
  clearRoomTimer(room.code);
  beginWordPhase(room);
  emitWordPhaseStart(room, io);
}

/**
 * Announces a word phase and starts its clock. Split out from startWordPhase
 * because round 2 of a 2-imposter game enters through beginNextGameRound,
 * which has already set the turn order up.
 */
function emitWordPhaseStart(room: RoomState, io: Server) {
  io.to(room.code).emit('game:wordPhaseStart', {
    ...sanitizeRoom(room),
    turnOrder: room.turnOrder,
    activePlayerId: room.activePlayerId,
    turnTimeLeft: room.turnTimeLeft,
    wordsPerPlayer: room.settings.wordsPerPlayer,
  });

  if (room.activePlayerId) startTurnTimer(room, io);
  else startDeliberation(room, io);
}

function startTurnTimer(room: RoomState, io: Server) {
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== 'words') {
      clearRoomTimer(room.code);
      return;
    }
    current.turnTimeLeft--;
    if (current.turnTimeLeft <= 0) {
      // Section 7: timing out auto-skips with a blank word.
      nextTurn(current, io);
    } else {
      broadcastTurnState(current, io);
    }
  });
}

function nextTurn(room: RoomState, io: Server) {
  const hasMore = advanceTurn(room);
  if (!hasMore) {
    startDeliberation(room, io);
    return;
  }
  broadcastTurnState(room, io);
  startTurnTimer(room, io);
}

function broadcastTurnState(room: RoomState, io: Server) {
  io.to(room.code).emit('game:turnState', {
    activePlayerId: room.activePlayerId,
    turnTimeLeft: room.turnTimeLeft,
    turnIndex: room.turnIndex,
    wordsUsed: room.wordsUsed,
  });
}

// ─── Deliberation (section 8) ────────────────────────────────────────────────

function startDeliberation(room: RoomState, io: Server) {
  clearRoomTimer(room.code);
  beginDeliberation(room);

  io.to(room.code).emit('game:deliberationStart', {
    ...sanitizeRoom(room),
    endsAt: room.deliberationEndsAt,
    durationSeconds: DELIBERATION_SECONDS,
    voteRound: room.voteRound,
    revoteCandidates: room.revoteCandidates,
  });

  startDeliberationTimer(room, io);
}

function startDeliberationTimer(room: RoomState, io: Server) {
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== 'deliberation') {
      clearRoomTimer(room.code);
      return;
    }
    const msLeft = (current.deliberationEndsAt ?? 0) - Date.now();
    if (msLeft <= 0) {
      // Section 8: the window closing resolves the ballot as it stands.
      concludeVote(current, io);
      return;
    }
    io.to(current.code).emit('game:deliberationTick', {
      secondsLeft: Math.ceil(msLeft / 1000),
    });
  });
}

/**
 * Resolves the ballot: a re-vote, the next game round, or results.
 *
 * In a 2-imposter game (section 3) the first accusation does not end the game
 * — it removes the accused from active play and opens word round 2. Nothing
 * about their role goes out with it.
 */
function concludeVote(room: RoomState, io: Server) {
  const outcome = resolveVote(room);

  if (outcome.kind === 'revote') {
    beginRevote(room, outcome);
    announceRevote(room, io, outcome);
    startDeliberationTimer(room, io);
    console.log(
      `[Vote] Tie in ${room.code} between ${outcome.candidates.join(', ')} — re-vote round ${room.voteRound}`
    );
    return;
  }

  // The deadlock named exactly the imposters: both count as caught.
  if (outcome.kind === 'allImpostersCaught') {
    console.log(`[Vote] ${room.code} deadlocked on both suspects — crew takes it`);
    finalizeResults(room, io, [...room.imposterIds]);
    return;
  }

  const accused = outcome.accusedId ? [outcome.accusedId] : [];

  if (room.gameRound < totalGameRounds(room)) {
    clearRoomTimer(room.code);
    beginNextGameRound(room, outcome.accusedId);
    // Too few left to run a meaningful second ballot — end it here rather than
    // opening a round nobody can win.
    if (activePlayers(room).length < 2) {
      finalizeResults(room, io, room.accusedIds);
      return;
    }
    console.log(
      `[Game] ${room.code} round ${room.gameRound}/${totalGameRounds(room)} — accused so far: ${room.accusedIds.join(', ') || 'nobody'}`
    );
    emitWordPhaseStart(room, io);
    return;
  }

  finalizeResults(room, io, [...room.accusedIds, ...accused]);
}

/**
 * The live vote state, as much of it as this lobby is allowed to see.
 *
 * Anonymous withholds the running count itself (§4) — the two progress
 * numbers still go out, because "3 of 5 have voted" reveals nothing about who
 * anyone picked and the phase is unreadable without a sense of how close it
 * is to closing.
 */
function tallyPayload(room: RoomState) {
  const anonymous = isAnonymousVote(room);
  return {
    tally: anonymous ? null : getVoteTally(room),
    // §4's "who's voting for whom", on the channel a vote actually pushes.
    ballots: anonymous ? null : { ...room.votes },
    votescast: Object.keys(room.votes).length,
    // An accused player is out of the ballot, so they don't count toward the
    // "everyone has voted" total either (section 3).
    totalVoters: activePlayers(room).length,
  };
}

function broadcastTally(room: RoomState, io: Server) {
  io.to(room.code).emit('vote:tally', tallyPayload(room));
}

/**
 * Announces a tie re-vote (section 8), honouring the visibility setting.
 *
 * Public broadcasts the whole thing. Anonymous cannot: being on
 * `eligibleVoters` means you backed *neither* tied candidate, which is a fact
 * about your ballot — publishing the roster would leak precisely what the
 * setting protects. So each player is told only whether they themselves may
 * recast, one emit per socket.
 */
function announceRevote(
  room: RoomState,
  io: Server,
  outcome: Extract<VoteOutcome, { kind: 'revote' }>
) {
  const base = {
    candidates: outcome.candidates,
    voteRound: room.voteRound,
    endsAt: room.deliberationEndsAt,
    durationSeconds: DELIBERATION_SECONDS,
  };

  if (!isAnonymousVote(room)) {
    io.to(room.code).emit('game:revote', {
      ...base,
      eligibleVoters: outcome.eligibleVoters,
      canRecast: null,
      tally: getVoteTally(room),
    });
    return;
  }

  const recasting = new Set(outcome.eligibleVoters);
  for (const player of room.players) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit('game:revote', {
      ...base,
      eligibleVoters: null,
      canRecast: recasting.has(player.id),
      tally: null,
    });
  }
}

// ─── Reconnect: losing a player, and getting them back ───────────────────────

/**
 * Arms the grace window for a player who has just dropped.
 *
 * Nothing about the round changes yet — their vote, their turn slot and their
 * role all stay put. Only when this fires are they actually removed, at which
 * point the room behaves as it always did when a socket went away.
 */
function scheduleDrop(code: string, playerId: string, io: Server) {
  cancelDrop(code, playerId);
  const timer = setTimeout(() => {
    dropTimers.delete(dropKey(code, playerId));
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find((p) => p.id === playerId);
    // They came back inside the window — nothing to do.
    if (!player || player.status === 'connected') return;
    finalizeDrop(room, playerId, io);
  }, DISCONNECT_GRACE_SECONDS * 1000);
  dropTimers.set(dropKey(code, playerId), timer);
}

/** The grace window expired: take the player out for good. */
function finalizeDrop(room: RoomState, playerId: string, io: Server) {
  const code = room.code;
  const turnIndex = room.turnOrder.indexOf(playerId);

  const updatedRoom = removePlayer(code, playerId);
  if (!updatedRoom) {
    // That was the last one — the room is gone, so nothing may keep ticking.
    clearRoomTimer(code);
    clearRoomDrops(code);
    io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
    console.log(`[Socket] ${playerId} gave up on ${code} (room closed)`);
    return;
  }

  if (turnIndex !== -1) {
    updatedRoom.turnOrder.splice(turnIndex, 1);
    if (turnIndex < updatedRoom.turnIndex) updatedRoom.turnIndex--;
  }
  delete updatedRoom.votes[playerId];

  io.to(code).emit('room:updated', sanitizeRoom(updatedRoom));
  if (updatedRoom.phase === 'words') broadcastTurnState(updatedRoom, io);
  io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
  console.log(`[Socket] ${playerId} did not return to ${code} — removed`);
}

/**
 * Replays the current phase to one returning socket.
 *
 * The client hooks are the same ones the live broadcasts drive, so a resume is
 * just those events fired at a single listener instead of the room. Secrecy
 * holds because this is per-socket: the video URL goes only to the player it
 * was already assigned to, and no role rides along (section 3).
 */
function sendCatchUp(room: RoomState, playerId: string, socket: Socket, io: Server) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return;

  if (room.phase === 'playing') {
    if (!player.isSpectator) {
      const isImposter = room.imposterIds.includes(playerId);
      socket.emit('game:assigned', {
        videoUrl: isImposter ? room.settings.imposterVideoUrl : room.settings.normalVideoUrl,
      });
    }
    broadcastReadyState(room, io);
    return;
  }

  if (room.phase === 'words' || room.phase === 'deliberation') {
    socket.emit('game:wordPhaseStart', {
      ...sanitizeRoom(room),
      turnOrder: room.turnOrder,
      activePlayerId: room.activePlayerId,
      turnTimeLeft: room.turnTimeLeft,
      wordsPerPlayer: room.settings.wordsPerPlayer,
    });
    // The words are the evidence, and wordPhaseStart clears the board.
    socket.emit('game:wordHistory', { words: room.words });
    socket.emit('game:turnState', {
      activePlayerId: room.activePlayerId,
      turnTimeLeft: room.turnTimeLeft,
      turnIndex: room.turnIndex,
      wordsUsed: room.wordsUsed,
    });
  }

  if (room.phase === 'deliberation') {
    socket.emit('game:deliberationStart', {
      ...sanitizeRoom(room),
      endsAt: room.deliberationEndsAt,
      durationSeconds: DELIBERATION_SECONDS,
      voteRound: room.voteRound,
      revoteCandidates: room.revoteCandidates,
    });
    if (room.revoteCandidates) {
      // Restricted ballot: who may still recast is exactly who has no vote
      // on record, since beginRevote cleared only those (section 8). Same
      // visibility rule as the live announcement — an anonymous lobby is told
      // only about itself.
      const stillToRecast = pendingVoters(room);
      const anonymous = isAnonymousVote(room);
      socket.emit('game:revote', {
        candidates: room.revoteCandidates,
        eligibleVoters: anonymous ? null : stillToRecast,
        canRecast: anonymous ? stillToRecast.includes(playerId) : null,
        voteRound: room.voteRound,
        endsAt: room.deliberationEndsAt,
        durationSeconds: DELIBERATION_SECONDS,
        tally: anonymous ? null : getVoteTally(room),
      });
    }
    socket.emit('vote:tally', tallyPayload(room));
  }

  if (room.phase === 'results' && room.lastResults) {
    socket.emit('game:results', room.lastResults);
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket: Socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // Resolve the signed-in account from the handshake cookie, not from
    // anything the client says. This is what round rewards are credited to,
    // so it has to be verified — see socketAuth.ts. Async, but create/join
    // are user-initiated and land long after the handshake; the fallback if
    // one somehow beats it is guest, which pays into no wallet at all.
    verifySocketUser(socket)
      .then((userId) => {
        socket.data.userId = userId;
      })
      .catch(() => {
        socket.data.userId = null;
      });

    // ─── Room: Create ───────────────────────────────────────────────
    socket.on(
      'room:create',
      (
        data: {
          playerName: string;
          avatar: string;
          /** Ignored — the account comes from the session cookie, see below. */
          userId: string | null;
          playerId?: string;
          cosmetics?: unknown;
          isPublic: boolean;
          normalVideoUrl?: string;
          imposterVideoUrl?: string;
          wordsPerPlayer?: number;
          maxPlayers?: number;
          chatType?: RoomSettings['chatType'];
          voteVisibility?: RoomSettings['voteVisibility'];
          videoCategory?: string | null;
        },
        callback: (res: { success: boolean; code?: string; error?: string }) => void
      ) => {
        const code = generateRoomCode();
        const playerId = durableId(data.playerId, socket);

        const host: Player = {
          id: playerId,
          socketId: socket.id,
          // Verified from the session cookie, never from data.userId — this
          // is what the round's coins get credited to.
          userId: (socket.data.userId as string | null) ?? null,
          name: data.playerName,
          avatar: data.avatar,
          cosmetics: sanitizeCosmetics(data.cosmetics),
          isHost: true,
          isReady: false,
          isSpectator: false,
          status: 'connected',
        };

        const settings: RoomSettings = {
          isPublic: data.isPublic,
          normalVideoUrl: data.normalVideoUrl || '',
          imposterVideoUrl: data.imposterVideoUrl || '',
          maxPlayers: Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, data.maxPlayers ?? MAX_PLAYERS)),
          wordsPerPlayer: data.wordsPerPlayer ?? 1,
          // Always starts at 1: a brand-new lobby has one player in it, and
          // 2 suspects only unlocks at 7 (section 3). The host raises it from
          // the lobby OSD once enough people have joined.
          imposterCount: 1,
          chatType: data.chatType ?? 'text',
          // Public by default — the live ballot is the livelier game, and a
          // host who wants the quieter one picks it deliberately (§4).
          voteVisibility: data.voteVisibility === 'anonymous' ? 'anonymous' : 'public',
          // An unrecognised genre falls back to null, which means "host supplies
          // the URLs" — never a silent pick from some other shelf.
          videoCategory: isKnownCategory(data.videoCategory) ? data.videoCategory! : null,
        };

        const room = createRoom(code, host, settings);
        // Custom links supplied at creation belong to the host who typed them.
        if (settings.normalVideoUrl || settings.imposterVideoUrl) {
          room.customVideoAuthorId = host.id;
        }
        socket.data.playerId = playerId;
        socket.data.code = code;
        socket.join(code);

        io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
        callback({ success: true, code });

        console.log(`[Room] Created: ${code} by ${data.playerName}`);
      }
    );

    // ─── Room: Join (and resume) ────────────────────────────────────
    // One entrypoint for both, because the client cannot tell them apart: it
    // navigates to /room/CODE and says who it is. If the room already knows
    // that player id, this is a refresh or a dropped connection coming back —
    // reattach them to the round in progress instead of minting a stranger.
    socket.on(
      'room:join',
      (
        data: {
          code: string;
          playerName: string;
          avatar: string;
          /** Ignored — the account comes from the session cookie (socketAuth). */
          userId: string | null;
          playerId?: string;
          cosmetics?: unknown;
        },
        callback: (res: {
          success: boolean;
          room?: ReturnType<typeof sanitizeRoom>;
          resumed?: boolean;
          error?: string;
        }) => void
      ) => {
        const room = getRoom(data.code);
        if (!room) {
          return callback({ success: false, error: 'Room not found' });
        }

        const playerId = durableId(data.playerId, socket);
        socket.data.playerId = playerId;
        socket.data.code = data.code;

        // ── Already in this room: a reconnect, or a duplicate join ──
        const known = room.players.find((p) => p.id === playerId);
        if (known) {
          const staleSocket = known.socketId;
          reattachPlayer(room, playerId, socket.id);
          // They may have signed in (or out) since the drop — the wallet the
          // round pays into follows the current cookie, not the old one.
          known.userId = (socket.data.userId as string | null) ?? null;
          cancelDrop(data.code, playerId);
          socket.join(data.code);
          if (staleSocket && staleSocket !== socket.id) {
            // An older tab for the same player stops receiving the room.
            io.sockets.sockets.get(staleSocket)?.leave(data.code);
          }
          // A returning watcher has no tape loaded yet; game:syncReady will
          // play them straight in off room.playAt.
          if (room.phase === 'playing') known.isReady = false;

          io.to(data.code).emit('room:updated', sanitizeRoom(room));
          io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
          callback({ success: true, room: sanitizeRoom(room), resumed: true });
          sendCatchUp(room, playerId, socket, io);
          console.log(`[Room] ${known.name} resumed ${data.code} (${room.phase})`);
          return;
        }

        // ── Known to a re-formed lobby: they were here before the round ──
        // A refresh on the results screen after someone else clicked Rejoin
        // lands here. Restoring them beats creating a duplicate identity.
        if (room.phase === 'lobby' && room.pastPlayers.some((p) => p.id === playerId)) {
          const restored = restorePlayer(room, playerId, socket.id);
          if (restored) {
            socket.join(data.code);
            io.to(data.code).emit('room:updated', sanitizeRoom(room));
            io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
            callback({ success: true, room: sanitizeRoom(room), resumed: true });
            console.log(`[Room] ${restored.name} restored to ${data.code}`);
            return;
          }
        }

        if (room.phase !== 'lobby') {
          return callback({ success: false, error: 'Game already in progress' });
        }
        if (room.players.length >= room.settings.maxPlayers) {
          return callback({ success: false, error: 'Room is full' });
        }

        const player: Player = {
          id: playerId,
          socketId: socket.id,
          userId: (socket.data.userId as string | null) ?? null,
          name: data.playerName,
          avatar: data.avatar,
          cosmetics: sanitizeCosmetics(data.cosmetics),
          isHost: false,
          isReady: false,
          isSpectator: false,
          status: 'connected',
        };

        const updatedRoom = addPlayer(data.code, player);
        if (!updatedRoom) return callback({ success: false, error: 'Could not join room' });

        socket.join(data.code);
        io.to(data.code).emit('room:updated', sanitizeRoom(updatedRoom));
        io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));

        callback({ success: true, room: sanitizeRoom(updatedRoom) });
        console.log(`[Room] ${data.playerName} joined ${data.code}`);
      }
    );

    // ─── Room: Update Settings (host only) ──────────────────────────
    // Section 4: the host can adjust any lobby setting between rounds without
    // closing and recreating the lobby. Between rounds is the operative part —
    // the lobby phase guard keeps a mid-round genre swap from repointing the
    // tapes under players who are already watching them.
    socket.on(
      'room:updateSettings',
      (data: {
        code: string;
        isPublic?: boolean;
        normalVideoUrl?: string;
        imposterVideoUrl?: string;
        wordsPerPlayer?: number;
        maxPlayers?: number;
        imposterCount?: number;
        chatType?: RoomSettings['chatType'];
        voteVisibility?: RoomSettings['voteVisibility'];
        videoCategory?: string | null;
      }) => {
        const room = getRoom(data.code);
        if (!room || room.hostId !== actorId(socket)) return;
        if (room.phase !== 'lobby') {
          socket.emit('game:error', { message: 'Settings can only change between rounds' });
          return;
        }

        if (data.isPublic !== undefined) room.settings.isPublic = data.isPublic;
        if (data.wordsPerPlayer !== undefined) {
          room.settings.wordsPerPlayer = Math.max(1, Math.min(10, data.wordsPerPlayer));
        }
        if (data.maxPlayers !== undefined) {
          // Never below the people already in the room, never outside 4–10 (§20).
          room.settings.maxPlayers = Math.max(
            MIN_PLAYERS,
            room.players.length,
            Math.min(MAX_PLAYERS, data.maxPlayers)
          );
        }
        if (data.imposterCount !== undefined) {
          // Section 3: 1 by default, 2 only once the lobby has 7+ players.
          const wanted = Math.max(1, Math.min(2, Math.round(data.imposterCount)));
          room.settings.imposterCount =
            wanted === 2 && room.players.length < TWO_IMPOSTER_MIN_PLAYERS ? 1 : wanted;
          if (room.settings.imposterCount !== wanted) {
            socket.emit('game:error', {
              message: `2 suspects unlocks at ${TWO_IMPOSTER_MIN_PLAYERS} players`,
            });
          }
        }
        if (data.chatType !== undefined) room.settings.chatType = data.chatType;
        if (data.voteVisibility !== undefined) {
          // Lobby-phase only, like every other setting here — flipping it
          // mid-ballot would retroactively publish votes cast in confidence.
          room.settings.voteVisibility =
            data.voteVisibility === 'anonymous' ? 'anonymous' : 'public';
        }
        if (data.videoCategory !== undefined) {
          const next = isKnownCategory(data.videoCategory) ? data.videoCategory! : null;
          if (next !== room.settings.videoCategory) {
            // A genre change invalidates whatever is loaded: leftover URLs from
            // a pool round would otherwise let a Custom lobby start on them.
            room.settings.normalVideoUrl = '';
            room.settings.imposterVideoUrl = '';
          }
          room.settings.videoCategory = next;
        }
        // Applied after the genre so an explicit URL in the same payload wins.
        if (data.normalVideoUrl !== undefined) room.settings.normalVideoUrl = data.normalVideoUrl;
        if (data.imposterVideoUrl !== undefined) room.settings.imposterVideoUrl = data.imposterVideoUrl;
        if (data.normalVideoUrl || data.imposterVideoUrl) {
          // Whoever pasted the links knows both answers and sits out (§4).
          room.customVideoAuthorId = actorId(socket);
        }
        // imposterCount is deliberately not settable in Phase 1 — it is pinned
        // to 1 (section 16). The 2-imposter option unlocks in Phase 2 at 7+
        // players and needs the two-round flow from section 3.

        io.to(data.code).emit('room:updated', sanitizeRoom(room));
        io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
      }
    );

    // ─── Room: Transfer host (host only, section 4) ─────────────────
    socket.on('room:transferHost', (data: { code: string; targetId: string }) => {
      const room = getRoom(data.code);
      if (!room) return;

      const result = transferHost(room, actorId(socket), data.targetId);
      if (!result.ok) {
        const messages: Record<HostTransferRejection, string> = {
          not_host: 'Only the host can hand over the lobby',
          no_such_player: 'That player is not in this lobby',
          offline: 'That player has lost signal',
          already_host: 'They are already the host',
        };
        socket.emit('game:error', { message: messages[result.reason] });
        return;
      }

      io.to(data.code).emit('room:updated', sanitizeRoom(room));
      // The lobby list shows the host's name and avatar.
      io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
      console.log(`[Room] ${data.code} host is now ${data.targetId}`);
    });

    // ─── Room: Kick Player (host only) ──────────────────────────────
    socket.on('room:kick', (data: { code: string; targetId: string }) => {
      const room = getRoom(data.code);
      if (!room || room.hostId !== actorId(socket)) return;

      // targetId is a durable player id; the socket to shout at is whatever
      // they are currently connected on, which is empty mid-reconnect.
      const target = room.players.find((p) => p.id === data.targetId);
      const targetSocket = target?.socketId
        ? io.sockets.sockets.get(target.socketId)
        : undefined;
      if (targetSocket) {
        targetSocket.emit('room:kicked', { reason: 'You were kicked by the host' });
        targetSocket.leave(data.code);
      }
      // Kicked means kicked — don't let the grace window bring them back.
      cancelDrop(data.code, data.targetId);

      const updatedRoom = removePlayer(data.code, data.targetId);
      if (updatedRoom) {
        io.to(data.code).emit('room:updated', sanitizeRoom(updatedRoom));
      }
    });

    // ─── Game: Start ────────────────────────────────────────────────
    socket.on('game:start', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.hostId !== actorId(socket)) return;

      // Section 4: on a Custom round the player who supplied the links sits
      // out, so a Custom lobby needs one more head than a pool one to reach
      // the same number of actual players. Work the checks off that count —
      // and off who is actually on the line, since a player inside their
      // reconnect window cannot be dealt a tape.
      const genre = room.settings.videoCategory;
      const isCustomRound = !genre || genre === CUSTOM_CATEGORY;
      const present = connectedPlayers(room);
      const sittingOut =
        isCustomRound && room.customVideoAuthorId
          ? present.find((p) => p.id === room.customVideoAuthorId)
          : undefined;
      const playingCount = present.length - (sittingOut ? 1 : 0);

      if (playingCount < MIN_PLAYERS) {
        socket.emit('game:error', {
          message: sittingOut
            ? `Need ${MIN_PLAYERS} players besides ${sittingOut.name}, who supplied the tapes`
            : `Need at least ${MIN_PLAYERS} players to start`,
        });
        return;
      }
      // The lobby can shrink below 7 after the host picks 2 suspects. Refuse
      // rather than quietly demoting it — which imposter count is in play
      // changes the whole shape of the round (section 3).
      if (
        room.settings.imposterCount >= 2 &&
        playingCount < TWO_IMPOSTER_MIN_PLAYERS
      ) {
        socket.emit('game:error', {
          message: `2 suspects needs ${TWO_IMPOSTER_MIN_PLAYERS}+ players — drop it to 1 or wait`,
        });
        return;
      }

      // Pool genres draw two distinct clips from /content/videos.json, skipping
      // anything this lobby has already seen (section 14). Custom is the one
      // genre that keeps the host's own pair.
      if (!isCustomRound) {
        const pair = pickVideoPair(genre, room.usedVideoIds);
        if (!pair) {
          socket.emit('game:error', {
            message: `The ${genre} shelf needs at least 2 clips configured`,
          });
          return;
        }
        room.settings.normalVideoUrl = watchUrl(pair.normal.youtubeId);
        room.settings.imposterVideoUrl = watchUrl(pair.imposter.youtubeId);
        room.usedVideoIds = pair.usedIds;
        console.log(
          `[Videos] ${data.code} ${genre}: ${pair.normal.id} vs ${pair.imposter.id}` +
            (pair.recycled ? ' (pool exhausted, history recycled)' : '')
        );
      }

      if (!room.settings.normalVideoUrl || !room.settings.imposterVideoUrl) {
        socket.emit('game:error', { message: 'Both video URLs must be set before starting' });
        return;
      }

      // resetRound clears per-round state but not roles, so assign after it.
      resetRound(room);
      // Must run before the imposter pick — the sitter is not a candidate.
      const spectator = assignSpectator(room, isCustomRound);
      // Section 3: both imposters watch the same secret video, so one pick of
      // N ids is all this needs.
      room.imposterIds = pickImposters(room, room.settings.imposterCount);
      room.imposterId = room.imposterIds[0];
      room.phase = 'playing';
      room.gameStartedAt = Date.now();
      room.players.forEach((p) => (p.isReady = false));

      // Send each player only their video URL — never their role. Section 3:
      // nobody is told whether they are Crewmate or Imposter, so the payload
      // must not carry `isImposter` even if no UI renders it; it would be
      // trivially readable from the network tab.
      room.players.forEach((player) => {
        // The sitter gets no tape: they chose both, so there is nothing to
        // show them and nothing they could honestly say about it.
        if (player.isSpectator || !player.socketId) return;
        const isImposter = room.imposterIds.includes(player.id);
        io.to(player.socketId).emit('game:assigned', {
          videoUrl: isImposter ? room.settings.imposterVideoUrl : room.settings.normalVideoUrl,
        });
      });

      io.to(data.code).emit('room:updated', sanitizeRoom(room));
      console.log(
        `[Game] Started in room ${data.code}` +
          (spectator ? ` (${spectator.name} sitting out — supplied the tapes)` : '')
      );
    });

    // ─── Game: Player's video loaded and ready to play ──────────────
    socket.on('game:syncReady', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'playing') return;

      const updatedRoom = setPlayerReady(data.code, actorId(socket));
      if (!updatedRoom) return;

      const watchers = activePlayers(updatedRoom);
      io.to(data.code).emit('game:readyCount', {
        ready: watchers.filter((p) => p.isReady).length,
        total: watchers.length,
      });

      // The tapes are already rolling — this is somebody who reconnected part
      // way through. Start them now rather than making the room wait again.
      if (updatedRoom.playAt !== null) {
        socket.emit('game:play', { playAt: Date.now() });
        return;
      }

      // All loaded → everyone plays at the same wall-clock moment
      if (allPlayersReady(updatedRoom)) {
        const playTimestamp = Date.now() + 1000; // 1s grace period
        updatedRoom.playAt = playTimestamp;
        io.to(data.code).emit('game:play', { playAt: playTimestamp });
        console.log(`[Game] All players ready in ${data.code}, playing at ${playTimestamp}`);
      }
    });

    // ─── Ready check: this player's video finished (section 6) ──────
    socket.on('game:videoEnded', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'playing') return;

      const wasImposter = markVideoEnded(room, actorId(socket));
      broadcastReadyState(room, io);

      // The imposter finishing starts the 10s grace countdown.
      if (wasImposter) startReadyGrace(room, io);
    });

    // ─── Ready check: this player clicked Ready (section 6) ─────────
    socket.on('game:readyToAdvance', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'playing') return;

      markReadyToAdvance(room, actorId(socket));
      broadcastReadyState(room, io);

      if (allReadyToAdvance(room)) {
        startWordPhase(room, io);
      }
    });

    // ─── Word phase: submit your word (section 7) ───────────────────
    socket.on('game:word', (data: { code: string; word: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'words') return;
      const speakerId = actorId(socket);
      if (room.activePlayerId !== speakerId) return; // not your turn

      const player = room.players.find((p) => p.id === speakerId);
      if (!player) return;
      if (playerFinishedTurn(room, speakerId)) return; // quota already used

      // One word only: strip whitespace, cap length.
      const word = data.word.trim().replace(/\s+/g, '').slice(0, 30);
      if (!word) return;

      const entry: GameWord = {
        playerId: speakerId,
        playerName: player.name,
        avatar: player.avatar,
        word,
        wordIndex: (room.wordsUsed[speakerId] || 0) + 1,
        timestamp: Date.now(),
      };
      recordWord(room, speakerId, entry);

      io.to(data.code).emit('game:word', entry);

      if (playerFinishedTurn(room, speakerId)) {
        nextTurn(room, io);
      } else {
        broadcastTurnState(room, io);
      }
    });

    // ─── Deliberation: chat (section 8, simultaneous with voting) ───
    socket.on('game:chat', (data: { code: string; message: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'deliberation') return;
      // 'none' lobbies coordinate on an external call — no in-app chat.
      if (room.settings.chatType === 'none') return;

      const player = room.players.find((p) => p.id === actorId(socket));
      if (!player) return;

      const message = data.message.trim().slice(0, 300);
      if (!message) return;

      io.to(data.code).emit('room:chatMessage', {
        playerId: player.id,
        playerName: player.name,
        avatar: player.avatar,
        message,
        timestamp: Date.now(),
        isWord: false,
      });
    });

    // ─── Deliberation: cast a vote (section 8) ──────────────────────
    socket.on(
      'vote:cast',
      (
        data: { code: string; targetId: string },
        callback?: (res: { success: boolean; error?: string }) => void
      ) => {
        const room = getRoom(data.code);
        if (!room) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }

        const result = castVote(room, actorId(socket), data.targetId);
        if (!result.ok) {
          const messages: Record<string, string> = {
            not_voting: 'Voting is not open',
            self: 'Cannot vote for yourself',
            already_voted: 'You have already voted this round',
            not_a_candidate: 'That player is not on the re-vote ballot',
            not_eligible: 'You are not eligible to recast this round',
          };
          callback?.({ success: false, error: messages[result.reason] });
          return;
        }

        broadcastTally(room, io);
        callback?.({ success: true });

        // Everyone still connected has voted → resolve immediately rather
        // than waiting out the rest of the 90s window.
        if (pendingVoters(room).length === 0) {
          concludeVote(room, io);
        }
      }
    );

    // ─── Room: Lobby chat ────────────────────────────────────────────
    socket.on('room:chat', (data: { code: string; message: string }) => {
      const room = getRoom(data.code);
      if (!room) return;
      if (room.settings.chatType === 'none') return;
      const player = room.players.find((p) => p.id === actorId(socket));
      if (!player) return;
      if (data.message.trim().length === 0) return;

      io.to(data.code).emit('room:chatMessage', {
        playerId: player.id,
        playerName: player.name,
        avatar: player.avatar,
        message: data.message.trim().slice(0, 300),
        timestamp: Date.now(),
      });
    });

    // ─── Game: Rejoin after a round ──────────────────────────────────
    // A finished round ends the lobby — everyone is out and sitting on the
    // results screen. Rejoin puts you back into the *same* lobby, settings and
    // all. The first person back re-forms it and takes the host seat; everyone
    // who clicks after that lands in the lobby alongside them. Nobody is
    // dragged back in without asking, which is why there is no host-only
    // "replay everyone" button any more.
    socket.on(
      'game:rejoin',
      (
        data: { code: string },
        callback?: (res: { success: boolean; error?: string }) => void
      ) => {
        const room = getRoom(data.code);
        if (!room) {
          callback?.({ success: false, error: 'That lobby has closed' });
          return;
        }

        const playerId = actorId(socket);

        if (room.phase === 'results') {
          clearRoomTimer(data.code);
          const dropped = reformLobby(room, playerId);
          // Take them out of the broadcast room so a lobby they have not opted
          // back into stops updating their results screen underneath them.
          for (const p of dropped) {
            if (p.socketId) io.sockets.sockets.get(p.socketId)?.leave(data.code);
          }
          console.log(`[Room] ${data.code} re-formed by ${playerId}`);
        } else if (room.phase === 'lobby') {
          if (!room.players.some((p) => p.id === playerId)) {
            if (room.players.length >= room.settings.maxPlayers) {
              callback?.({ success: false, error: 'That lobby is full again' });
              return;
            }
            if (!restorePlayer(room, playerId, socket.id)) {
              callback?.({ success: false, error: 'You are not part of that lobby' });
              return;
            }
            socket.join(data.code);
          }
        } else {
          callback?.({ success: false, error: 'That round is already under way' });
          return;
        }

        io.to(data.code).emit('room:updated', sanitizeRoom(room));
        io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
        callback?.({ success: true });
      }
    );

    // ─── Rooms: List (initial fetch) ─────────────────────────────────
    socket.on('rooms:list', (_data: any, callback: (rooms: any[]) => void) => {
      if (typeof callback === 'function') {
        callback(getPublicRooms().map(sanitizeRoom));
      }
    });

    // ─── Disconnect ──────────────────────────────────────────────────
    // A dropped socket is no longer a departure. The player is parked as
    // `disconnected` — which takes them out of activePlayers, so nothing waits
    // on them — and given DISCONNECT_GRACE_SECONDS to come back as the same
    // player id. Their vote, their turn slot and their role are all still
    // there when they do. Only when the grace expires are they removed, and
    // that path is the old behaviour verbatim (see finalizeDrop).
    socket.on('disconnect', () => {
      const found = findRoomBySocket(socket.id);
      if (!found) return;

      const { room, player } = found;
      const code = room.code;
      const wasActiveSpeaker = room.phase === 'words' && room.activePlayerId === player.id;

      markDisconnected(room, player.id);
      // The host seat is held for the grace window rather than handed on: a
      // host who refreshes is the commonest reconnect there is, and taking
      // the lobby off them for it would be worse than a few seconds of wait.
      // finalizeDrop -> removePlayer transfers it if they never come back.
      scheduleDrop(code, player.id, io);

      io.to(code).emit('room:updated', sanitizeRoom(room));

      if (wasActiveSpeaker) {
        // Their turn goes with them; move on rather than burning 10s. Their
        // slot stays in turnOrder — advanceTurn skips whoever is not active.
        nextTurn(room, io);
      } else if (room.phase === 'words') {
        broadcastTurnState(room, io);
      } else if (room.phase === 'playing') {
        broadcastReadyState(room, io);
        if (allReadyToAdvance(room)) startWordPhase(room, io);
      } else if (room.phase === 'deliberation') {
        // The ballot they are no longer eligible for may now be complete.
        // Their vote stays on record — they may yet be back to see it land.
        broadcastTally(room, io);
        if (pendingVoters(room).length === 0) {
          concludeVote(room, io);
        }
      }

      io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
      console.log(`[Socket] ${player.name} dropped from ${code} — ${DISCONNECT_GRACE_SECONDS}s to return`);
    });
  });
}

// ─── Results (section 9) ─────────────────────────────────────────────────────

/**
 * Closes the game and reveals everything (section 9). `accusedIds` is every
 * player the group ejected: one in a normal game, up to two across the pair of
 * rounds a 2-imposter game runs. Both are revealed at the same moment
 * (section 3) — this is the first payload that carries roles at all.
 */
function finalizeResults(room: RoomState, io: Server, accusedIds: string[]) {
  if (room.phase === 'results') return;

  clearRoomTimer(room.code);
  room.phase = 'results';

  const imposterIds = room.imposterIds;
  const imposterCount = imposterIds.length;
  const imposter = room.players.find((p) => p.id === room.imposterId);
  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? 'Unknown';

  const impostersCaught = imposterIds.filter((id) => accusedIds.includes(id)).length;
  const crewWins = imposterCount > 0 && impostersCaught === imposterCount;
  const outcome: 'crew' | 'imposter' | 'split' =
    crewWins ? 'crew' : impostersCaught === 0 ? 'imposter' : 'split';

  const tally = getVoteTally(room);
  // The last accusation is the one the results screen ejects on camera.
  const headlineAccused = accusedIds[accusedIds.length - 1] ?? null;

  const payload: GameResults = {
    imposterId: room.imposterId ?? '',
    imposterIds,
    imposterName: imposter?.name ?? 'Unknown',
    imposterAvatar: imposter?.avatar ?? '',
    mostVotedId: headlineAccused,
    mostVotedName: headlineAccused ? nameOf(headlineAccused) : 'Nobody',
    accusedIds,
    accusedNames: accusedIds.map(nameOf),
    imposterCount,
    impostersCaught,
    outcome,
    crewWins,
    tally,
    // Both videos are safe to reveal now that voting has closed.
    normalVideoUrl: room.settings.normalVideoUrl,
    imposterVideoUrl: room.settings.imposterVideoUrl,
    players: room.players.map((p) => {
      const isImposter = imposterIds.includes(p.id);
      return {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        cosmetics: p.cosmetics,
        votes: tally[p.id] ?? 0,
        isImposter,
        wasAccused: accusedIds.includes(p.id),
        isSpectator: p.isSpectator,
        coinReward: coinsFor(p.isSpectator, isImposter, imposterCount, impostersCaught, crewWins),
      };
    }),
  };

  // Kept so a refresh on the results screen gets the same reveal back — the
  // round is over, so there is nothing left to leak.
  room.lastResults = payload;
  io.to(room.code).emit('game:results', payload);
  bankRewards(room, payload);

  console.log(
    `[Game] Results in ${room.code}: ${outcome} (${impostersCaught}/${imposterCount} caught)`
  );
}

/**
 * Banks each signed-in player's reward (spec §9, §11).
 *
 * Fire-and-forget on purpose: the reveal has already gone out, and a database
 * hiccup must not hold up or partially fail the broadcast that every client is
 * waiting on. A player either has a verified account behind their socket or
 * they are a guest, in which case there is nothing to bank — their coins live
 * in localStorage and die with it, which is what §11's claim prompt is for.
 *
 * `userId` here came from the session cookie (see socketAuth.ts), not from
 * anything the client sent, or this would be a coin printer.
 */
function bankRewards(room: RoomState, payload: GameResults) {
  const rewardOf = new Map<string, CoinReward>(
    payload.players.map((p) => [p.id, p.coinReward])
  );
  for (const player of room.players) {
    if (!player.userId) continue;
    const total = rewardOf.get(player.id)?.total ?? 0;
    if (total > 0) void awardCoins(player.userId, total);
  }
}

/**
 * Section 9 for one imposter, section 3's table for two. The 2-imposter game
 * doesn't pay on a win/lose flip — one of two caught pays both sides a middle
 * amount, and every imposter gets the same regardless of which was caught.
 */
function coinsFor(
  isSpectator: boolean,
  isImposter: boolean,
  imposterCount: number,
  impostersCaught: number,
  crewWins: boolean
) {
  // Supplying the tapes is not playing, and paying for it would let a host
  // farm the participation coins round after round without ever guessing.
  if (isSpectator) {
    return {
      baseCoins: 0,
      bonusCoins: 0,
      total: 0,
      reasons: ['Sat out — you supplied the tapes'],
    };
  }
  if (imposterCount >= 2) {
    const caught = Math.min(impostersCaught, 2);
    const total = isImposter
      ? TWO_IMPOSTER_SUSPECT_TOTALS[caught]
      : TWO_IMPOSTER_CREW_TOTALS[caught];
    return {
      baseCoins: BASE_COINS,
      bonusCoins: total - BASE_COINS,
      total,
      reasons: [
        'Played a round',
        `${caught} of 2 suspects caught`,
      ],
    };
  }

  const won = isImposter ? !crewWins : crewWins;
  const bonus = won ? (isImposter ? IMPOSTER_WIN_BONUS : CREW_WIN_BONUS) : 0;
  return {
    baseCoins: BASE_COINS,
    bonusCoins: bonus,
    total: BASE_COINS + bonus,
    reasons: [
      'Played a round',
      ...(won ? [isImposter ? 'Imposter victory bonus!' : 'Crew victory bonus!'] : []),
    ],
  };
}
