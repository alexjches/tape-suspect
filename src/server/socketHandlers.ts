// src/server/socketHandlers.ts
// All Socket.io event handlers.
//
// Phase flow (docs/BUILD-PLAN.md sections 6-9):
//   lobby -> playing -> words -> deliberation -> results

import { Server, Socket } from 'socket.io';
import {
  createRoom,
  getRoom,
  deleteRoom,
  getPublicRooms,
  findRoomHostedBy,
  addPlayer,
  beginDrawPhase,
  beginVoicePhase,
  isListening,
  recordTake,
  hasTaken,
  turnsPerPlayer,
  beginCluePhase,
  beginGuessPhase,
  beginWritingPhase,
  beginBluffVote,
  recordDefinition,
  allDefinitionsIn,
  castBluffVote,
  allBluffVotesIn,
  recordGuess,
  guessers,
  allGuessesIn,
  CLUE_SECONDS,
  GUESS_SECONDS,
  recordStroke,
  dropStaleSocketRows,
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
  usesCustomContent,
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
  removeBots,
  deliberationSeconds,
  skipsWordPhase,
  HostTransferRejection,
  VoteOutcome,
  Player,
  RoomSettings,
  RoomState,
} from './gameState';
import {
  CUSTOM_CATEGORY,
  isDrawStyle,
  isSpectrumStyle,
  isBluffStyle,
  isVoiceStyle,
  isKnownCategory,
  isPromptStyle,
} from '../lib/videoCategories';
import {
  isFingerprint,
  similarity,
  averageFingerprint,
  scoreMatch,
} from '../lib/audioFingerprint';
import { pickPromptPair } from './promptLibrary';
import { pickDrawWord } from './drawLibrary';
import { pickVoiceLine, publicLine } from './voiceLibrary';
import { pickSpectrum, scoreGuess } from './wavelengthLibrary';
import {
  pickBluffWord,
  REAL_DEFINITION_ID,
  POINTS_PER_FOOL,
  POINTS_FOR_TRUTH,
} from './bluffLibrary';
import { sanitizeCosmetics } from '../lib/cosmetics';
import { toAvatarCode } from '../lib/avatars';
import { pickVideoPair, watchUrl } from './videoLibrary';
import { verifySocketUser } from './socketAuth';
import { awardCoins } from './wallet';
import {
  BOTS_ENABLED,
  makeBot,
  freshBotRuntime,
  botLoadDelay,
  botReadyDelay,
  botReactGap,
  botSpeakDelay,
  botVoteDelay,
  botWord,
  botEmoji,
  botFingerprint,
  botVoteTarget,
} from './bots';
import type {
  CoinReward,
  DrawStroke,
  GameAssignment,
  ScoreLine,
  GameReaction,
  GameResults,
  GameWord,
  ReactionEmoji,
  VoiceTake,
} from '../types';
import { isReactionEmoji } from '../types';

// ── Phase 1 rule constants (docs/BUILD-PLAN.md) ──────────────────────
// Lobby size 3–10. Phase 1 ships a single imposter only (section 16) —
// 2-imposter lobbies unlock at 7+ players in Phase 2.
//
// The floor is 3, not section 20's 4: an owner decision, recorded in CLAUDE.md
// rather than left as a silent disagreement with the spec.
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;

// Section 6: the word phase starts once everyone is ready, or 10s after the
// imposter's video ends — whichever comes first — so one straggler cannot
// hold up the lobby.
const READY_GRACE_SECONDS = 10;

// The same idea for a Words or Questions round, where the card *is* the phase:
// long enough to think of an answer to a question rather than to finish
// watching something. Everyone clicking Ready still ends it early.
const PROMPT_READ_SECONDS = 45;

// Longest a host-written prompt card may be. Words are capped at 30 because a
// word is a word; a card can be a whole question, so it gets room — but it
// still has to be one card on one screen at one size, since a card that
// overflows for the crew and not for the suspect would be a role tell.
const MAX_PROMPT_LENGTH = 120;

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

// Minimum gap between one player's reactions (§5). Reactions are broadcast
// to everyone and animate on top of the video, so an unthrottled sender can
// paper over the picture for the whole room — the one phase where nobody can
// look away. Loose enough that deliberate double-tapping still reads as two
// reactions, tight enough that holding the button is not a screen wipe.
const REACTION_MIN_INTERVAL_MS = 500;

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
  const trimmed = typeof supplied === 'string' ? supplied.trim().slice(0, 64) : '';
  if (trimmed) return trimmed;
  // Loud on purpose. Every client path sends this; a fallback means one of them
  // has stopped, and the room is about to key a player on a value that changes
  // on the next reconnect. It shipped silently once — see dropStaleSocketRows.
  console.warn(`[Room] join/create with no player id from ${socket.id} — falling back to socket id`);
  return socket.id;
}

function sanitizeRoom(room: RoomState) {
  // Never send video URLs, word/question pairs or roles to clients. Each
  // player's own half goes out individually in game:assigned; roles are
  // revealed only in game:results (section 3). This object is built field by
  // field rather than spread, which is what keeps that true by default.
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    // Safe to broadcast: who was accused in round 1, not what they were.
    gameRound: room.gameRound,
    totalRounds: totalGameRounds(room),
    accusedIds: room.accusedIds,
    // Not secret — it's whoever typed the custom content, and the lobby needs
    // to say who will be sitting out before anyone hits start (section 4).
    customContentAuthorId: room.customContentAuthorId,
    // The public half of Wavelength. The scale has to be visible to everyone
    // — it is what they are guessing on — while `spectrumTarget` and
    // `psychicId` stay off this object entirely. That split IS the mode's
    // secrecy surface, so keep the two apart when editing.
    spectrum: room.spectrum,
    psychicClue: room.psychicClue,
    // The public half of Choicer Voicer, and the same split as the spectrum
    // above: the line is what everyone is aiming at, so it has to be visible,
    // while `room.voiceReference` — the fingerprint every take is measured
    // against — stays off this object entirely. Handing it out would let a
    // client submit it back for a flawless score.
    voiceLine: room.voiceLine,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      isHost: p.isHost,
      isReady: p.isReady,
      isSpectator: p.isSpectator,
      status: p.status,
      // Deliberately published — see PlayerPublic.isBot. Note this picks
      // fields one by one, which is what keeps `p.bot` (the scheduling
      // runtime) and `p.lastReactionAt` server-side without extra effort.
      isBot: p.isBot ?? false,
      cosmetics: p.cosmetics,
    })),
    settings: {
      isPublic: room.settings.isPublic,
      maxPlayers: room.settings.maxPlayers,
      // Which pot the round is drawn from is public; what is *in* it is not.
      useCustomContent: room.settings.useCustomContent,
      // Deliberately exclude video URLs from broadcast
      hasNormalVideo: !!room.settings.normalVideoUrl,
      hasImposterVideo: !!room.settings.imposterVideoUrl,
      // …and the custom prompt cards for exactly the same reason. The lobby
      // needs to know whether the pair is loaded, never what it says.
      hasNormalPrompt: !!room.settings.customNormalPrompt,
      hasImposterPrompt: !!room.settings.customImposterPrompt,
      wordsPerPlayer: room.settings.wordsPerPlayer,
      imposterCount: room.settings.imposterCount,
      chatType: room.settings.chatType,
      voteVisibility: room.settings.voteVisibility,
      themeHint: room.settings.themeHint,
      videoCategory: room.settings.videoCategory,
    },
    // Individual ballots. An anonymous lobby never publishes them — not
    // during the vote and not after it, since §4 promises only the final
    // tally is revealed, and this object is who-voted-for-whom.
    votes: isAnonymousVote(room) ? {} : room.votes,
    botsAllowed: BOTS_ENABLED,
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

// ── Bot driver ───────────────────────────────────────────────────────────
//
// Its own map, for the same reason `dropTimers` has one: `roomTimers` is a
// single slot per room that every phase reuses, so a bot ticker parked there
// would clobber the turn clock or the deliberation countdown. One interval
// per room with bots in it, holding all of them.
//
// The tick reads the room fresh each time and acts on the current phase, so
// it cannot corrupt a phase that has already moved on — the same discipline
// the phase timers use.
const botTimers = new Map<string, NodeJS.Timeout>();

const BOT_TICK_MS = 400;

function startBotTicker(code: string, io: Server) {
  if (botTimers.has(code)) return;
  const handle = setInterval(() => runBotTick(code, io), BOT_TICK_MS);
  botTimers.set(code, handle);
}

function clearBotTicker(code: string) {
  const handle = botTimers.get(code);
  if (handle) {
    clearInterval(handle);
    botTimers.delete(code);
  }
}

/**
 * One pass of bot behaviour for a room.
 *
 * Every branch goes through the same mutator and broadcast helper the real
 * socket handler for that action uses — `setPlayerReady` + the readyCount
 * emit, `recordWord` + `nextTurn`, `castVote` + `broadcastTally`. That is
 * the whole design constraint: a bot must not be able to reach a state a
 * player could not, or the round it fills is not the round being tested.
 */
