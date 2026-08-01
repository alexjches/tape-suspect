'use client';
// src/app/room/[code]/page.tsx
// Phase-aware room shell: lobby -> playing -> words -> deliberation -> results

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { getSocket } from '@/lib/socket';
import { useRoom } from '@/hooks/useRoom';
import { CrtShell } from '@/components/vhs/CrtShell';
import { LobbyScreen } from '@/components/lobby/LobbyScreen';
import { GameScreen } from '@/components/game/GameScreen';
import { WordsScreen } from '@/components/game/WordsScreen';
import { DeliberationScreen } from '@/components/game/DeliberationScreen';
import { ResultsScreen } from '@/components/results/ResultsScreen';

const GUEST_AVATARS = ['🎮', '👾', '🕵️', '🎭', '🦊', '🐺', '🦁', '🐸'];

export default function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { state, actions } = useRoom(code);
  const [socketId, setSocketId] = useState('');
  const [hasAttemptedJoin, setHasAttemptedJoin] = useState(false);

  const socket = getSocket();

  const [localGuestName, setLocalGuestName] = useState('');
  const [localGuestAvatar] = useState(
    () => GUEST_AVATARS[Math.floor(Math.random() * GUEST_AVATARS.length)]
  );

  useEffect(() => {
    if (!socket.connected) socket.connect();
    const handleConnect = () => setSocketId(socket.id || '');
    socket.on('connect', handleConnect);
    if (socket.connected) setSocketId(socket.id || '');
    return () => {
      socket.off('connect', handleConnect);
    };
  }, [socket]);

  useEffect(() => {
    if (state.isKicked) router.push('/dashboard');
  }, [state.isKicked, router]);

  // Auto-join once the socket is up and we know who this player is.
  useEffect(() => {
    if (!socketId || !code || status === 'loading' || state.room || hasAttemptedJoin) return;

    const storedName = localStorage.getItem('imposter_guest_name');
    const storedAvatar = localStorage.getItem('imposter_guest_avatar') || '🎮';

    if (session?.user?.name) {
      setHasAttemptedJoin(true);
      actions
        .joinRoom(
          session.user.name,
          (session.user as any).image || '🎮',
          (session.user as any).id || null,
          code
        )
        .catch((err) => console.error('Auto-join failed:', err));
    } else if (storedName) {
      setHasAttemptedJoin(true);
      actions
        .joinRoom(storedName, storedAvatar, null, code)
        .catch((err) => console.error('Guest auto-join failed:', err));
    }
  }, [socketId, code, status, session, state.room, hasAttemptedJoin, actions]);

  const handleGuestJoin = () => {
    if (localGuestName.trim().length < 2 || !code) return;
    localStorage.setItem('imposter_guest_name', localGuestName.trim());
    localStorage.setItem('imposter_guest_avatar', localGuestAvatar);
    setHasAttemptedJoin(true);
    actions
      .joinRoom(localGuestName.trim(), localGuestAvatar, null, code)
      .catch((err) => console.error('Guest join failed:', err));
  };

  if (!code) return null;

  const isHost = state.room?.hostId === socketId;

  if (state.error && !state.room) {
    return (
      <CrtShell badge="ERROR">
        <div className="view-panel active-view" style={{ display: 'grid', placeItems: 'center' }}>
          <div className="brutal-card" style={{ maxWidth: 380, textAlign: 'center' }}>
            <div style={{ fontSize: '3rem' }}>⚠️</div>
            <h2 className="brutal-title" style={{ fontSize: '1.4rem' }}>
              TRACKING ERROR
            </h2>
            <p className="osd-text" style={{ color: '#aaa', margin: '8px 0 16px' }}>
              {state.error}
            </p>
            <Link href="/dashboard" className="btn-brutal cyan">
              BACK TO DECK
            </Link>
          </div>
        </div>
      </CrtShell>
    );
  }

  // Guest name prompt when we have no identity cached.
  const hasCachedGuestName =
    typeof window !== 'undefined' && !!localStorage.getItem('imposter_guest_name');
  if (!session && status !== 'loading' && !hasCachedGuestName && !state.room) {
    return (
      <CrtShell badge={code}>
        <div className="view-panel active-view" style={{ display: 'grid', placeItems: 'center' }}>
          <div className="brutal-card" style={{ maxWidth: 380 }}>
            <h2 className="brutal-title" style={{ fontSize: '1.5rem', textAlign: 'center' }}>
              NAME YOUR PLAYER
            </h2>
            <p className="osd-text" style={{ color: '#aaa', textAlign: 'center', margin: '8px 0' }}>
              Joining tape <span style={{ color: 'var(--neon-magenta)' }}>{code}</span>
            </p>
            <div style={{ fontSize: '3rem', textAlign: 'center' }}>{localGuestAvatar}</div>
            <input
              id="guest-join-name-input"
              type="text"
              className="voting-chat-input"
              style={{ width: '100%', margin: '12px 0' }}
              placeholder="Your display name"
              maxLength={20}
              value={localGuestName}
              onChange={(e) => setLocalGuestName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleGuestJoin()}
            />
            <button
              id="guest-join-btn"
              className="btn-brutal cyan"
              style={{ width: '100%' }}
              disabled={localGuestName.trim().length < 2}
              onClick={handleGuestJoin}
            >
              JOIN TAPE →
            </button>
          </div>
        </div>
      </CrtShell>
    );
  }

  if (!state.room) {
    return (
      <CrtShell badge={code}>
        <div className="view-panel active-view" style={{ display: 'grid', placeItems: 'center' }}>
          <div className="osd-text" style={{ color: 'var(--neon-cyan)' }}>
            CONNECTING TO TAPE {code}…
          </div>
        </div>
      </CrtShell>
    );
  }

  // The video phase takes over the whole viewport — no CRT chrome over it.
  if (state.phase === 'playing' && state.assignment) {
    return (
      <GameScreen
        code={code}
        assignment={state.assignment}
        loadedCount={state.loadedCount}
        readyState={state.readyState}
        socketId={socketId}
        actions={actions}
      />
    );
  }

  return (
    <CrtShell badge={code} recording={state.phase === 'words'}>
      {state.phase === 'lobby' && (
        <LobbyScreen
          room={state.room}
          socketId={socketId}
          isHost={isHost}
          actions={actions}
          code={code}
          error={state.error}
        />
      )}

      {state.phase === 'words' && (
        <WordsScreen
          room={state.room}
          socketId={socketId}
          code={code}
          words={state.words}
          turnState={state.turnState}
          actions={actions}
        />
      )}

      {state.phase === 'deliberation' && (
        <DeliberationScreen
          room={state.room}
          socketId={socketId}
          code={code}
          words={state.words}
          chatMessages={state.chatMessages}
          voteTally={state.voteTally}
          deliberation={state.deliberation}
          secondsLeft={state.secondsLeft}
          actions={actions}
        />
      )}

      {state.phase === 'results' && state.results && (
        <ResultsScreen
          results={state.results}
          socketId={socketId}
          actions={actions}
          code={code}
        />
      )}
    </CrtShell>
  );
}
