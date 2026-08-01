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
  getPlayerRoom,
  setPlayerReady,
  allPlayersReady,
  resetRound,
  generateRoomCode,
  markVideoEnded,
  markReadyToAdvance,
  allReadyToAdvance,
  connectedPlayers,
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
  Player,
  RoomSettings,
  RoomState,
} from './gameState';
import { CUSTOM_CATEGORY, isKnownCategory } from '../lib/videoCategories';
import { pickVideoPair, watchUrl } from './videoLibrary';

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

function sanitizeRoom(room: RoomState) {
  // Never send video URLs or roles to clients. URLs go out individually in
  // game:assigned; roles are revealed only in game:results (section 3).
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isHost: p.isHost,
      isReady: p.isReady,
      status: p.status,
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
      videoCategory: room.settings.videoCategory,
    },
    votes: room.votes,
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

// ─── Ready check (section 6) ─────────────────────────────────────────────────

function broadcastReadyState(room: RoomState, io: Server) {
  const active = connectedPlayers(room);
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

/** Resolves the ballot: either an accusation, or another re-vote round. */
function concludeVote(room: RoomState, io: Server) {
  const outcome = resolveVote(room);

  if (outcome.kind === 'revote') {
    beginRevote(room, outcome);
    io.to(room.code).emit('game:revote', {
      candidates: outcome.candidates,
      eligibleVoters: outcome.eligibleVoters,
      voteRound: room.voteRound,
      endsAt: room.deliberationEndsAt,
      durationSeconds: DELIBERATION_SECONDS,
      tally: getVoteTally(room),
    });
    startDeliberationTimer(room, io);
    console.log(
      `[Vote] Tie in ${room.code} between ${outcome.candidates.join(', ')} — re-vote round ${room.voteRound}`
    );
    return;
  }

  finalizeResults(room, io, outcome.accusedId);
}

function broadcastTally(room: RoomState, io: Server) {
  const active = connectedPlayers(room);
  io.to(room.code).emit('vote:tally', {
    tally: getVoteTally(room),
    votescast: Object.keys(room.votes).length,
    totalVoters: active.length,
  });
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function registerSocketHandlers(io: Server) {
  io.on('connection', (socket: Socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // ─── Room: Create ───────────────────────────────────────────────
    socket.on(
      'room:create',
      (
        data: {
          playerName: string;
          avatar: string;
          userId: string | null;
          isPublic: boolean;
          normalVideoUrl?: string;
          imposterVideoUrl?: string;
          wordsPerPlayer?: number;
          maxPlayers?: number;
          chatType?: RoomSettings['chatType'];
          videoCategory?: string | null;
        },
        callback: (res: { success: boolean; code?: string; error?: string }) => void
      ) => {
        const code = generateRoomCode();

        const host: Player = {
          id: socket.id,
          userId: data.userId,
          name: data.playerName,
          avatar: data.avatar,
          isHost: true,
          isReady: false,
          status: 'connected',
        };

        const settings: RoomSettings = {
          isPublic: data.isPublic,
          normalVideoUrl: data.normalVideoUrl || '',
          imposterVideoUrl: data.imposterVideoUrl || '',
          maxPlayers: Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, data.maxPlayers ?? MAX_PLAYERS)),
          wordsPerPlayer: data.wordsPerPlayer ?? 1,
          // Phase 1 is single-imposter only (section 16); the 2-imposter mode
          // is Phase 2 and runs a different two-round structure.
          imposterCount: 1,
          chatType: data.chatType ?? 'text',
          // An unrecognised genre falls back to null, which means "host supplies
          // the URLs" — never a silent pick from some other shelf.
          videoCategory: isKnownCategory(data.videoCategory) ? data.videoCategory! : null,
        };

        createRoom(code, host, settings);
        socket.join(code);

        io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
        callback({ success: true, code });

        console.log(`[Room] Created: ${code} by ${data.playerName}`);
      }
    );

    // ─── Room: Join ─────────────────────────────────────────────────
    socket.on(
      'room:join',
      (
        data: { code: string; playerName: string; avatar: string; userId: string | null },
        callback: (res: { success: boolean; room?: ReturnType<typeof sanitizeRoom>; error?: string }) => void
      ) => {
        const room = getRoom(data.code);
        if (!room) {
          return callback({ success: false, error: 'Room not found' });
        }
        if (room.phase !== 'lobby') {
          return callback({ success: false, error: 'Game already in progress' });
        }
        if (room.players.length >= room.settings.maxPlayers) {
          return callback({ success: false, error: 'Room is full' });
        }

        const player: Player = {
          id: socket.id,
          userId: data.userId,
          name: data.playerName,
          avatar: data.avatar,
          isHost: false,
          isReady: false,
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
        chatType?: RoomSettings['chatType'];
        videoCategory?: string | null;
      }) => {
        const room = getRoom(data.code);
        if (!room || room.hostId !== socket.id) return;
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
        if (data.chatType !== undefined) room.settings.chatType = data.chatType;
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

      const result = transferHost(room, socket.id, data.targetId);
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
      if (!room || room.hostId !== socket.id) return;

      const targetSocket = io.sockets.sockets.get(data.targetId);
      if (targetSocket) {
        targetSocket.emit('room:kicked', { reason: 'You were kicked by the host' });
        targetSocket.leave(data.code);
      }

      const updatedRoom = removePlayer(data.code, data.targetId);
      if (updatedRoom) {
        io.to(data.code).emit('room:updated', sanitizeRoom(updatedRoom));
      }
    });

    // ─── Game: Start ────────────────────────────────────────────────
    socket.on('game:start', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.hostId !== socket.id) return;
      if (room.players.length < MIN_PLAYERS) {
        socket.emit('game:error', {
          message: `Need at least ${MIN_PLAYERS} players to start`,
        });
        return;
      }

      // Pool genres draw two distinct clips from /content/videos.json, skipping
      // anything this lobby has already seen (section 14). Custom is the one
      // genre that keeps the host's own pair.
      const genre = room.settings.videoCategory;
      if (genre && genre !== CUSTOM_CATEGORY) {
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

      // Phase 1: exactly one imposter (section 16), picked uniformly.
      const imposter = room.players[Math.floor(Math.random() * room.players.length)];
      // resetRound clears per-round state but not roles, so assign after it.
      resetRound(room);
      room.imposterIds = [imposter.id];
      room.imposterId = imposter.id;
      room.phase = 'playing';
      room.gameStartedAt = Date.now();
      room.players.forEach((p) => (p.isReady = false));

      // Send each player only their video URL — never their role. Section 3:
      // nobody is told whether they are Crewmate or Imposter, so the payload
      // must not carry `isImposter` even if no UI renders it; it would be
      // trivially readable from the network tab.
      room.players.forEach((player) => {
        const isImposter = room.imposterIds.includes(player.id);
        io.to(player.id).emit('game:assigned', {
          videoUrl: isImposter ? room.settings.imposterVideoUrl : room.settings.normalVideoUrl,
        });
      });

      io.to(data.code).emit('room:updated', sanitizeRoom(room));
      console.log(`[Game] Started in room ${data.code}`);
    });

    // ─── Game: Player's video loaded and ready to play ──────────────
    socket.on('game:syncReady', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'playing') return;

      const updatedRoom = setPlayerReady(data.code, socket.id);
      if (!updatedRoom) return;

      const readyCount = updatedRoom.players.filter((p) => p.isReady).length;
      io.to(data.code).emit('game:readyCount', {
        ready: readyCount,
        total: updatedRoom.players.length,
      });

      // All loaded → everyone plays at the same wall-clock moment
      if (allPlayersReady(updatedRoom)) {
        const playTimestamp = Date.now() + 1000; // 1s grace period
        io.to(data.code).emit('game:play', { playAt: playTimestamp });
        console.log(`[Game] All players ready in ${data.code}, playing at ${playTimestamp}`);
      }
    });

    // ─── Ready check: this player's video finished (section 6) ──────
    socket.on('game:videoEnded', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'playing') return;

      const wasImposter = markVideoEnded(room, socket.id);
      broadcastReadyState(room, io);

      // The imposter finishing starts the 10s grace countdown.
      if (wasImposter) startReadyGrace(room, io);
    });

    // ─── Ready check: this player clicked Ready (section 6) ─────────
    socket.on('game:readyToAdvance', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'playing') return;

      markReadyToAdvance(room, socket.id);
      broadcastReadyState(room, io);

      if (allReadyToAdvance(room)) {
        startWordPhase(room, io);
      }
    });

    // ─── Word phase: submit your word (section 7) ───────────────────
    socket.on('game:word', (data: { code: string; word: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'words') return;
      if (room.activePlayerId !== socket.id) return; // not your turn

      const player = room.players.find((p) => p.id === socket.id);
      if (!player) return;
      if (playerFinishedTurn(room, socket.id)) return; // quota already used

      // One word only: strip whitespace, cap length.
      const word = data.word.trim().replace(/\s+/g, '').slice(0, 30);
      if (!word) return;

      recordWord(room, socket.id);

      io.to(data.code).emit('game:word', {
        playerId: socket.id,
        playerName: player.name,
        avatar: player.avatar,
        word,
        wordIndex: room.wordsUsed[socket.id],
        timestamp: Date.now(),
      });

      if (playerFinishedTurn(room, socket.id)) {
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

      const player = room.players.find((p) => p.id === socket.id);
      if (!player) return;

      const message = data.message.trim().slice(0, 300);
      if (!message) return;

      io.to(data.code).emit('room:chatMessage', {
        playerId: socket.id,
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

        const result = castVote(room, socket.id, data.targetId);
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
      const player = room.players.find((p) => p.id === socket.id);
      if (!player) return;
      if (data.message.trim().length === 0) return;

      io.to(data.code).emit('room:chatMessage', {
        playerId: socket.id,
        playerName: player.name,
        avatar: player.avatar,
        message: data.message.trim().slice(0, 300),
        timestamp: Date.now(),
      });
    });

    // ─── Game: Back to lobby (host only) ─────────────────────────────
    socket.on('game:backToLobby', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.hostId !== socket.id) return;

      clearRoomTimer(data.code);
      room.phase = 'lobby';
      room.imposterId = null;
      room.imposterIds = [];
      room.gameStartedAt = null;
      room.players.forEach((p) => (p.isReady = false));
      resetRound(room);

      io.to(data.code).emit('room:updated', sanitizeRoom(room));
    });

    // ─── Rooms: List (initial fetch) ─────────────────────────────────
    socket.on('rooms:list', (_data: any, callback: (rooms: any[]) => void) => {
      if (typeof callback === 'function') {
        callback(getPublicRooms().map(sanitizeRoom));
      }
    });

    // ─── Disconnect ──────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const room = getPlayerRoom(socket.id);
      if (!room) return;

      const code = room.code;
      const wasActiveSpeaker = room.phase === 'words' && room.activePlayerId === socket.id;
      const leaverTurnIndex = room.turnOrder.indexOf(socket.id);

      const updatedRoom = removePlayer(code, socket.id);

      if (!updatedRoom) {
        // Room is empty and has been deleted — drop its timer too.
        clearRoomTimer(code);
        io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
        console.log(`[Socket] Disconnected: ${socket.id} (room ${code} closed)`);
        return;
      }

      // Keep the word-phase turn order consistent with the shrunken lobby.
      if (leaverTurnIndex !== -1) {
        updatedRoom.turnOrder.splice(leaverTurnIndex, 1);
        if (leaverTurnIndex < updatedRoom.turnIndex) updatedRoom.turnIndex--;
      }

      io.to(code).emit('room:updated', sanitizeRoom(updatedRoom));

      if (wasActiveSpeaker) {
        // Their turn dies with them; move on rather than burning 10s.
        updatedRoom.turnIndex--;
        nextTurn(updatedRoom, io);
      } else if (updatedRoom.phase === 'words') {
        broadcastTurnState(updatedRoom, io);
      } else if (updatedRoom.phase === 'playing') {
        broadcastReadyState(updatedRoom, io);
        if (allReadyToAdvance(updatedRoom)) startWordPhase(updatedRoom, io);
      } else if (updatedRoom.phase === 'deliberation') {
        // Their vote leaves with them; the remaining players may now be done.
        delete updatedRoom.votes[socket.id];
        broadcastTally(updatedRoom, io);
        if (pendingVoters(updatedRoom).length === 0) {
          concludeVote(updatedRoom, io);
        }
      }

      io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
      console.log(`[Socket] Disconnected: ${socket.id}`);
    });
  });
}