function runBotTick(code: string, io: Server) {
  const room = getRoom(code);
  if (!room) {
    clearBotTicker(code);
    return;
  }

  const bots = room.players.filter((p) => p.isBot);
  if (bots.length === 0) {
    clearBotTicker(code);
    return;
  }

  const now = Date.now();

  switch (room.phase) {
    case 'playing': {
      // ── A prompt round has no tape to buffer, no synchronised start and
      //    nothing to react to, so all of the machinery below is skipped and
      //    a bot only has to stop blocking the Ready Check.
      if (isPromptStyle(room.settings.videoCategory)) {
        let readied = false;
        for (const bot of bots) {
          if (bot.isSpectator) continue;
          if (!bot.bot) bot.bot = freshBotRuntime();
          if (room.readyToAdvance[bot.id]) continue;
          if (bot.bot.readyAt === 0) {
            bot.bot.readyAt = now + botReadyDelay();
            continue;
          }
          if (now >= bot.bot.readyAt) {
            markReadyToAdvance(room, bot.id);
            readied = true;
          }
        }
        if (readied) {
          broadcastReadyState(room, io);
          if (allReadyToAdvance(room)) startWordPhase(room, io);
        }
        return;
      }

      // ── Load. Bots report their tape buffered so the synchronised start
      //    is not held up by players who have nothing to buffer.
      let loadedSomething = false;
      for (const bot of bots) {
        if (bot.isReady || bot.isSpectator) continue;
        if (!bot.bot) bot.bot = freshBotRuntime();
        if (bot.bot.readyAt === 0) {
          bot.bot.readyAt = now + botLoadDelay();
          continue;
        }
        if (now >= bot.bot.readyAt) {
          setPlayerReady(code, bot.id);
          // Re-purpose the slot for the Ready click, which is a later beat.
          bot.bot.readyAt = now + botReadyDelay();
          loadedSomething = true;
        }
      }

      if (loadedSomething) {
        const watchers = activePlayers(room);
        io.to(code).emit('game:readyCount', {
          ready: watchers.filter((p) => p.isReady).length,
          total: watchers.length,
        });
        if (room.playAt === null && allPlayersReady(room)) {
          const playTimestamp = now + 1000;
          room.playAt = playTimestamp;
          io.to(code).emit('game:play', { playAt: playTimestamp });
          console.log(`[Bots] ${code}: all loaded, playing at ${playTimestamp}`);
        }
      }

      // Nothing below happens until the tape is actually rolling.
      if (room.playAt === null || now < room.playAt) return;

      // ── React (§5). The requested behaviour, and the reason a bot lobby
      //    is worth watching: the corner fills up while the tape plays.
      for (const bot of bots) {
        if (bot.isSpectator || !bot.bot) continue;
        if (bot.bot.nextReactAt === 0) {
          bot.bot.nextReactAt = now + botReactGap();
          continue;
        }
        if (now >= bot.bot.nextReactAt) {
          broadcastReaction(room, bot, botEmoji(), io);
          bot.bot.nextReactAt = now + botReactGap();
        }
      }

      // ── Ready. Bots never report `game:videoEnded` — see botReadyDelay()
      //    for why that would cut a human's video short. Clicking Ready is
      //    enough to stop them blocking, and leaves the pacing to the human.
      let clicked = false;
      for (const bot of bots) {
        if (bot.isSpectator || !bot.bot) continue;
        if (room.readyToAdvance[bot.id]) continue;
        if (bot.isReady && now >= bot.bot.readyAt) {
          markReadyToAdvance(room, bot.id);
          clicked = true;
        }
      }
      if (clicked) {
        broadcastReadyState(room, io);
        if (allReadyToAdvance(room)) startWordPhase(room, io);
      }
      return;
    }

    case 'words': {
      const speaker = room.activePlayerId;
      if (!speaker) return;
      const bot = bots.find((p) => p.id === speaker);
      if (!bot || !bot.bot) return;
      if (playerFinishedTurn(room, speaker)) return;

      if (bot.bot.speakAt === 0) {
        bot.bot.speakAt = now + botSpeakDelay();
        return;
      }
      if (now < bot.bot.speakAt) return;
      bot.bot.speakAt = 0;

      const entry: GameWord = {
        playerId: bot.id,
        playerName: bot.name,
        avatar: bot.avatar,
        word: botWord(),
        wordIndex: (room.wordsUsed[bot.id] || 0) + 1,
        timestamp: now,
      };
      recordWord(room, bot.id, entry);
      io.to(code).emit('game:word', entry);

      if (playerFinishedTurn(room, bot.id)) nextTurn(room, io);
      else broadcastTurnState(room, io);
      return;
    }

    case 'voicing': {
      const performer = room.activePlayerId;
      if (!performer) return;
      const bot = bots.find((p) => p.id === performer);
      if (!bot || !bot.bot) return;
      if (playerFinishedTurn(room, performer)) return;

      if (bot.bot.speakAt === 0) {
        bot.bot.speakAt = now + botSpeakDelay();
        return;
      }
      if (now < bot.bot.speakAt) return;
      bot.bot.speakAt = 0;

      // A bot has no microphone, so what it cannot do is record. It can still
      // produce a fingerprint of the right shape — and doing so is what keeps
      // the rule: the score below is computed by the same `similarity()` a
      // player's take goes through, not fabricated. See botFingerprint().
      const print = botFingerprint(room.voiceReference);
      const match = room.voiceReference ? similarity(print, room.voiceReference) : null;
      const take: VoiceTake = {
        playerId: bot.id,
        playerName: bot.name,
        avatar: bot.avatar,
        match,
        points: match === null ? 0 : scoreMatch(match),
        turnIndex: room.turnIndex,
      };
      recordTake(room, bot.id, take, print);
      io.to(code).emit('game:take', take);
      nextTurn(room, io);
      return;
    }

    case 'deliberation': {
      let voted = false;
      // A re-vote restricts the ballot to the tied players (§8); outside one,
      // anyone still in the game is fair game.
      const candidates =
        room.revoteCandidates ?? activePlayers(room).map((p) => p.id);

      for (const bot of bots) {
        if (!bot.bot) continue;
        if (room.votes[bot.id]) continue;
        if (!activePlayers(room).some((p) => p.id === bot.id)) continue;

        if (bot.bot.voteAt === 0) {
          bot.bot.voteAt = now + botVoteDelay();
          continue;
        }
        if (now < bot.bot.voteAt) continue;

        const target = botVoteTarget(candidates, bot.id, room.votes);
        if (!target) continue;
        // Through castVote, so every eligibility rule that applies to a
        // player applies here — including the ones a re-vote adds.
        if (castVote(room, bot.id, target).ok) {
          voted = true;
          // Re-arm rather than leaving a past deadline behind: on a tie the
          // swing voters' ballots are cleared and they vote again, and a
          // stale deadline would make all of them recast in the same tick
          // with nothing on the board to bandwagon onto.
          bot.bot.voteAt = 0;
        }
      }

      if (voted) {
        broadcastTally(room, io);
        if (pendingVoters(room).length === 0) concludeVote(room, io);
      }
      return;
    }

    default:
      // Lobby and results: bots idle. Their per-round scheduling is reset by
      // whatever starts the next round, not here.
      return;
  }
}

/** Wipes per-round bot scheduling so a second round does not inherit it. */
function resetBotRuntimes(room: RoomState) {
  for (const player of room.players) {
    if (player.isBot) player.bot = freshBotRuntime();
  }
}

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
      ? room.imposterVideoEndedAt + readyGraceSeconds(room) * 1000
      : null,
  });
}

/**
 * Publishes one reaction to the room (§5), throttle included.
 *
 * Shared by the `game:react` handler and the bot driver so the two cannot
 * drift: a simulated reaction is byte-identical to a real one, which is the
 * only way testing with bots says anything about the real thing. Returns
 * whether it went out — the throttle is the usual reason it does not.
 */
function broadcastReaction(
  room: RoomState,
  player: Player,
  emoji: ReactionEmoji,
  io: Server
): boolean {
  const now = Date.now();
  if (player.lastReactionAt && now - player.lastReactionAt < REACTION_MIN_INTERVAL_MS) {
    return false;
  }
  player.lastReactionAt = now;

  const reaction: GameReaction = {
    playerId: player.id,
    playerName: player.name,
    emoji,
    timestamp: now,
    // Two reactions can share a millisecond across players; the client keys
    // its floating animations off this.
    id: `${player.id}-${now}-${Math.random().toString(36).slice(2, 7)}`,
  };

  // Back to the sender too, deliberately: everyone sees the same set of
  // reactions float, so what you sent looks to you exactly like what it
  // looks like to the room.
  io.to(room.code).emit('game:reaction', reaction);
  return true;
}

/**
 * How long the room waits on stragglers before advancing itself.
 *
 * A video round measures this from the imposter's tape ending, so 10s is a
 * nudge for someone who has already watched the whole thing. A prompt round
 * has no tape: the clock starts the moment the card appears and the read *is*
 * the phase, so it has to be long enough to think of an answer to a question.
 * Everyone clicking Ready still ends it early, which is the normal case.
 */
function readyGraceSeconds(room: RoomState): number {
  return isPromptStyle(room.settings.videoCategory)
    ? PROMPT_READ_SECONDS
    : READY_GRACE_SECONDS;
}

/** Starts the countdown that ends the watch/read phase on its own. */
function startReadyGrace(room: RoomState, io: Server) {
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== 'playing') {
      clearRoomTimer(room.code);
      return;
    }
    const deadline =
      (current.imposterVideoEndedAt ?? 0) + readyGraceSeconds(current) * 1000;
    if (Date.now() >= deadline) {
      startWordPhase(current, io);
    }
  });
}

/**
 * One player's half of the round, and nothing else.
 *
 * The single place either half of a pair is allowed to leave the server, so
 * the secrecy invariant is one function wide. Crew and suspect get an
 * identical shape — no role flag, no hint of which half this is (section 3).
 */
/** Points per stroke. Generous for a drawn curve, short of a denial-of-canvas. */
const STROKE_MAX_POINTS = 400;

/**
 * A stable colour per player for the shared canvas.
 *
 * Derived from their seat in `turnOrder` rather than stored, so it survives a
 * reconnect without another field to keep in step, and every client that
 * replays `room.strokes` paints them the same. Being able to read who drew
 * what is the point: an out-of-place stroke is only evidence if you can say
 * whose it was.
 *
 * Carries no role information — the fake's colour is drawn from the same list
 * in the same way.
 */
