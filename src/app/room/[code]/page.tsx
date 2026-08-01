'use client';
// src/app/room/[code]/page.tsx
// Phase-aware room shell: lobby -> playing -> words -> deliberation -> results

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { getSocket } from '@/lib/socket';
import { getPlayerId } from '@/lib/playerId';
import { useRoom } from '@/hooks/useRoom';
import { useShop } from '@/hooks/useShop';
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
  const { equipped: cosmetics } = useShop();
  /**
   * Who we are to the room. Durable across refreshes and reconnects — the
   * socket id it replaced changed on both. Empty until an effect has run, so
   * SSR and the first client render agree.
   */
  const [playerId, setPlayerId] = useState('');
  /** Bumped when a guest names themselves, to re-run the entry effect. */
  const [identityTick, setIdentityTick] = useState(0);

  const socket = getSocket();

  const [localGuestName, setLocalGuestName] = useState('');
  const [localGuestAvatar] = useState(
    () => GUEST_AVATARS[Math.floor(Math.random() * GUEST_AVATARS.length)]
  );

  useEffect(() => {
    setPlayerId(getPlayerId());
  }, []);

  useEffect(() => {
    if (state.isKicked) router.push('/dashboard');
  }, [state.isKicked, router]);

  // The name/avatar to enter under, or null if we don't know yet.
  const identity = (() => {
    if (status === 'loading' || typeof window === 'undefined') return null;
    if (session?.user?.name) {
      return {
        name: session.user.name,
        avatar: (session.user as any).image || '🎮',
        userId: ((session.user as any).id as string | null) || null,
      };
    }
    const storedName = localStorage.getItem('imposter_guest_name');
    if (storedName) {
      return {
        name: storedName,
        avatar: localStorage.getItem('imposter_guest_avatar') || '🎮',
        userId: null,
      };
    }
    return null;
  })();

  // Kept in a ref so the connect listener below always calls the current one
  // without the effect having to re-subscribe on every render.
  const enterRef = useRef<() => void>(() => {});
  useEffect(() => {
    enterRef.current = () => {
      if (!code || !identity) return;
      actions
        .joinRoom(identity.name, identity.avatar, identity.userId, code, cosmetics)
        .catch((err) => console.error('Entering tape failed:', err));
    };
  });

  // Enter on connect, and on every *re*-connect. The server matches on
  // playerId, so a repeat call is a resume rather than a second player —
  // which is what puts you back in the round after a refresh or a blip.
  const canEnter = !!identity && !!code;
  useEffect(() => {
    if (!canEnter) return;
    if (!socket.connected) socket.connect();
    const onConnect = () => enterRef.current();
    socket.on('connect', onConnect);
    if (socket.connected) enterRef.current();
    return () => {
      socket.off('connect', onConnect);
    };
  }, [socket, canEnter, code, identityTick]);

  const handleGuestJoin = () => {
    if (localGuestName.trim().length < 2 || !code) return;
    localStorage.setItem('imposter_guest_name', localGuestName.trim());
    localStorage.setItem('imposter_guest_avatar', localGuestAvatar);
    setIdentityTick((n) => n + 1);
    if (!socket.connected) socket.connect();
    actions
      .joinRoom(localGuestName.trim(), localGuestAvatar, null, code, cosmetics)
      .catch((err) => console.error('Guest join failed:', err));
  };

  if (!code) return null;

  const isHost = !!playerId && state.room?.hostId === playerId;

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

  // Section 4: whoever supplied the Custom tapes sits the round out, so they
  // get no assignment and there is nothing to play them. They still watch the
  // rest of the round unfold from the word phase on.
  const amSpectator = !!state.room.players.find((p) => p.id === playerId)?.isSpectator;
  if (state.phase === 'playing' && amSpectator) {
    return (
      <CrtShell badge={code}>
        <div className="view-panel active-view" style={{ display: 'grid', placeItems: 'center' }}>
          <div className="brutal-card" style={{ maxWidth: 440, textAlign: 'center' }}>
            <div style={{ fontSize: '3rem' }}>👁️</div>
            <h2 className="brutal-title" style={{ fontSize: '1.5rem' }}>
              SITTING THIS ONE OUT
            </h2>
            <p className="osd-text" style={{ color: '#aaa', margin: '10px 0' }}>
              You loaded both tapes, so you already know which is which. The
              others are watching now — you&apos;ll be back for the results.
            </p>
            <div className="osd-text" style={{ color: 'var(--neon-cyan)' }}>
              ⏳ TAPES ROLLING…
            </div>
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
        playerId={playerId}
        actions={actions}
      />
    );
  }

  return (
    <CrtShell
      badge={code}
      recording={state.phase === 'words'}
      logoLeaves={state.phase === 'lobby'}
    >
      {state.phase === 'lobby' && (
        <LobbyScreen
          room={state.room}
          playerId={playerId}
          isHost={isHost}
          actions={actions}
          code={code}
          error={state.error}
        />
      )}

      {state.phase === 'words' && (
        <WordsScreen
          room={state.room}
          playerId={playerId}
          code={code}
          words={state.words}
          turnState={state.turnState}
          actions={actions}
        />
      )}

      {state.phase === 'deliberation' && (
        <DeliberationScreen
          room={state.room}
          playerId={playerId}
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
          playerId={playerId}
          actions={actions}
          code={code}
        />
      )}
    </CrtShell>
  );
}
