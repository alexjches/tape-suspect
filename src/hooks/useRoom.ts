// src/hooks/useRoom.ts
// Room state machine — subscribes to every socket event for a room.
//
// Adding an event means three edits: the handler here, the matching
// socket.off in the cleanup, and (if clients trigger it) an action below.

'use client';

import { useEffect, useState, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import { getPlayerId } from '@/lib/playerId';
import {
  RoomPublic,
  GameAssignment,
  VoteTally,
  GameResults,
  ChatMessage,
  GamePhase,
  GameWord,
  DrawStroke,
  BluffOption,
  ReadyState,
  TurnState,
  DeliberationState,
  ChatType,
  VoteVisibility,
  EquippedCosmetics,
  ReactionEmoji,
} from '@/types';

export interface RoomState {
  room: RoomPublic | null;
  phase: GamePhase;
  assignment: GameAssignment | null;
  /** Video-loaded progress, gates the synchronized play start. */
  loadedCount: { ready: number; total: number } | null;
  readyState: ReadyState | null;
  turnState: TurnState | null;
  words: GameWord[];
  /** The shared canvas, in stroke order. Fake Artist only. */
  strokes: DrawStroke[];
  /** Wavelength: your own target (psychic only) and the live guess count. */
  spectrumState: { secondsLeft: number; guessesIn: number; totalGuessers: number } | null;
  /** Bluff: the word, the ballot (authorless) and the live progress count. */
  bluffState: {
    word: string;
    options: BluffOption[];
    secondsLeft: number;
    doneIn: number;
    total: number;
  } | null;
  deliberation: DeliberationState | null;
  secondsLeft: number | null;
  voteTally: VoteTally | null;
  results: GameResults | null;
  chatMessages: ChatMessage[];
  error: string | null;
  isKicked: boolean;
}

const initialState: RoomState = {
  room: null,
  phase: 'lobby',
  assignment: null,
  loadedCount: null,
  readyState: null,
  turnState: null,
  words: [],
  strokes: [],
  spectrumState: null,
  bluffState: null,
  deliberation: null,
  secondsLeft: null,
  voteTally: null,
  results: null,
  chatMessages: [],
  error: null,
  isKicked: false,
};

export function useRoom(code: string | null) {
  const [state, setState] = useState<RoomState>(initialState);
  const socket = getSocket();

  useEffect(() => {
    if (!code) return;

    const handleRoomUpdated = (room: RoomPublic) => {
      setState((prev) => ({ ...prev, room, phase: room.phase, error: null }));
    };

    const handleAssigned = (assignment: GameAssignment) => {
      setState((prev) => ({ ...prev, assignment }));
    };

    const handleLoadedCount = (data: { ready: number; total: number }) => {
      setState((prev) => ({ ...prev, loadedCount: data }));
    };

    const handleReadyState = (data: ReadyState) => {
      setState((prev) => ({ ...prev, readyState: data }));
    };

    const handleWordPhaseStart = (data: RoomPublic & TurnState) => {
      // Round 2 of a 2-imposter game re-enters the word phase, and round 1's
      // words are the evidence players are arguing over — keep them.
      const continuing = (data.gameRound ?? 1) > 1;
      setState((prev) => ({
        ...prev,
        room: data,
        phase: 'words',
        words: continuing ? prev.words : [],
        chatMessages: continuing ? prev.chatMessages : [],
        turnState: {
          activePlayerId: data.activePlayerId,
          turnTimeLeft: data.turnTimeLeft,
          turnIndex: 0,
          wordsUsed: {},
        },
      }));
    };

    // Its own event, not a flag on wordPhaseStart: the two phases render
    // completely different screens and the hook has to route without knowing
    // anything about modes.
    const handleDrawPhaseStart = (data: RoomPublic & TurnState) => {
      const continuing = (data.gameRound ?? 1) > 1;
      setState((prev) => ({
        ...prev,
        room: data,
        phase: 'drawing',
        strokes: continuing ? prev.strokes : [],
        chatMessages: continuing ? prev.chatMessages : [],
        turnState: {
          activePlayerId: data.activePlayerId,
          turnTimeLeft: data.turnTimeLeft,
          turnIndex: 0,
          wordsUsed: {},
        },
      }));
    };

    const handleStroke = (stroke: DrawStroke) => {
      setState((prev) => ({ ...prev, strokes: [...prev.strokes, stroke] }));
    };

    // Reconnect only — the canvas is the evidence and drawPhaseStart clears it.
    const handleStrokeHistory = (data: { strokes: DrawStroke[] }) => {
      setState((prev) => ({ ...prev, strokes: data.strokes }));
    };

    const handleCluePhaseStart = (data: RoomPublic & { secondsLeft: number }) => {
      setState((prev) => ({
        ...prev,
        room: data,
        phase: 'clue',
        spectrumState: { secondsLeft: data.secondsLeft, guessesIn: 0, totalGuessers: 0 },
      }));
    };

    const handleClueTick = (d: { secondsLeft: number }) => {
      setState((prev) => ({
        ...prev,
        spectrumState: { ...(prev.spectrumState ?? { guessesIn: 0, totalGuessers: 0 }), ...d },
      }));
    };

    const handleGuessPhaseStart = (
      data: RoomPublic & { secondsLeft: number; totalGuessers: number }
    ) => {
      setState((prev) => ({
        ...prev,
        room: data,
        phase: 'guessing',
        spectrumState: {
          secondsLeft: data.secondsLeft,
          guessesIn: 0,
          totalGuessers: data.totalGuessers,
        },
      }));
    };

    const handleGuessTick = (d: {
      secondsLeft: number;
      guessesIn: number;
      totalGuessers: number;
    }) => {
      setState((prev) => ({ ...prev, spectrumState: d }));
    };

    const handleWritingPhaseStart = (
      data: RoomPublic & { word: string; secondsLeft: number; totalWriters: number }
    ) => {
      setState((prev) => ({
        ...prev,
        room: data,
        phase: 'writing',
        bluffState: {
          word: data.word,
          options: [],
          secondsLeft: data.secondsLeft,
          doneIn: 0,
          total: data.totalWriters,
        },
      }));
    };

    const handleWritingTick = (d: {
      secondsLeft: number;
      writtenIn: number;
      totalWriters: number;
    }) => {
      setState((prev) => ({
        ...prev,
        bluffState: prev.bluffState
          ? {
              ...prev.bluffState,
              secondsLeft: d.secondsLeft,
              doneIn: d.writtenIn,
              total: d.totalWriters,
            }
          : prev.bluffState,
      }));
    };

    const handleBluffVoteStart = (
      data: RoomPublic & {
        word: string;
        options: BluffOption[];
        secondsLeft: number;
        totalVoters: number;
      }
    ) => {
      setState((prev) => ({
        ...prev,
        room: data,
        phase: 'bluffvote',
        bluffState: {
          word: data.word,
          options: data.options,
          secondsLeft: data.secondsLeft,
          doneIn: 0,
          total: data.totalVoters,
        },
      }));
    };

    const handleBluffVoteTick = (d: {
      secondsLeft: number;
      votesIn: number;
      totalVoters: number;
    }) => {
      setState((prev) => ({
        ...prev,
        bluffState: prev.bluffState
          ? {
              ...prev.bluffState,
              secondsLeft: d.secondsLeft,
              doneIn: d.votesIn,
              total: d.totalVoters,
            }
          : prev.bluffState,
      }));
    };

    const handleTurnState = (data: TurnState) => {
      setState((prev) => ({ ...prev, turnState: data }));
    };

    const handleWord = (word: GameWord) => {
      setState((prev) => ({ ...prev, words: [...prev.words, word] }));
    };

    // Sent only to a reconnecting socket: the board as it stands, because
    // game:wordPhaseStart clears it and the words are the whole argument.
    const handleWordHistory = (data: { words: GameWord[] }) => {
      setState((prev) => ({ ...prev, words: data.words }));
    };

    const handleDeliberationStart = (
      data: RoomPublic & { endsAt: number; durationSeconds: number; voteRound: number; revoteCandidates: string[] | null }
    ) => {
      setState((prev) => ({
        ...prev,
        room: data,
        phase: 'deliberation',
        voteTally: null,
        secondsLeft: data.durationSeconds,
        deliberation: {
          endsAt: data.endsAt,
          durationSeconds: data.durationSeconds,
          voteRound: data.voteRound,
          revoteCandidates: data.revoteCandidates,
          eligibleVoters: null,
          canRecast: null,
        },
      }));
    };

    const handleTick = (data: { secondsLeft: number }) => {
      setState((prev) => ({ ...prev, secondsLeft: data.secondsLeft }));
    };

    // In an anonymous lobby this arrives per-socket rather than room-wide,
    // with `eligibleVoters` withheld and `canRecast` speaking only about you.
    const handleRevote = (data: {
      candidates: string[];
      eligibleVoters: string[] | null;
      canRecast: boolean | null;
      voteRound: number;
      endsAt: number;
      durationSeconds: number;
      tally: Record<string, number> | null;
    }) => {
      setState((prev) => ({
        ...prev,
        secondsLeft: data.durationSeconds,
        deliberation: {
          endsAt: data.endsAt,
          durationSeconds: data.durationSeconds,
          voteRound: data.voteRound,
          revoteCandidates: data.candidates,
          eligibleVoters: data.eligibleVoters,
          canRecast: data.canRecast,
        },
      }));
    };

    const handleVoteTally = (tally: VoteTally) => {
      setState((prev) => ({ ...prev, voteTally: tally }));
    };

    const handleResults = (results: GameResults) => {
      setState((prev) => ({ ...prev, results, phase: 'results' }));
    };

    const handleKicked = () => {
      setState((prev) => ({ ...prev, isKicked: true }));
    };

    const handleError = (data: { message: string }) => {
      setState((prev) => ({ ...prev, error: data.message }));
    };

    const handleChatMessage = (msg: ChatMessage) => {
      setState((prev) => ({
        ...prev,
        chatMessages: [...prev.chatMessages.slice(-99), msg],
      }));
    };

    socket.on('room:updated', handleRoomUpdated);
    socket.on('game:assigned', handleAssigned);
    socket.on('game:readyCount', handleLoadedCount);
    socket.on('game:readyState', handleReadyState);
    socket.on('game:wordPhaseStart', handleWordPhaseStart);
    socket.on('game:drawPhaseStart', handleDrawPhaseStart);
    socket.on('game:writingPhaseStart', handleWritingPhaseStart);
    socket.on('game:writingTick', handleWritingTick);
    socket.on('game:bluffVoteStart', handleBluffVoteStart);
    socket.on('game:bluffVoteTick', handleBluffVoteTick);
    socket.on('game:cluePhaseStart', handleCluePhaseStart);
    socket.on('game:clueTick', handleClueTick);
    socket.on('game:guessPhaseStart', handleGuessPhaseStart);
    socket.on('game:guessTick', handleGuessTick);
    socket.on('game:stroke', handleStroke);
    socket.on('game:strokeHistory', handleStrokeHistory);
    socket.on('game:turnState', handleTurnState);
    socket.on('game:word', handleWord);
    socket.on('game:wordHistory', handleWordHistory);
    socket.on('game:deliberationStart', handleDeliberationStart);
    socket.on('game:deliberationTick', handleTick);
    socket.on('game:revote', handleRevote);
    socket.on('vote:tally', handleVoteTally);
    socket.on('game:results', handleResults);
    socket.on('room:kicked', handleKicked);
    socket.on('game:error', handleError);
    socket.on('room:chatMessage', handleChatMessage);

    return () => {
      socket.off('room:updated', handleRoomUpdated);
      socket.off('game:assigned', handleAssigned);
      socket.off('game:readyCount', handleLoadedCount);
      socket.off('game:readyState', handleReadyState);
      socket.off('game:wordPhaseStart', handleWordPhaseStart);
      socket.off('game:drawPhaseStart', handleDrawPhaseStart);
      socket.off('game:writingPhaseStart', handleWritingPhaseStart);
      socket.off('game:writingTick', handleWritingTick);
      socket.off('game:bluffVoteStart', handleBluffVoteStart);
      socket.off('game:bluffVoteTick', handleBluffVoteTick);
      socket.off('game:cluePhaseStart', handleCluePhaseStart);
      socket.off('game:clueTick', handleClueTick);
      socket.off('game:guessPhaseStart', handleGuessPhaseStart);
      socket.off('game:guessTick', handleGuessTick);
      socket.off('game:stroke', handleStroke);
      socket.off('game:strokeHistory', handleStrokeHistory);
      socket.off('game:turnState', handleTurnState);
      socket.off('game:word', handleWord);
      socket.off('game:wordHistory', handleWordHistory);
      socket.off('game:deliberationStart', handleDeliberationStart);
      socket.off('game:deliberationTick', handleTick);
      socket.off('game:revote', handleRevote);
      socket.off('vote:tally', handleVoteTally);
      socket.off('game:results', handleResults);
      socket.off('room:kicked', handleKicked);
      socket.off('game:error', handleError);
      socket.off('room:chatMessage', handleChatMessage);
    };
  }, [code, socket]);

  const actions = {
    /**
     * Enter a room — or re-enter one. The server matches on `playerId`, so a
     * refresh or a dropped connection lands back in the round in progress
     * rather than creating a second player; the phase is replayed to this
     * socket alone. Safe to call on every `connect`.
     */
    joinRoom: useCallback(
      (
        playerName: string,
        avatar: string,
        userId: string | null,
        code: string,
        cosmetics?: EquippedCosmetics
      ) => {
        return new Promise<RoomPublic>((resolve, reject) => {
          socket.emit(
            'room:join',
            { code, playerName, avatar, userId, cosmetics, playerId: getPlayerId() },
            (res: { success: boolean; room?: RoomPublic; error?: string }) => {
              if (res.success && res.room) {
                setState((prev) => ({
                  ...prev,
                  room: res.room!,
                  phase: res.room!.phase,
                }));
                resolve(res.room);
              } else {
                reject(new Error(res.error || 'Failed to join room'));
              }
            }
          );
        });
      },
      [socket]
    ),

    createRoom: useCallback(
      (data: {
        playerName: string;
        avatar: string;
        userId: string | null;
        isPublic: boolean;
        normalVideoUrl?: string;
        imposterVideoUrl?: string;
        chatType?: ChatType;
        voteVisibility?: VoteVisibility;
        videoCategory?: string | null;
      }) => {
        return new Promise<string>((resolve, reject) => {
          socket.emit(
            'room:create',
            { ...data, playerId: getPlayerId() },
            (res: { success: boolean; code?: string; error?: string }) => {
              if (res.success && res.code) resolve(res.code);
              else reject(new Error(res.error || 'Failed to create room'));
            }
          );
        });
      },
      [socket]
    ),

    updateSettings: useCallback(
      (
        code: string,
        settings: {
          isPublic?: boolean;
          useCustomContent?: boolean;
          normalVideoUrl?: string;
          imposterVideoUrl?: string;
          customNormalPrompt?: string;
          customImposterPrompt?: string;
          wordsPerPlayer?: number;
          maxPlayers?: number;
          imposterCount?: number;
          chatType?: ChatType;
          voteVisibility?: VoteVisibility;
          videoCategory?: string | null;
          themeHint?: boolean;
        }
      ) => {
        socket.emit('room:updateSettings', { code, ...settings });
      },
      [socket]
    ),

    /** Hand the lobby to another player (section 4). Host only. */
    transferHost: useCallback(
      (code: string, targetId: string) => {
        socket.emit('room:transferHost', { code, targetId });
      },
      [socket]
    ),

    kick: useCallback(
      (code: string, targetId: string) => {
        socket.emit('room:kick', { code, targetId });
      },
      [socket]
    ),

    /**
     * Walk out on purpose. Call this before routing away from the room —
     * navigation alone leaves you in the lobby, because the socket is a
     * singleton that survives it.
     *
     * Outbound only, so there is no listener and no matching `socket.off`:
     * the server answers with the ordinary `room:updated` everyone else is
     * already subscribed to.
     */
    leave: useCallback(
      (code: string) => {
        socket.emit('room:leave', { code });
      },
      [socket]
    ),

    /**
     * Fill the lobby with simulated players so a round can be started solo
     * (testing aid). Omit `count` to add just enough to reach the minimum.
     * Rejected unless the server was started with bots enabled — check
     * `room.botsAllowed` before offering the control.
     */
    addBots: useCallback(
      (code: string, count?: number) => {
        return new Promise<number>((resolve, reject) => {
          socket.emit(
            'room:addBots',
            { code, count },
            (res: { success: boolean; added?: number; error?: string }) => {
              if (res.success) resolve(res.added ?? 0);
              else reject(new Error(res.error || 'Could not add players'));
            }
          );
        });
      },
      [socket]
    ),

    removeBots: useCallback(
      (code: string) => {
        return new Promise<number>((resolve, reject) => {
          socket.emit(
            'room:removeBots',
            { code },
            (res: { success: boolean; removed?: number; error?: string }) => {
              if (res.success) resolve(res.removed ?? 0);
              else reject(new Error(res.error || 'Could not remove players'));
            }
          );
        });
      },
      [socket]
    ),

    startGame: useCallback(
      (code: string) => socket.emit('game:start', { code }),
      [socket]
    ),

    /** Video element has buffered and is ready to play. */
    signalLoaded: useCallback(
      (code: string) => socket.emit('game:syncReady', { code }),
      [socket]
    ),

    /** This player's video reached its end (section 6). */
    videoEnded: useCallback(
      (code: string) => socket.emit('game:videoEnded', { code }),
      [socket]
    ),

    /**
     * Send a live reaction during the video (section 5).
     *
     * The matching inbound `game:reaction` is deliberately NOT handled here.
     * Reactions are ephemeral, watch-phase only, and arrive several a second
     * from a full lobby; putting them in this hook's state would re-render
     * every screen subscribed to the room on each one. `ReactionBar`
     * subscribes to the socket directly instead — the same thing `GameScreen`
     * already does for `game:play`.
     */
    sendReaction: useCallback(
      (code: string, emoji: ReactionEmoji) => socket.emit('game:react', { code, emoji }),
      [socket]
    ),

    /** This player clicked Ready after their video ended (section 6). */
    readyToAdvance: useCallback(
      (code: string) => socket.emit('game:readyToAdvance', { code }),
      [socket]
    ),

    submitWord: useCallback(
      (code: string, word: string) => socket.emit('game:word', { code, word }),
      [socket]
    ),

    /** Bluff: your fake definition. */
    submitDefinition: useCallback(
      (code: string, text: string) => socket.emit('game:definition', { code, text }),
      [socket]
    ),

    /** Bluff: which definition you think is the real one. */
    submitBluffVote: useCallback(
      (code: string, optionId: string) => socket.emit('game:bluffVote', { code, optionId }),
      [socket]
    ),

    /** Wavelength: the psychic's one clue. */
    submitClue: useCallback(
      (code: string, clue: string) => socket.emit('game:clue', { code, clue }),
      [socket]
    ),

    /** Wavelength: a guess, 0-100. */
    submitGuess: useCallback(
      (code: string, value: number) => socket.emit('game:guess', { code, value }),
      [socket]
    ),

    /** One stroke, on your turn. Points are normalised 0..1 by the canvas. */
    submitStroke: useCallback(
      (code: string, points: number[]) => socket.emit('game:stroke', { code, points }),
      [socket]
    ),

    sendChat: useCallback(
      (code: string, message: string) => socket.emit('game:chat', { code, message }),
      [socket]
    ),

    sendLobbyChat: useCallback(
      (code: string, message: string) => socket.emit('room:chat', { code, message }),
      [socket]
    ),

    castVote: useCallback(
      (code: string, targetId: string) => {
        return new Promise<void>((resolve, reject) => {
          socket.emit(
            'vote:cast',
            { code, targetId },
            (res: { success: boolean; error?: string }) => {
              if (res.success) resolve();
              else reject(new Error(res.error));
            }
          );
        });
      },
      [socket]
    ),

    /**
     * Get back into the same lobby after a round. Results puts everyone out
     * of the lobby; whoever clicks first re-forms it and the rest land beside
     * them as they click. Resolves once you're in.
     */
    rejoin: useCallback(
      (code: string) => {
        return new Promise<void>((resolve, reject) => {
          socket.emit(
            'game:rejoin',
            { code },
            (res: { success: boolean; error?: string }) => {
              if (res.success) resolve();
              else reject(new Error(res.error || 'Could not rejoin'));
            }
          );
        });
      },
      [socket]
    ),

    clearError: useCallback(() => {
      setState((prev) => ({ ...prev, error: null }));
    }, []),
  };

  return { state, actions };
}

export type RoomActions = ReturnType<typeof useRoom>['actions'];