const STROKE_COLOURS = [
  '#012442', '#E02D5C', '#1A5FAA', '#3EC63E', '#F7C434',
  '#9D6EFF', '#F29B3B', '#00C9FF', '#E44FA0', '#2ECC56',
];

function strokeColour(room: RoomState, playerId: string): string {
  const seat = room.turnOrder.indexOf(playerId);
  const index = seat >= 0 ? seat : room.players.findIndex((p) => p.id === playerId);
  return STROKE_COLOURS[Math.max(0, index) % STROKE_COLOURS.length];
}

function assignmentFor(room: RoomState, playerId: string): GameAssignment {
  const isImposter = room.imposterIds.includes(playerId);

  // Fake Artist is the one mode that tells a player their own role — see the
  // note on GameAssignment.isFake. The crew get the word and no theme; the fake
  // gets the theme (when the setting is on) and never the word. Handing the
  // crew the theme as well would tell them how much the fake knows, which is
  // the difficulty dial the host just set.
  if (room.drawWord) {
    if (isImposter) {
      return {
        isFake: true,
        ...(room.settings.themeHint ? { themeHint: room.drawWord.theme } : {}),
      };
    }
    return { drawWord: room.drawWord.word };
  }

  // Wavelength: the spectrum is public and rides room:updated. The only thing
  // dealt privately is the target, and only to the psychic — everyone else's
  // assignment is deliberately empty rather than absent, so the two shapes stay
  // indistinguishable in the network tab.
  if (room.spectrum) {
    return playerId === room.psychicId
      ? { isPsychic: true, target: room.spectrumTarget ?? 50 }
      : {};
  }

  if (room.prompts) {
    return { prompt: isImposter ? room.prompts.imposter : room.prompts.normal };
  }
  return {
    videoUrl: isImposter ? room.settings.imposterVideoUrl : room.settings.normalVideoUrl,
  };
}

// ─── Word phase (section 7) ──────────────────────────────────────────────────

/**
 * Leaves the watch/read phase for whatever comes next.
 *
 * Normally that is the word phase. With text chat off there is no word phase
 * at all — it is a turn-based typing round, and this lobby has turned typing
 * off — so the round goes straight to the eject vote on a longer clock. Every
 * caller that used to reach for startWordPhase goes through here, including
 * round 2 of a 2-imposter game.
 */
function startWordPhase(room: RoomState, io: Server) {
  clearRoomTimer(room.code);
  if (skipsWordPhase(room)) {
    startDeliberation(room, io);
    return;
  }
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

// ─── Wavelength phases ──────────────────────────────────────────────────────
// Both phases run on the single per-room timer slot, like every other phase.
// A clue that never arrives ends the round rather than hanging the lobby: the
// psychic dropping out is the one failure this mode cannot route around, since
// nobody else can see the target.

function emitCluePhaseStart(room: RoomState, io: Server) {
  io.to(room.code).emit('game:cluePhaseStart', {
    ...sanitizeRoom(room),
    psychicId: room.psychicId,
    secondsLeft: room.turnTimeLeft,
  });
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== 'clue') {
      clearRoomTimer(room.code);
      return;
    }
    current.turnTimeLeft--;
    if (current.turnTimeLeft <= 0) {
      // No clue means no round. Score it out at zero rather than opening a
      // guess phase on an empty prompt.
      beginGuessPhase(current, '(no clue given)');
      finalizeSpectrumResults(current, io);
      return;
    }
    io.to(room.code).emit('game:clueTick', { secondsLeft: current.turnTimeLeft });
  });
}

function emitGuessPhaseStart(room: RoomState, io: Server) {
  io.to(room.code).emit('game:guessPhaseStart', {
    ...sanitizeRoom(room),
    clue: room.psychicClue,
    secondsLeft: room.turnTimeLeft,
    totalGuessers: guessers(room).length,
  });
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== 'guessing') {
      clearRoomTimer(room.code);
      return;
    }
    current.turnTimeLeft--;
    if (current.turnTimeLeft <= 0) {
      finalizeSpectrumResults(current, io);
      return;
    }
    io.to(room.code).emit('game:guessTick', {
      secondsLeft: current.turnTimeLeft,
      guessesIn: Object.keys(current.guesses).length,
      totalGuessers: guessers(current).length,
    });
  });
}

// ─── Bluff Definitions phases ───────────────────────────────────────────────

function emitWritingPhaseStart(room: RoomState, io: Server) {
  io.to(room.code).emit('game:writingPhaseStart', {
    ...sanitizeRoom(room),
    word: room.bluffWord?.word ?? '',
    secondsLeft: room.turnTimeLeft,
    totalWriters: activePlayers(room).length,
  });
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== 'writing') {
      clearRoomTimer(room.code);
      return;
    }
    current.turnTimeLeft--;
    if (current.turnTimeLeft <= 0) {
      startBluffVote(current, io);
      return;
    }
    io.to(room.code).emit('game:writingTick', {
      secondsLeft: current.turnTimeLeft,
      writtenIn: Object.keys(current.definitions).length,
      totalWriters: activePlayers(current).length,
    });
  });
}

/**
 * Opens the ballot.
 *
 * The options carry text and an id and **no author** — that mapping is the
 * game, and it is attached only in the results payload. The id doubles as the
 * author's player id, which is what lets a player be refused a vote for their
 * own fake without the client having to be told whose is whose.
 */
function startBluffVote(room: RoomState, io: Server) {
  clearRoomTimer(room.code);
  // Anyone who never submitted is skipped rather than given a blank option:
  // an empty entry on the ballot is obviously not the real definition, so it
  // would narrow the field for free.
  beginBluffVote(room, REAL_DEFINITION_ID);
  const options = room.bluffOrder.map((id) => ({
    id,
    text: id === REAL_DEFINITION_ID ? (room.bluffWord?.definition ?? '') : room.definitions[id],
  }));
  io.to(room.code).emit('game:bluffVoteStart', {
    ...sanitizeRoom(room),
    word: room.bluffWord?.word ?? '',
    options,
    secondsLeft: room.turnTimeLeft,
    totalVoters: activePlayers(room).length,
  });
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== 'bluffvote') {
      clearRoomTimer(room.code);
      return;
    }
    current.turnTimeLeft--;
    if (current.turnTimeLeft <= 0) {
      finalizeBluffResults(current, io);
      return;
    }
    io.to(room.code).emit('game:bluffVoteTick', {
      secondsLeft: current.turnTimeLeft,
      votesIn: Object.keys(current.bluffVotes).length,
      totalVoters: activePlayers(current).length,
    });
  });
}

/**
 * Its own event rather than a flag on `game:wordPhaseStart`, because the two
 * phases put entirely different screens up and `useRoom` has to know which
 * without inspecting the mode. The payload is otherwise identical — the turn
 * engine underneath is the same one.
 */
function emitDrawPhaseStart(room: RoomState, io: Server) {
  io.to(room.code).emit('game:drawPhaseStart', {
    ...sanitizeRoom(room),
    turnOrder: room.turnOrder,
    activePlayerId: room.activePlayerId,
    turnTimeLeft: room.turnTimeLeft,
    strokesPerPlayer: room.settings.wordsPerPlayer,
  });

  if (room.activePlayerId) startTurnTimer(room, io);
  else startDeliberation(room, io);
}

// ─── Choicer Voicer ─────────────────────────────────────────────────────────

/**
 * Announces the performance round.
 *
 * Its own event rather than a flag on `game:wordPhaseStart`, for the reason
 * `game:drawPhaseStart` is: the screens are nothing alike and `useRoom` has to
 * route without inspecting the mode. The turn engine underneath is the same one
 * — this payload is the draw phase's with the line in place of the stroke
 * allowance.
 */
function emitVoicePhaseStart(room: RoomState, io: Server) {
  io.to(room.code).emit('game:voicePhaseStart', {
    ...sanitizeRoom(room),
    turnOrder: room.turnOrder,
    activePlayerId: room.activePlayerId,
    turnTimeLeft: room.turnTimeLeft,
    turnIndex: room.turnIndex,
    takesPerPlayer: turnsPerPlayer(room),
    // The room is hearing the original together and nobody is up yet. The
    // client cannot infer this from a null activePlayerId alone — that is also
    // what a finished phase looks like.
    listening: isListening(room),
  });

  // The listen beat and a turn run on the same clock, because the beat *is* a
  // turn that has not started: startTurnTimer's tick calls nextTurn at zero,
  // and nextTurn's advanceTurn walks -1 -> 0, which is the ordinary step from
  // one turn to the next.
  if (isListening(room) || room.activePlayerId) startTurnTimer(room, io);
  else finalizeVoiceResults(room, io);
}

function startTurnTimer(room: RoomState, io: Server) {
  // All three turn-taking phases run on this timer. The guard has to capture
  // the phase it was armed in rather than testing for one, or a drawing or
  // performance turn's first tick sees phase !== 'words', clears itself, and
  // the round sits on player one forever.
  const phase = room.phase;
  setRoomTimer(room.code, () => {
    const current = getRoom(room.code);
    if (!current || current.phase !== phase) {
      clearRoomTimer(room.code);
      return;
    }
    current.turnTimeLeft--;
    if (current.turnTimeLeft <= 0) {
      // Section 7: timing out auto-skips with a blank word. On the Choicer
      // Voicer listen beat it is not a skip at all — it is the step onto
      // player one, which advanceTurn makes from turnIndex -1.
      nextTurn(current, io);
    } else if (isListening(current)) {
      broadcastListenTick(current, io);
    } else {
      broadcastTurnState(current, io);
    }
  });
}