// ─── Results (section 9) ─────────────────────────────────────────────────────

function finalizeResults(room: RoomState, io: Server, accusedId: string | null) {
  if (room.phase === 'results') return;

  clearRoomTimer(room.code);
  room.phase = 'results';

  const imposterIds = room.imposterIds;
  const imposter = room.players.find((p) => p.id === room.imposterId);
  const accusedPlayer = room.players.find((p) => p.id === accusedId);
  const crewWins = accusedId !== null && imposterIds.includes(accusedId);

  const tally = getVoteTally(room);

  io.to(room.code).emit('game:results', {
    imposterId: room.imposterId,
    imposterIds,
    imposterName: imposter?.name ?? 'Unknown',
    imposterAvatar: imposter?.avatar ?? '',
    mostVotedId: accusedId,
    mostVotedName: accusedPlayer?.name ?? 'Nobody',
    crewWins,
    tally,
    // Both videos are safe to reveal now that voting has closed.
    normalVideoUrl: room.settings.normalVideoUrl,
    imposterVideoUrl: room.settings.imposterVideoUrl,
    players: room.players.map((p) => {
      const isImposter = imposterIds.includes(p.id);
      const won = isImposter ? !crewWins : crewWins;
      const bonus = won ? (isImposter ? IMPOSTER_WIN_BONUS : CREW_WIN_BONUS) : 0;
      return {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        votes: tally[p.id] ?? 0,
        isImposter,
        coinReward: {
          baseCoins: BASE_COINS,
          bonusCoins: bonus,
          total: BASE_COINS + bonus,
          reasons: [
            'Played a round',
            ...(won ? [isImposter ? 'Imposter victory bonus!' : 'Crew victory bonus!'] : []),
          ],
        },
      };
    }),
  });

  console.log(`[Game] Results in ${room.code}: ${crewWins ? 'Crew' : 'Imposter'} wins`);
}
