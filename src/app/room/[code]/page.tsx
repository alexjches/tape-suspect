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
import { PromptScreen } from '@/components/game/PromptScreen';
import { WordsScreen } from '@/components/game/WordsScreen';
import { DrawScreen } from '@/components/game/DrawScreen';
import { WavelengthScreen } from '@/components/game/WavelengthScreen';
import { BluffScreen } from '@/components/game/BluffScreen';
import { DeliberationScreen } from '@/components/game/DeliberationScreen';
import { ResultsScreen } from '@/components/results/ResultsScreen';
import { Avatar } from '@/components/vhs/Avatar';
import { randomAvatar, nextAvatar } from '@/lib/avatars';

// Placeholder for the first paint; the effect below deals a real character.
const FIRST_FRAME_AVATAR = 'c00';

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
  const [localGuestAvatar, setLocalGuestAvatar] = useState(FIRST_FRAME_AVATAR);

  useEffect(() => {
    setPlayerId(getPlayerId());
    setLocalGuestAvatar(randomAvatar());
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
        avatar: (session.user as any).image || FIRST_FRAME_AVATAR,
        userId: ((session.user as any).id as string | null) || null,
      };
    }
    const storedName = localStorage.getItem('imposter_guest_name');
    if (storedName) {
      return {
        name: storedName,
        avatar: localStorage.getItem('imposter_guest_avatar') || FIRST_FRAME_AVATAR,
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
            {/* Same creator as /signup and the guest gate on /dashboard. */}
            <div className="avatar-creator-box" style={{ margin: '10px 0' }}>
              <div className="avatar-preview-container character-slot">
                <div id="avatar-svg-wrapper">
                  <Avatar code={localGuestAvatar} size={150} />
                </div>
                <button
                  id="btn-randomize-avatar"
                  type="button"
                  className="btn-circular"
                  title="Next character"
                  aria-label="Next character"
                  onClick={() => setLocalGuestAvatar((c) => nextAvatar(c))}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width={24}
                    height={24}
                    stroke="currentColor"
                    strokeWidth={3}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                  </svg>
                </button>
              </div>
              <div className="avatar-helper-text">CLICK TO CHANGE CHARACTER</div>
            </div>
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
  // A prompt round keeps the frame: it is a card to read, not a tape to watch,
  // and the lockdown that justifies going full-bleed has nothing to lock down.
  if (state.phase === 'playing' && state.assignment?.videoUrl) {
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

      {state.phase === 'playing' && state.assignment?.prompt && (
        <PromptScreen
          code={code}
          room={state.room}
          assignment={state.assignment}
          readyState={state.readyState}
          actions={actions}
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

      {state.phase === 'drawing' && (
        <DrawScreen
          room={state.room}
          playerId={playerId}
          code={code}
          assignment={state.assignment}
          strokes={state.strokes}
          turnState={state.turnState}
          actions={actions}
        />
      )}

      {(state.phase === 'writing' || state.phase === 'bluffvote') && (
        <BluffScreen
          room={state.room}
          playerId={playerId}
          code={code}
          phase={state.phase}
          bluffState={state.bluffState}
          actions={actions}
        />
      )}

      {(state.phase === 'clue' || state.phase === 'guessing') && (
        <WavelengthScreen
          room={state.room}
          playerId={playerId}
          code={code}
          phase={state.phase}
          assignment={state.assignment}
          spectrumState={state.spectrumState}
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