function nextTurn(room: RoomState, io: Server) {
  const hasMore = advanceTurn(room);
  if (!hasMore) {
    // A performance round is scored, not accused: the turn order running out is
    // the end of the game, not the start of a ballot. Branching on the phase
    // rather than on the mode id keeps this one line honest for any future
    // turn-based scored mode.
    if (room.phase === 'voicing') finalizeVoiceResults(room, io);
    else startDeliberation(room, io);
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

/**
 * The listen beat ticks so every client shows the same countdown.
 *
 * Its own emit rather than `broadcastTurnState`, which is a turn-engine payload
 * and would say "nobody is up" — true, but indistinguishable from a phase that
 * has run out of players.
 */
function broadcastListenTick(room: RoomState, io: Server) {
  io.to(room.code).emit('game:listenTick', { secondsLeft: room.turnTimeLeft });
}

// ─── Deliberation (section 8) ────────────────────────────────────────────────

function startDeliberation(room: RoomState, io: Server) {
  clearRoomTimer(room.code);
  beginDeliberation(room);

  io.to(room.code).emit('game:deliberationStart', {
    ...sanitizeRoom(room),
    endsAt: room.deliberationEndsAt,
    durationSeconds: deliberationSeconds(room),
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
    // Round 2 skips the word phase on the same rule as round 1 — otherwise a
    // text-off lobby would get no words in round 1 and a full turn order in
    // round 2, which is the worst of both.
    if (skipsWordPhase(room)) startDeliberation(room, io);
    else emitWordPhaseStart(room, io);
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
    durationSeconds: deliberationSeconds(room),
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

/**
 * Every timer that could still fire at a room, stopped.
 *
 * Three separate maps by design — the phase timer is one slot per room, drops
 * are one per player inside their grace window, and the bot ticker is its own
 * because the phase machine already owns the first. A room that goes away has
 * to clear all three or intervals tick against state that no longer exists.
 */
function stopRoomTicking(code: string) {
  clearRoomTimer(code);
  clearRoomDrops(code);
  clearBotTicker(code);
}

/**
 * Shuts a lobby down under everyone in it.
 *
 * Reuses `room:kicked` rather than adding an event: the client already maps it
 * to `isKicked` and routes those players back to /dashboard, which is exactly
 * where a closed lobby should leave them. `exceptSocketId` spares the socket
 * that asked for the closure — it is on its way somewhere else already.
 */
function closeRoom(room: RoomState, io: Server, reason: string, exceptSocketId?: string) {
  const code = room.code;
  for (const player of room.players) {
    // Emitting to player.id addresses nothing — a player is a browser, the
    // socket is the transport. See CLAUDE.md.
    if (!player.socketId || player.socketId === exceptSocketId) continue;
    const target = io.sockets.sockets.get(player.socketId);
    if (!target) continue;
    target.emit('room:kicked', { reason });
    target.leave(code);
  }
  stopRoomTicking(code);
  deleteRoom(code);
  io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
}

/**
 * Takes a player out of a room for good and repairs whatever they were part of.
 *
 * Two callers, and the difference between them is only how they got here: the
 * grace window expiring on a dropped socket, and someone pressing LEAVE. The
 * room does not care which — in both cases the seat is now empty.
 */
function finalizeDrop(room: RoomState, playerId: string, io: Server, note = 'did not return to') {
  const code = room.code;
  const turnIndex = room.turnOrder.indexOf(playerId);

  const updatedRoom = removePlayer(code, playerId);
  if (!updatedRoom) {
    // That was the last one — the room is gone, so nothing may keep ticking.
    // Includes the bot-only case: removePlayer drops simulated players once
    // the last human goes, precisely so this branch is reached.
    stopRoomTicking(code);
    io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
    console.log(`[Socket] ${playerId} left ${code} empty (room closed)`);
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
  console.log(`[Socket] ${playerId} ${note} ${code} — removed`);
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
    // Same one-half-only rule as the live deal — a reconnect must not be a
    // way to see the other card.
    if (!player.isSpectator) socket.emit('game:assigned', assignmentFor(room, playerId));
    broadcastReadyState(room, io);
    return;
  }

  // A drawing round replays the card and the whole canvas. Both are needed:
  // the card because it is on screen for the entire phase, and the strokes
  // because the picture *is* the evidence — coming back to a blank canvas is
  // worse than not coming back. `assignmentFor` is still the only way either
  // half leaves the server, so a reconnect is not a way to see the other one.
  if (room.phase === 'drawing') {
    socket.emit('game:assigned', assignmentFor(room, playerId));
    socket.emit('game:drawPhaseStart', {
      ...sanitizeRoom(room),
      turnOrder: room.turnOrder,
      activePlayerId: room.activePlayerId,
      turnTimeLeft: room.turnTimeLeft,
      strokesPerPlayer: room.settings.wordsPerPlayer,
    });
    socket.emit('game:strokeHistory', { strokes: room.strokes });
    socket.emit('game:turnState', {
      activePlayerId: room.activePlayerId,
      turnTimeLeft: room.turnTimeLeft,
      turnIndex: room.turnIndex,
      wordsUsed: room.wordsUsed,
    });
    return;
  }

  // A performance round replays the line and every take so far. The takes are
  // the round's whole visible state — the leaderboard builds as people go — so
  // coming back to an empty board would look like the round had restarted.
  // Nothing private is replayed because nothing is dealt privately here.
  if (room.phase === 'voicing') {
    socket.emit('game:voicePhaseStart', {
      ...sanitizeRoom(room),
      turnOrder: room.turnOrder,
      activePlayerId: room.activePlayerId,
      turnTimeLeft: room.turnTimeLeft,
      turnIndex: room.turnIndex,
      takesPerPlayer: turnsPerPlayer(room),
      listening: isListening(room),
    });
    socket.emit('game:takeHistory', { takes: room.takes });
    socket.emit('game:turnState', {
      activePlayerId: room.activePlayerId,
      turnTimeLeft: room.turnTimeLeft,
      turnIndex: room.turnIndex,
      wordsUsed: room.wordsUsed,
    });
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
    // On a drawing round the picture is what deliberation argues over, exactly
    // as the words are on a word round. It has to come back with them.
    if (room.drawWord) {
      socket.emit('game:assigned', assignmentFor(room, playerId));
      socket.emit('game:strokeHistory', { strokes: room.strokes });
    }
    socket.emit('game:deliberationStart', {
      ...sanitizeRoom(room),
      endsAt: room.deliberationEndsAt,
      durationSeconds: deliberationSeconds(room),
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
        durationSeconds: deliberationSeconds(room),
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
          themeHint?: boolean;
          videoCategory?: string | null;
        },
        callback: (res: { success: boolean; code?: string; error?: string }) => void
      ) => {
        const code = generateRoomCode();
        const playerId = durableId(data.playerId, socket);
        const userId = (socket.data.userId as string | null) ?? null;

        // One open lobby per host. Pressing HOST while you already have one
        // means you got here from a second window — the first is superseded
        // rather than left running, which is also what stops a stale lobby
        // blocking the new one. Note socket.data.userId is filled in by an
        // async verify: if it has not landed, this falls through to the
        // player-id branch, which can only ever scope the rule more narrowly.
        const existing = findRoomHostedBy(userId, playerId);
        if (existing) {
          console.log(`[Room] ${existing.code} closed — its host opened ${code}`);
          closeRoom(existing, io, 'The host opened a new lobby', socket.id);
        }

        const host: Player = {
          id: playerId,
          socketId: socket.id,
          // Verified from the session cookie, never from data.userId — this
          // is what the round's coins get credited to.
          userId,
          name: data.playerName,
          // An avatar is a character code now, so it gets vetted at the
          // boundary like every other client-supplied field. Anything that
          // isn't one — including the emoji older clients still send —
          // resolves to a stable character rather than being rejected.
          avatar: toAvatarCode(data.avatar),
          cosmetics: sanitizeCosmetics(data.cosmetics),
          isHost: true,
          isReady: false,
          isSpectator: false,
          status: 'connected',
        };

        const settings: RoomSettings = {
          isPublic: data.isPublic,
          // A new lobby always starts on the pool. Custom is a deliberate
          // choice made in front of the roster, where the lobby can see who is
          // about to sit out — not something a room can be born holding.
          useCustomContent: !!data.normalVideoUrl || !!data.imposterVideoUrl,
          normalVideoUrl: data.normalVideoUrl || '',
          imposterVideoUrl: data.imposterVideoUrl || '',
          customNormalPrompt: '',
          customImposterPrompt: '',
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
          // Fake Artist default: hint ON. Drawing blind is the harder variant
          // and a lobby should not meet it without choosing it.
          themeHint: data.themeHint !== false,
          // An unrecognised genre falls back to null, which means "host supplies
          // the URLs" — never a silent pick from some other shelf.
          videoCategory: isKnownCategory(data.videoCategory) ? data.videoCategory! : null,
        };

        const room = createRoom(code, host, settings);
        // Custom links supplied at creation belong to the host who typed them.
        if (settings.normalVideoUrl || settings.imposterVideoUrl) {
          room.customContentAuthorId = host.id;
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

        // ── One socket, one player row ──
        // This connection announcing a different id means whoever it was here
        // as is a phantom: nothing can drive that row any more, but the room
        // still counts it, so every "all players ready" gate waits on somebody
        // who can no longer answer. Cleared ahead of all three branches below —
        // including before the full/phase guards, so a phantom can never be
        // what makes a room look full.
        const phantoms = dropStaleSocketRows(room, socket.id, playerId);
        if (phantoms.length > 0) {
          console.warn(
            `[Room] ${data.code}: cleared ${phantoms.length} duplicate row(s) held by ${socket.id}`
          );
        }

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
          avatar: toAvatarCode(data.avatar),
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
        useCustomContent?: boolean;
        normalVideoUrl?: string;
        imposterVideoUrl?: string;
        customNormalPrompt?: string;
        customImposterPrompt?: string;
        wordsPerPlayer?: number;
        maxPlayers?: number;
        imposterCount?: number;
        chatType?: RoomSettings['chatType'];
        voteVisibility?: RoomSettings['voteVisibility'];
        videoCategory?: string | null;
        themeHint?: boolean;
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
          // Never below the people already in the room, never outside 3–10.
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
        if (data.themeHint !== undefined) room.settings.themeHint = !!data.themeHint;
        if (data.videoCategory !== undefined) {
          // 'custom' is no longer a mode. A client still holding the old card
          // is asking for custom content, not for a genre — translate it here
          // rather than letting isKnownCategory quietly drop it, which would
          // land that lobby on "no mode at all" with the switch still off.
          if (data.videoCategory === CUSTOM_CATEGORY) {
            room.settings.useCustomContent = true;
          }
          const next = isKnownCategory(data.videoCategory) ? data.videoCategory! : null;
          if (next !== room.settings.videoCategory) {
            // A mode change invalidates whatever is loaded. Leftover URLs from
            // the last round would otherwise let the next one start on them,
            // and a word pair typed for Words is not a question for Questions.
            room.settings.normalVideoUrl = '';
            room.settings.imposterVideoUrl = '';
            room.settings.customNormalPrompt = '';
            room.settings.customImposterPrompt = '';
          }
          room.settings.videoCategory = next;
        }
        // Applied after the mode so content in the same payload wins over the
        // clear above.
        if (data.useCustomContent !== undefined) {
          room.settings.useCustomContent = !!data.useCustomContent;
          if (data.useCustomContent) {
            // Switching it on is itself the act of taking the round on (§4):
            // whoever flips it is the one about to write both halves, so they
            // are the author from this moment rather than from the first
            // keystroke. Assigning it here is what makes the sit-out — and the
            // one extra head the lobby now needs — visible before anything is
            // typed, instead of appearing under the roster mid-sentence.
            room.customContentAuthorId = actorId(socket);
          } else {
            // Turning it off drops what was typed. Keeping it would let a
            // second press of the switch put a pair back that the lobby has
            // since been told is gone — and the author would silently be a
            // spectator again.
            room.settings.normalVideoUrl = '';
            room.settings.imposterVideoUrl = '';
            room.settings.customNormalPrompt = '';
            room.settings.customImposterPrompt = '';
            room.customContentAuthorId = null;
          }
        }
        if (data.normalVideoUrl !== undefined) room.settings.normalVideoUrl = data.normalVideoUrl;
        if (data.imposterVideoUrl !== undefined) room.settings.imposterVideoUrl = data.imposterVideoUrl;
        // Same sanitising rule as every other free-text field at this boundary:
        // trimmed, capped, and never trusted for length. 120 is a question with
        // room to breathe and still one line on a card.
        if (data.customNormalPrompt !== undefined) {
          room.settings.customNormalPrompt = String(data.customNormalPrompt).trim().slice(0, MAX_PROMPT_LENGTH);
        }
        if (data.customImposterPrompt !== undefined) {
          room.settings.customImposterPrompt = String(data.customImposterPrompt).trim().slice(0, MAX_PROMPT_LENGTH);
        }
        if (
          data.normalVideoUrl ||
          data.imposterVideoUrl ||
          data.customNormalPrompt ||
          data.customImposterPrompt
        ) {
          // Whoever typed it has seen both halves and sits out (§4).
          room.customContentAuthorId = actorId(socket);
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
          is_bot: 'A simulated player cannot host — it would strand the lobby',
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

    // ─── Room: Leave ────────────────────────────────────────────────
    // Walking out on purpose, as opposed to dropping. The distinction matters:
    // a dropped socket keeps its seat, its vote and its role for the grace
    // window because it will probably be back, but someone who pressed LEAVE
    // will not be, so the seat goes now and the room is reaped if that was
    // the last of them.
    //
    // This event has to exist at all because the socket is a singleton that
    // survives client-side navigation — routing away from /room/[code] does
    // not disconnect anything, so without this a lobby you walked out of goes
    // on holding you (and itself) open until you close the tab.
    socket.on('room:leave', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room) return;
      const playerId = actorId(socket);
      if (!room.players.some((p) => p.id === playerId)) return;

      // Leaving is not dropping — nothing should be waiting to reinstate them.
      cancelDrop(data.code, playerId);
      socket.leave(data.code);
      finalizeDrop(room, playerId, io, 'left');
    });

    // ─── Testing: fill the lobby with simulated players ─────────────
    // Host only, lobby only, and only when the server was started with bots
    // enabled — see BOTS_ENABLED. `count` is a request, not a promise: the
    // room's own size limit is what actually decides.
    socket.on(
      'room:addBots',
      (
        data: { code: string; count?: number },
        callback?: (res: { success: boolean; added?: number; error?: string }) => void
      ) => {
        if (!BOTS_ENABLED) {
          callback?.({ success: false, error: 'Simulated players are disabled on this server' });
          return;
        }
        const room = getRoom(data.code);
        if (!room) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }
        if (room.hostId !== actorId(socket)) {
          callback?.({ success: false, error: 'Only the host can add players' });
          return;
        }
        // Lobby only. Adding a player mid-round would land them outside
        // `turnOrder` and outside the imposter draw — a spectator with a
        // vote, which is not a state the real game has.
        if (room.phase !== 'lobby') {
          callback?.({ success: false, error: 'Only in the lobby, between rounds' });
          return;
        }

        // Default: enough to make the round startable, which is what the
        // button is for. A custom round needs one extra, since whoever typed
        // the content sits out (§4).
        const sittingOut =
          usesCustomContent(room) && room.customContentAuthorId
            ? room.players.some((p) => p.id === room.customContentAuthorId)
            : false;
        const playingNow = room.players.length - (sittingOut ? 1 : 0);
        const wanted =
          typeof data.count === 'number' && Number.isFinite(data.count)
            ? Math.floor(data.count)
            : MIN_PLAYERS - playingNow;

        const room_space = room.settings.maxPlayers - room.players.length;
        const toAdd = Math.max(0, Math.min(wanted, room_space, MAX_PLAYERS));
        if (toAdd === 0) {
          callback?.({
            success: false,
            error: room_space <= 0 ? 'Lobby is full' : 'Nothing to add',
          });
          return;
        }

        // Index from the current roster so a second press keeps walking the
        // name list rather than dealing a second ROXY.
        const existingBots = room.players.filter((p) => p.isBot).length;
        for (let i = 0; i < toAdd; i += 1) {
          addPlayer(data.code, makeBot(existingBots + i));
        }

        io.to(data.code).emit('room:updated', sanitizeRoom(room));
        io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
        console.log(`[Bots] ${data.code}: added ${toAdd} simulated player(s)`);
        callback?.({ success: true, added: toAdd });
      }
    );

    socket.on(
      'room:removeBots',
      (
        data: { code: string },
        callback?: (res: { success: boolean; removed?: number; error?: string }) => void
      ) => {
        const room = getRoom(data.code);
        if (!room || room.hostId !== actorId(socket)) {
          callback?.({ success: false, error: 'Only the host can do that' });
          return;
        }
        if (room.phase !== 'lobby') {
          callback?.({ success: false, error: 'Only in the lobby, between rounds' });
          return;
        }
        const removed = removeBots(room);
        clearBotTicker(data.code);
        io.to(data.code).emit('room:updated', sanitizeRoom(room));
        io.emit('rooms:updated', getPublicRooms().map(sanitizeRoom));
        callback?.({ success: true, removed });
      }
    );

    // ─── Game: Start ────────────────────────────────────────────────
    socket.on('game:start', (data: { code: string }) => {
      const room = getRoom(data.code);
      if (!room || room.hostId !== actorId(socket)) return;

      // Section 4: on a custom round the player who supplied the content sits
      // out, so that lobby needs one more head than a pool one to reach the
      // same number of actual players. Work the checks off that count — and off
      // who is actually on the line, since a player inside their reconnect
      // window cannot be dealt a tape.
      const genre = room.settings.videoCategory;
      const promptRound = isPromptStyle(genre);
      const drawRound = isDrawStyle(genre);
      const spectrumRound = isSpectrumStyle(genre);
      const bluffRound = isBluffStyle(genre);
      const voiceRound = isVoiceStyle(genre);
      // Custom is a switch on the mode now, not a mode — and it only bites on
      // the two styles that have a pair to type. Fake Artist, Wavelength and
      // Bluff always draw from their own pool, so nobody sits out.
      const isCustomRound = usesCustomContent(room);
      const present = connectedPlayers(room);
      const sittingOut =
        isCustomRound && room.customContentAuthorId
          ? present.find((p) => p.id === room.customContentAuthorId)
          : undefined;
      const playingCount = present.length - (sittingOut ? 1 : 0);

      if (playingCount < MIN_PLAYERS) {
        socket.emit('game:error', {
          message: sittingOut
            ? `Need ${MIN_PLAYERS} players besides ${sittingOut.name}, who is supplying the round`
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

      // Draw the round's odd one out. Two shapes, one rule: the crew's half
      // and the suspect's half are decided here, on the server, and neither
      // ever appears in a room broadcast.
      let promptPair: { normal: string; imposter: string } | null = null;
      let drawPick: { word: string; theme: string } | null = null;
      let spectrumPick: { left: string; right: string; target: number } | null = null;
      let bluffPick: { word: string; definition: string } | null = null;
      let voicePick: { line: RoomState['voiceLine']; reference: number[] | null } | null = null;

      if (voiceRound) {
        const pick = pickVoiceLine(room.usedVideoIds);
        if (!pick) {
          socket.emit('game:error', {
            message: 'The Choicer Voicer deck needs at least one line configured',
          });
          return;
        }
        const line = publicLine(pick.entry);
        voicePick = {
          line: {
            id: line.id,
            quote: line.quote,
            source: line.source,
            audio: line.audio,
            youtubeId: line.youtubeId,
            startSeconds: line.startSeconds,
            endSeconds: line.endSeconds,
            peaks: line.peaks,
            // Renamed at the boundary on purpose: the library calls it
            // "has a reference", the room calls it what it means to a player.
            scoredAgainstOriginal: line.hasReference,
          },
          reference: pick.entry.fingerprint,
        };
        room.usedVideoIds = pick.usedIds;
        console.log(
          `[Voicer] ${data.code}: ${pick.entry.id} ` +
            (pick.entry.fingerprint ? 'vs the original' : 'vs the room (no reference)') +
            (pick.recycled ? ' (pool exhausted, history recycled)' : '')
        );
      } else if (bluffRound) {
        const pick = pickBluffWord(room.usedVideoIds);
        if (!pick) {
          socket.emit('game:error', {
            message: 'The Bluff deck needs at least one word configured',
          });
          return;
        }
        bluffPick = { word: pick.entry.word, definition: pick.entry.definition };
        room.usedVideoIds = pick.usedIds;
        console.log(
          `[Bluff] ${data.code}: ${pick.entry.id}` +
            (pick.recycled ? ' (pool exhausted, history recycled)' : '')
        );
      } else if (spectrumRound) {
        const pick = pickSpectrum(room.usedVideoIds);
        if (!pick) {
          socket.emit('game:error', {
            message: 'The Wavelength deck needs at least one spectrum configured',
          });
          return;
        }
        spectrumPick = { left: pick.entry.left, right: pick.entry.right, target: pick.target };
        room.usedVideoIds = pick.usedIds;
        console.log(
          `[Wavelength] ${data.code}: ${pick.entry.id} target ${pick.target}` +
            (pick.recycled ? ' (pool exhausted, history recycled)' : '')
        );
      } else if (drawRound) {
        // One word for the whole crew — there is no pair here, because the
        // fake is told they are the fake rather than handed a near miss.
        const pick = pickDrawWord(room.usedVideoIds);
        if (!pick) {
          socket.emit('game:error', {
            message: 'The Fake Artist deck needs at least one word configured',
          });
          return;
        }
        drawPick = { word: pick.entry.word, theme: pick.entry.theme };
        room.usedVideoIds = pick.usedIds;
        console.log(
          `[FakeArtist] ${data.code}: ${pick.entry.id}` +
            (pick.recycled ? ' (pool exhausted, history recycled)' : '')
        );
      } else if (promptRound && isCustomRound) {
        // The host's own pair. Same rule as the authored file it replaces: two
        // halves written together, so they are comparable — which is why this
        // takes both or neither rather than filling a blank from the pool.
        const normal = room.settings.customNormalPrompt.trim();
        const imposter = room.settings.customImposterPrompt.trim();
        if (!normal || !imposter) {
          socket.emit('game:error', { message: 'Both custom cards must be filled in first' });
          return;
        }
        promptPair = { normal, imposter };
        console.log(`[Prompts] ${data.code} ${genre}: host-supplied pair`);
      } else if (promptRound) {
        // One authored pair, not two independent picks — see promptLibrary.
        const pick = pickPromptPair(genre!, room.usedVideoIds);
        if (!pick) {
          socket.emit('game:error', {
            message: `The ${genre} deck needs at least one pair configured`,
          });
          return;
        }
        promptPair = { normal: pick.pair.normal, imposter: pick.pair.imposter };
        room.usedVideoIds = pick.usedIds;
        console.log(
          `[Prompts] ${data.code} ${genre}: ${pick.pair.id}` +
            (pick.recycled ? ' (pool exhausted, history recycled)' : '')
        );
      } else {
        // Pool genres draw two distinct clips from /content/videos.json,
        // skipping anything this lobby has already seen (section 14). With
        // custom content on, the host's own pair is already on the settings and
        // the shelf is left alone.
        if (!isCustomRound) {
          if (!genre) {
            socket.emit('game:error', { message: 'Pick a game mode first' });
            return;
          }
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
      }

      // resetRound clears per-round state but not roles, so assign after it.
      resetRound(room);
      // ...which means the pair has to be re-hung afterwards, since `prompts`
      // and `drawWord` are part of what resetRound clears.
      room.prompts = promptPair;
      room.drawWord = drawPick;
      if (spectrumPick) {
        room.spectrum = { left: spectrumPick.left, right: spectrumPick.right };
        room.spectrumTarget = spectrumPick.target;
      }
      room.bluffWord = bluffPick;
      if (voicePick) {
        room.voiceLine = voicePick.line;
        room.voiceReference = voicePick.reference;
      }
      // Must run before the imposter pick — the sitter is not a candidate.
      const spectator = assignSpectator(room, isCustomRound);
      // Section 3: both imposters watch the same secret video, so one pick of
      // N ids is all this needs.
      room.imposterIds = pickImposters(room, room.settings.imposterCount);
      room.imposterId = room.imposterIds[0];

      // Wavelength has no hidden role, so the imposter draw is undone and the
      // psychic picked in its place. This has to happen *before* the deal loop
      // below — assignmentFor reads room.psychicId, and picking afterwards
      // dealt every player the empty non-psychic assignment.
      // Bluff has no hidden role either — everybody writes, everybody votes.
      // Nor does Choicer Voicer: everybody performs the same line in the open,
      // and leaving an imposter drawn would put a name in `imposterIds`, which
      // the results screen reads as "this player was hiding" and the reward
      // table reads as a side to pay.
      if (bluffRound || voiceRound) {
        room.imposterIds = [];
        room.imposterId = null;
      }

      if (spectrumRound) {
        room.imposterIds = [];
        room.imposterId = null;
        const pool = activePlayers(room);
        room.psychicId = pool[Math.floor(Math.random() * pool.length)]?.id ?? null;
      }
      // A drawing round has no watch phase to pass through — the canvas *is*
      // the round, and the word sits on your own screen for its whole length.
      // beginDrawPhase sets the phase; everything else starts at 'playing'.
      room.phase = 'playing';
      room.gameStartedAt = Date.now();
      room.players.forEach((p) => (p.isReady = false));

      // Send each player only their own half — never their role. Section 3:
      // nobody is told whether they are Crewmate or Imposter, so the payload
      // must not carry `isImposter` even if no UI renders it; it would be
      // trivially readable from the network tab. A crew card and a suspect
      // card are the same shape for exactly that reason.
      room.players.forEach((player) => {
        // The sitter gets no tape: they chose both, so there is nothing to
        // show them and nothing they could honestly say about it.
        if (player.isSpectator || !player.socketId) return;
        io.to(player.socketId).emit('game:assigned', assignmentFor(room, player.id));
      });

      io.to(data.code).emit('room:updated', sanitizeRoom(room));

      // A prompt round has nothing to buffer and nothing to synchronise, so
      // there is no `game:play` and no per-player videoEnded to hang the
      // §6 grace off. Arm the grace from the start instead: the read is the
      // whole phase, and one player who never clicks Ready must not park the
      // lobby on a card forever.
      if (promptRound) {
        room.imposterVideoEndedAt = Date.now();
        broadcastReadyState(room, io);
        startReadyGrace(room, io);
      }

      // A drawing round skips the ready check entirely. There is nothing to
      // buffer and nothing to read — the crew's word is on their own screen
      // from here to the vote — so it opens straight onto the canvas.
      if (drawRound) {
        beginDrawPhase(room);
        emitDrawPhaseStart(room, io);
      }

      // Wavelength has no hidden role to draw for and no ballot to open. The
      // psychic is picked from the same pool pickImposters uses (active, not
      // sitting out) but kept in its own field: calling them an imposter would
      // put them in `imposterIds`, which the results screen reads as "this
      // player was hiding" and the reward table reads as a side to pay.
      if (spectrumRound && room.psychicId) {
        beginCluePhase(room, room.psychicId);
        emitCluePhaseStart(room, io);
      }

      // Bluff opens straight onto the word. There is nothing to deal privately
      // — everyone sees the same word and writes against it — so no
      // game:assigned goes out at all on this mode.
      if (bluffRound) {
        beginWritingPhase(room);
        emitWritingPhaseStart(room, io);
      }

      // Choicer Voicer opens straight onto the line, like the canvas does. No
      // Ready Check and no `game:assigned`: there is nothing dealt privately,
      // because everybody is performing the same thing and the whole point is
      // that the room can hear how far off you were.
      if (voiceRound) {
        // The listen beat only exists when there is something to listen to.
        // The listen beat is only armed when there is something to listen to —
        // either a local clip or a YouTube embed. Holding an empty screen for
        // 12 seconds on a quote-only line reads as a hang.
        beginVoicePhase(room, !!(room.voiceLine?.audio || room.voiceLine?.youtubeId));
        emitVoicePhaseStart(room, io);
      }

      // Simulated players only act once a round is under way. Reset first:
      // a second round through the same lobby must not inherit round one's
      // "already reacted / already voted" deadlines.
      if (room.players.some((p) => p.isBot)) {
        resetBotRuntimes(room);
        startBotTicker(data.code, io);
      }

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

    // ─── Watch phase: live emoji reaction (section 5) ───────────────
    // Fire-and-forget: no ack, no room state, nothing persisted. A reaction
    // is a moment, and a missed one is not worth a round trip to recover.
    socket.on('game:react', (data: { code: string; emoji: string }) => {
      const room = getRoom(data.code);
      // Watch phase only. §5 puts this button on the video player, and the
      // later phases have their own channels — words are the evidence and
      // deliberation has chat, neither of which wants a second, unlogged one.
      if (!room || room.phase !== 'playing') return;

      // Closed set, checked server-side. The client renders the same five
      // buttons, but that is a convenience, not the enforcement.
      if (!isReactionEmoji(data.emoji)) return;

      const player = room.players.find((p) => p.id === actorId(socket));
      if (!player) return;
      // The Custom author has no tape playing (§4), so they have nothing to
      // react to — and a reaction from them would be reacting to the room.
      if (player.isSpectator) return;

      broadcastReaction(room, player, data.emoji, io);
    });

    // ─── Word phase: submit your word (section 7) ───────────────────
    // ─── Bluff: your fake definition ────────────────────────────────────
    socket.on('game:definition', (data: { code: string; text: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'writing') return;
      const playerId = actorId(socket);
      if (!activePlayers(room).some((p) => p.id === playerId)) return;
      // Capped like every other free-text field. 180 is enough for a plausible
      // dictionary line and short of an essay that would stand out on sight.
      const text = String(data.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 180);
      if (!text) return;

      recordDefinition(room, playerId, text);
      // Only the count — publishing a definition early would let the writers
      // after it crib the register and blend in for free.
      io.to(data.code).emit('game:writingTick', {
        secondsLeft: room.turnTimeLeft,
        writtenIn: Object.keys(room.definitions).length,
        totalWriters: activePlayers(room).length,
      });
      if (allDefinitionsIn(room)) startBluffVote(room, io);
    });

    // ─── Bluff: pick the one you think is real ──────────────────────────
    socket.on('game:bluffVote', (data: { code: string; optionId: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'bluffvote') return;
      if (!castBluffVote(room, actorId(socket), String(data.optionId ?? ''))) return;

      io.to(data.code).emit('game:bluffVoteTick', {
        secondsLeft: room.turnTimeLeft,
        votesIn: Object.keys(room.bluffVotes).length,
        totalVoters: activePlayers(room).length,
      });
      if (allBluffVotesIn(room)) finalizeBluffResults(room, io);
    });

    // ─── Wavelength: the psychic's clue ─────────────────────────────────
    socket.on('game:clue', (data: { code: string; clue: string }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'clue') return;
      if (actorId(socket) !== room.psychicId) return;
      const clue = String(data.clue ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!clue) return;
      clearRoomTimer(data.code);
      beginGuessPhase(room, clue);
      emitGuessPhaseStart(room, io);
    });

    // ─── Wavelength: everyone else dials in ─────────────────────────────
    socket.on('game:guess', (data: { code: string; value: number }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'guessing') return;
      const playerId = actorId(socket);
      // The psychic already knows the answer, so they do not get a dial.
      if (playerId === room.psychicId) return;
      if (!guessers(room).some((p) => p.id === playerId)) return;
      if (typeof data.value !== 'number' || !Number.isFinite(data.value)) return;

      recordGuess(room, playerId, data.value);
      // Only the count goes out, never the values — a published dial would let
      // everyone after the first simply copy it.
      io.to(data.code).emit('game:guessTick', {
        secondsLeft: room.turnTimeLeft,
        guessesIn: Object.keys(room.guesses).length,
        totalGuessers: guessers(room).length,
      });
      if (allGuessesIn(room)) finalizeSpectrumResults(room, io);
    });

    // ─── Fake Artist: one stroke, on your turn ──────────────────────────
    // Same shape as game:word above and deliberately so — it is the same turn
    // engine, and the two handlers must agree about when a player is out of
    // turns or the phase hangs waiting for somebody who has already gone.
    socket.on('game:stroke', (data: { code: string; points: unknown }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'drawing') return;
      const artistId = actorId(socket);
      if (room.activePlayerId !== artistId) return; // not your turn

      const player = room.players.find((p) => p.id === artistId);
      if (!player) return;
      if (playerFinishedTurn(room, artistId)) return; // quota already used

      // Sanitise the geometry like any other user input. Points arrive
      // normalised 0..1; anything outside that is either a bug or someone
      // drawing off-canvas to cover the picture, and both clamp the same way.
      if (!Array.isArray(data.points)) return;
      const points = data.points
        .slice(0, STROKE_MAX_POINTS * 2)
        .map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0));
      // Odd length would desync every x/y pair after the missing one.
      if (points.length % 2 !== 0) points.pop();
      if (points.length < 4) return; // a single point is not a stroke

      const entry: DrawStroke = {
        playerId: artistId,
        playerName: player.name,
        points,
        colour: strokeColour(room, artistId),
        strokeIndex: (room.wordsUsed[artistId] || 0) + 1,
      };
      recordStroke(room, artistId, entry);

      io.to(data.code).emit('game:stroke', entry);

      if (playerFinishedTurn(room, artistId)) {
        nextTurn(room, io);
      } else {
        broadcastTurnState(room, io);
      }
    });

    // ─── Choicer Voicer: one take, on your turn ─────────────────────────
    // Same shape as game:stroke above — the same turn engine, so the two have
    // to agree about when a player is out of turns.
    //
    // What arrives is a **fingerprint, not audio**: 384 numbers describing the
    // frequency shape of the performance. The recording itself never leaves the
    // performer's browser (see VoiceScreen), which is why this handler has no
    // size limit worth speaking of and no moderation surface.
    socket.on('game:take', (data: { code: string; fingerprint: unknown }) => {
      const room = getRoom(data.code);
      if (!room || room.phase !== 'voicing') return;
      const performerId = actorId(socket);
      if (room.activePlayerId !== performerId) return; // not your turn

      const player = room.players.find((p) => p.id === performerId);
      if (!player) return;
      if (playerFinishedTurn(room, performerId) || hasTaken(room, performerId)) return;

      // Shape-checked like any other user input at this boundary. A vector of
      // the wrong length or with junk in it is dropped rather than clamped:
      // unlike a stroke there is no sensible repair, and silently scoring a
      // malformed take would put a meaningless number on the leaderboard.
      if (!isFingerprint(data.fingerprint)) {
        socket.emit('game:error', { message: 'That take did not record cleanly — try again' });
        return;
      }
      const print = data.fingerprint;

      // On a round with a reference the score is known now. Without one it
      // cannot be — a consensus round scores each take against the average of
      // the others, which does not exist until the last player has gone — so
      // the take goes up with a null match and the table fills in at results.
      const match = room.voiceReference ? similarity(print, room.voiceReference) : null;
      const take: VoiceTake = {
        playerId: performerId,
        playerName: player.name,
        avatar: player.avatar,
        match,
        points: match === null ? 0 : scoreMatch(match),
        turnIndex: room.turnIndex,
      };
      recordTake(room, performerId, take, print);

      io.to(data.code).emit('game:take', take);
      nextTurn(room, io);
    });

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
  // Bots have nothing left to do this round, and an interval left running
  // against a finished room is exactly the leak the phase timers avoid.
  // game:start re-arms it if the re-formed lobby is filled again.
  clearBotTicker(room.code);
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
    kind: 'accusation',
    scores: null,
    spectrum: null,
    spectrumTarget: null,
    psychicId: null,
    psychicClue: null,
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
    // Both halves are safe to reveal now that voting has closed — and this is
    // the first moment either of them is: comparing the two is the reveal.
    normalVideoUrl: room.prompts || room.drawWord ? '' : room.settings.normalVideoUrl,
    imposterVideoUrl: room.prompts || room.drawWord ? '' : room.settings.imposterVideoUrl,
    normalPrompt: room.prompts?.normal ?? null,
    imposterPrompt: room.prompts?.imposter ?? null,
    // The crew's word and the fake's hint. Public only now — the whole round
    // is people trying to work out the first of these from the drawing.
    drawWord: room.drawWord?.word ?? null,
    drawTheme: room.drawWord?.theme ?? null,
    voiceLine: null,
    voiceTakes: null,
    bluffWord: null,
    bluffTruth: null,
    bluffReveal: null,
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
 * Closes a Wavelength round: score every guess, pay by points, reveal.
 *
 * Deliberately a sibling of finalizeResults rather than a branch inside it.
 * The two share only the last three lines (stash, broadcast, bank) — there is
 * no imposter to name, no ballot to tally and no accusation to eject, and
 * threading five `if (scored)` guards through the accusation builder to reuse
 * the shell would make both harder to read than either is apart.
 */
function finalizeSpectrumResults(room: RoomState, io: Server) {
  clearRoomTimer(room.code);
  const target = room.spectrumTarget ?? 50;
  const psychic = room.players.find((p) => p.id === room.psychicId);
  const dialled = guessers(room);

  const scoreLines: ScoreLine[] = dialled.map((p) => {
    const guess = room.guesses[p.id];
    if (guess === undefined) {
      return { playerId: p.id, name: p.name, avatar: p.avatar, points: 0, detail: 'never dialled in' };
    }
    const points = scoreGuess(guess, target);
    const off = Math.abs(guess - target);
    return {
      playerId: p.id,
      name: p.name,
      avatar: p.avatar,
      points,
      detail: `guessed ${guess} — ${off} off`,
    };
  });

  // The psychic is scored on how well the room read them, which is the only
  // measure that makes a clue good rather than merely clever. Rounded down so
  // a psychic cannot out-score every guesser on a split room.
  if (psychic) {
    const avg = scoreLines.length
      ? Math.floor(scoreLines.reduce((n, l) => n + l.points, 0) / scoreLines.length)
      : 0;
    scoreLines.push({
      playerId: psychic.id,
      name: psychic.name,
      avatar: psychic.avatar,
      points: avg,
      detail: `clued "${room.psychicClue ?? ''}" for ${target}`,
    });
  }
  scoreLines.sort((a, b) => b.points - a.points);

  const pointsOf = new Map(scoreLines.map((l) => [l.playerId, l.points]));
  const payload: GameResults = {
    kind: 'score',
    scores: scoreLines,
    spectrum: room.spectrum,
    spectrumTarget: target,
    psychicId: room.psychicId,
    psychicClue: room.psychicClue,
    imposterId: '',
    imposterIds: [],
    imposterName: '',
    imposterAvatar: '',
    mostVotedId: null,
    mostVotedName: '',
    accusedIds: [],
    accusedNames: [],
    imposterCount: 0,
    impostersCaught: 0,
    outcome: 'crew',
    crewWins: true,
    tally: {},
    normalVideoUrl: '',
    imposterVideoUrl: '',
    normalPrompt: null,
    imposterPrompt: null,
    drawWord: null,
    drawTheme: null,
    voiceLine: null,
    voiceTakes: null,
    bluffWord: null,
    bluffTruth: null,
    bluffReveal: null,
    players: room.players.map((p) => {
      const points = pointsOf.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        cosmetics: p.cosmetics,
        votes: 0,
        isImposter: false,
        wasAccused: false,
        isSpectator: p.isSpectator,
        coinReward: coinsForPoints(p.isSpectator, points),
      };
    }),
  };

  room.phase = 'results';
  room.lastResults = payload;
  io.to(room.code).emit('game:results', payload);
  bankRewards(room, payload);
  console.log(`[Wavelength] Results in ${room.code}: target ${target}, ${scoreLines.length} scored`);
}

/**
 * Closes a Bluff round: score the fooling and the finding, then reveal who
 * wrote what.
 *
 * Two ways to earn, which is what keeps both halves of the round live: you are
 * paid for every player your fake caught, and paid more for finding the truth.
 * A player who writes a convincing fake AND spots the real one out-scores
 * someone who only does one, without either alone being worthless.
 */
function finalizeBluffResults(room: RoomState, io: Server) {
  clearRoomTimer(room.code);
  const truth = room.bluffWord?.definition ?? '';
  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? 'Unknown';

  const votesFor: Record<string, number> = {};
  for (const optionId of Object.values(room.bluffVotes)) {
    votesFor[optionId] = (votesFor[optionId] ?? 0) + 1;
  }

  const scoreLines: ScoreLine[] = activePlayers(room).map((p) => {
    const fooled = votesFor[p.id] ?? 0;
    const foundTruth = room.bluffVotes[p.id] === REAL_DEFINITION_ID;
    const points = fooled * POINTS_PER_FOOL + (foundTruth ? POINTS_FOR_TRUTH : 0);
    const bits: string[] = [];
    if (fooled > 0) bits.push(`fooled ${fooled}`);
    if (foundTruth) bits.push('found the truth');
    return {
      playerId: p.id,
      name: p.name,
      avatar: p.avatar,
      points,
      detail: bits.length ? bits.join(', ') : 'fooled nobody, missed the truth',
    };
  });
  scoreLines.sort((a, b) => b.points - a.points);

  const reveal = room.bluffOrder.map((id) => ({
    id,
    text: id === REAL_DEFINITION_ID ? truth : (room.definitions[id] ?? ''),
    authorName: id === REAL_DEFINITION_ID ? 'THE DICTIONARY' : nameOf(id),
    isReal: id === REAL_DEFINITION_ID,
    votes: votesFor[id] ?? 0,
  }));

  const pointsOf = new Map(scoreLines.map((l) => [l.playerId, l.points]));
  const payload: GameResults = {
    kind: 'score',
    scores: scoreLines,
    spectrum: null,
    spectrumTarget: null,
    psychicId: null,
    psychicClue: null,
    imposterId: '',
    imposterIds: [],
    imposterName: '',
    imposterAvatar: '',
    mostVotedId: null,
    mostVotedName: '',
    accusedIds: [],
    accusedNames: [],
    imposterCount: 0,
    impostersCaught: 0,
    outcome: 'crew',
    crewWins: true,
    tally: {},
    normalVideoUrl: '',
    imposterVideoUrl: '',
    normalPrompt: null,
    imposterPrompt: null,
    drawWord: null,
    drawTheme: null,
    voiceLine: null,
    voiceTakes: null,
    bluffWord: room.bluffWord?.word ?? null,
    bluffTruth: truth,
    bluffReveal: reveal,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      cosmetics: p.cosmetics,
      votes: 0,
      isImposter: false,
      wasAccused: false,
      isSpectator: p.isSpectator,
      coinReward: coinsForPoints(p.isSpectator, pointsOf.get(p.id) ?? 0),
    })),
  };

  room.phase = 'results';
  room.lastResults = payload;
  io.to(room.code).emit('game:results', payload);
  bankRewards(room, payload);
  console.log(`[Bluff] Results in ${room.code}: "${room.bluffWord?.word}"`);
}

/**
 * Closes a Choicer Voicer round: settle every take, pay by points, reveal.
 *
 * A third sibling of finalizeResults, for the reason the other two are: there
 * is no imposter to name, no ballot to tally and no accusation to eject.
 *
 * The one thing this does that the others do not is *finish the scoring*. On a
 * round with an authored reference every take was already scored as it landed
 * and this only ranks them. On a consensus round nothing could be scored during
 * the phase — each take is measured against the average of everybody **else's**,
 * which is not known until the last player has gone — so the numbers are worked
 * out here. Excluding a player's own take from the average they are scored
 * against matters: leave it in and a lobby of two scores them both near 100 for
 * agreeing with themselves.
 */
function finalizeVoiceResults(room: RoomState, io: Server) {
  clearRoomTimer(room.code);
  const line = room.voiceLine;
  const reference = room.voiceReference;

  // Everyone who was in the turn order owes a take, so a player who never
  // performed lands on the table at zero rather than vanishing off it.
  const performers = activePlayers(room);
  const settled: VoiceTake[] = performers.map((p) => {
    const taken = room.takes.find((t) => t.playerId === p.id);
    const print = room.takePrints[p.id];

    if (!taken || !print) {
      return {
        playerId: p.id,
        playerName: p.name,
        avatar: p.avatar,
        match: null,
        points: 0,
        turnIndex: room.turnOrder.indexOf(p.id),
      };
    }

    if (reference) return taken;

    const others = Object.entries(room.takePrints)
      .filter(([id]) => id !== p.id)
      .map(([, v]) => v);
    // One take in the whole round has nothing to be compared with. `null`
    // rather than 0: there was no measurement, and a 0% next to a take somebody
    // actually gave reads as a verdict on it. The detail line below says so.
    if (others.length === 0) return { ...taken, match: null, points: 0 };
    const match = similarity(print, averageFingerprint(others));
    return { ...taken, match, points: scoreMatch(match) };
  });

  // Distinguishes "you never went" from "you went, but there was nobody to
  // compare you with" — both end up with a null match and they are not the
  // same thing to the player reading the table.
  const performed = new Set(room.takes.map((t) => t.playerId));

  // Points first, then the raw percentage. The tie-break is not decoration: the
  // points are four coarse bands, so a whole lobby routinely lands on the same
  // number, and ranking those arbitrarily puts 77% above 86% on a table whose
  // other column is the percentage. Every other scored mode ranks on points
  // alone because points are all it has; this one has the finer measure and
  // should use it.
  const scoreLines: ScoreLine[] = settled
    .map((t) => ({
      playerId: t.playerId,
      name: t.playerName,
      avatar: t.avatar,
      points: t.points,
      match: t.match,
      detail:
        t.match !== null
          ? `${t.match}% match${reference ? '' : ' (vs the room)'}`
          : performed.has(t.playerId)
            ? 'nobody else recorded a take to compare with'
            : 'never recorded a take',
    }))
    .sort((a, b) => b.points - a.points || (b.match ?? -1) - (a.match ?? -1))
    .map(({ match, ...line }) => line);

  const pointsOf = new Map(scoreLines.map((l) => [l.playerId, l.points]));
  const payload: GameResults = {
    kind: 'score',
    scores: scoreLines,
    spectrum: null,
    spectrumTarget: null,
    psychicId: null,
    psychicClue: null,
    imposterId: '',
    imposterIds: [],
    imposterName: '',
    imposterAvatar: '',
    mostVotedId: null,
    mostVotedName: '',
    accusedIds: [],
    accusedNames: [],
    imposterCount: 0,
    impostersCaught: 0,
    outcome: 'crew',
    crewWins: true,
    tally: {},
    normalVideoUrl: '',
    imposterVideoUrl: '',
    normalPrompt: null,
    imposterPrompt: null,
    drawWord: null,
    drawTheme: null,
    voiceLine: line,
    // In turn order rather than score order — the score order is `scores`, and
    // the run of the round is worth being able to read back.
    voiceTakes: [...settled].sort((a, b) => a.turnIndex - b.turnIndex),
    bluffWord: null,
    bluffTruth: null,
    bluffReveal: null,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      cosmetics: p.cosmetics,
      votes: 0,
      isImposter: false,
      wasAccused: false,
      isSpectator: p.isSpectator,
      coinReward: coinsForPoints(p.isSpectator, pointsOf.get(p.id) ?? 0),
    })),
  };

  room.phase = 'results';
  room.lastResults = payload;
  io.to(room.code).emit('game:results', payload);
  bankRewards(room, payload);
  console.log(
    `[Voicer] Results in ${room.code}: "${line?.quote ?? '?'}" — ` +
      `${scoreLines.length} takes, scored against ${reference ? 'the original' : 'the room'}`
  );
}

/**
 * Coins on a scored round. Flat participation plus a per-point bonus, so a
 * round is always worth playing and a good read is worth more — the same shape
 * as §9's crew payout, expressed in points instead of a win flag.
 */
function coinsForPoints(isSpectator: boolean, points: number): CoinReward {
  if (isSpectator) return { baseCoins: 0, bonusCoins: 0, total: 0, reasons: ['Sat this round out'] };
  const base = 25;
  const bonus = points * 25;
  return {
    baseCoins: base,
    bonusCoins: bonus,
    total: base + bonus,
    reasons: bonus > 0 ? ['Played the round', `${points} point${points === 1 ? '' : 's'}`] : ['Played the round'],
  };
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
