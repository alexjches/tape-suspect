// src/hooks/useRoom.ts
// Room state machine — subscribes to every socket event for a room.
//
// Adding an event means three edits: the handler here, the matching
// socket.off in the cleanup, and (if clients trigger it) an action below.

'use client';

import { useEffect, useState, useCallback } from 'react';
import { getSocket } from '@/lib/socket';
import {
  RoomPublic,
  GameAssignment,
  VoteTally,
  GameResults,
  ChatMessage,
  GamePhase,
  GameWord,
  ReadyState,
  TurnState,
  DeliberationState,
  ChatType,
  EquippedCosmetics,
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

    const handleTurnState = (data: TurnState) => {
      setState((prev) => ({ ...prev, turnState: data }));
    };

    const handleWord = (word: GameWord) => {
      setState((prev) => ({ ...prev, words: [...prev.words, word] }));
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
        },
      }));
    };

    const handleTick = (data: { secondsLeft: number }) => {
      setState((prev) => ({ ...prev, secondsLeft: data.secondsLeft }));
    };

    const handleRevote = (data: {
      candidates: string[];
      eligibleVoters: string[];
      voteRound: number;
      endsAt: number;
      durationSeconds: number;
      tally: Record<string, number>;
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
    socket.on('game:turnState', handleTurnState);
    socket.on('game:word', handleWord);
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
      socket.off('game:turnState', handleTurnState);
      socket.off('game:word', handleWord);
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
            { code, playerName, avatar, userId, cosmetics },
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
        videoCategory?: string | null;
      }) => {
        return new Promise<string>((resolve, reject) => {
          socket.emit(
            'room:create',
            data,
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
          normalVideoUrl?: string;
          imposterVideoUrl?: string;
          wordsPerPlayer?: number;
          maxPlayers?: number;
          imposterCount?: number;
          chatType?: ChatType;
          videoCategory?: string | null;
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

    /** This player clicked Ready after their video ended (section 6). */
    readyToAdvance: useCallback(
      (code: string) => socket.emit('game:readyToAdvance', { code }),
      [socket]
    ),

    submitWord: useCallback(
      (code: string, word: string) => socket.emit('game:word', { code, word }),
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
