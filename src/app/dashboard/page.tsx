'use client';
// src/app/dashboard/page.tsx — "Lobby Router"
// Public tape browser, private-code entry and the host setup form on one
// console. Layout mirrors vhs-frontend-example/join-host.html (spec §21).

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import { getPlayerId } from '@/lib/playerId';
import { RoomPublic, ChatType, VoteVisibility } from '@/types';
import { VIDEO_CATEGORIES, CUSTOM_CATEGORY } from '@/lib/videoCategories';
import { isValidVideoUrl } from '@/lib/videoParser';
import { useShop } from '@/hooks/useShop';
import { CrtShell } from '@/components/vhs/CrtShell';
import Link from 'next/link';

const GUEST_AVATARS = ['🎮', '👾', '🕵️', '🎭', '🦊', '🐺', '🦁', '🐸'];

// Display lookup for the lobby list. Covers all four modes even though the
// host form only offers two — voice and video are Phase 2 (spec §16), and a
// room carrying one of them must still render a sensible pill.
const CHAT_LABELS: Record<ChatType, { icon: string; label: string; pill: string }> = {
  text: { icon: '⌨️', label: 'TEXT', pill: 'magenta' },
  voice: { icon: '🎤', label: 'VOICE', pill: 'green' },
  video: { icon: '📷', label: 'VIDEO', pill: 'cyan' },
  none: { icon: '🔇', label: 'EXTERNAL', pill: 'yellow' },
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px',
  border: '3px solid #000',
  borderRadius: 6,
  color: '#000',
  background: '#fff',
  fontFamily: 'var(--font-osd)',
  marginTop: 4,
};

function DashboardContent() {
  const { data: session, status } = useSession();
  const { coins, equipped: cosmetics } = useShop();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isGuest = searchParams.get('guest') === '1';

  const [publicRooms, setPublicRooms] = useState<RoomPublic[]>([]);
  const [guestName, setGuestName] = useState('');
  const [guestAvatar, setGuestAvatar] = useState('🎮');
  const [guestSetup, setGuestSetup] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState('');

  // Host setup form
  const [isPublic, setIsPublic] = useState(true);
  const [chatType, setChatType] = useState<ChatType>('text');
  const [voteVisibility, setVoteVisibility] = useState<VoteVisibility>('public');
  const [category, setCategory] = useState<string>('memes');
  const [crewUrl, setCrewUrl] = useState('');
  const [imposterUrl, setImposterUrl] = useState('');
  const [hosting, setHosting] = useState(false);

  // Private code entry
  const [privateCode, setPrivateCode] = useState('');
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    setMounted(true);
    const savedName = localStorage.getItem('imposter_guest_name');
    if (savedName) {
      setGuestName(savedName);
      setGuestSetup(true);
    }
    const savedAvatar = localStorage.getItem('imposter_guest_avatar');
    if (savedAvatar) {
      setGuestAvatar(savedAvatar);
    } else {
      setGuestAvatar(GUEST_AVATARS[Math.floor(Math.random() * GUEST_AVATARS.length)]);
    }
  }, []);

  const completeGuestSetup = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (trimmed.length < 2) return;
      localStorage.setItem('imposter_guest_name', trimmed);
      localStorage.setItem('imposter_guest_avatar', guestAvatar);
      setGuestName(trimmed);
      setGuestSetup(true);
    },
    [guestAvatar]
  );

  const playerName = session?.user?.name || (guestSetup ? guestName : null);
  const playerAvatar = (session?.user as any)?.image || guestAvatar;
  const userId = (session?.user as any)?.id || null;

  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    const handleRoomsUpdated = (rooms: RoomPublic[]) => setPublicRooms(rooms);

    socket.on('rooms:updated', handleRoomsUpdated);
    socket.emit('rooms:list', {}, (rooms: RoomPublic[]) => setPublicRooms(rooms || []));

    return () => {
      socket.off('rooms:updated', handleRoomsUpdated);
    };
  }, []);

  const joinByCode = useCallback(
    (code: string) => {
      const trimmed = code.trim().toUpperCase();
      if (trimmed.length !== 6) {
        setError('TAPE CODES ARE 6 CHARACTERS');
        return;
      }
      setJoining(true);
      setError('');
      getSocket().emit(
        'room:join',
        { code: trimmed, playerName: playerName || 'Guest', avatar: playerAvatar, userId, cosmetics },
        (res: { success: boolean; error?: string }) => {
          if (res.success) router.push(`/room/${trimmed}`);
          else {
            setError((res.error || 'COULD NOT JOIN TAPE').toUpperCase());
            setJoining(false);
          }
        }
      );
    },
    [playerName, playerAvatar, userId, cosmetics, router]
  );

  const customValid =
    category !== CUSTOM_CATEGORY ||
    (isValidVideoUrl(crewUrl) && isValidVideoUrl(imposterUrl));

  const hostRoom = useCallback(() => {
    if (!customValid) {
      setError('BOTH CUSTOM TAPE URLS MUST BE VALID');
      return;
    }
    setHosting(true);
    setError('');
    getSocket().emit(
      'room:create',
      {
        playerName: playerName || 'Guest',
        avatar: playerAvatar,
        userId,
        // Durable identity, so refreshing the lobby you just made keeps you
        // in it — and keeps you the host. See src/lib/playerId.ts.
        playerId: getPlayerId(),
        cosmetics,
        isPublic,
        chatType,
        voteVisibility,
        videoCategory: category,
        normalVideoUrl: category === CUSTOM_CATEGORY ? crewUrl : '',
        imposterVideoUrl: category === CUSTOM_CATEGORY ? imposterUrl : '',
      },
      (res: { success: boolean; code?: string; error?: string }) => {
        if (res.success && res.code) router.push(`/room/${res.code}`);
        else {
          setError((res.error || 'COULD NOT FORMAT DECK').toUpperCase());
          setHosting(false);
        }
      }
    );
  }, [customValid, playerName, playerAvatar, userId, cosmetics, isPublic, chatType, voteVisibility, category, crewUrl, imposterUrl, router]);

  // Redirect logged-out non-guests
  if (status === 'unauthenticated' && !isGuest) {
    router.push('/');
    return null;
  }

  if (!mounted || status === 'loading') {
    return (
      <CrtShell home badge="LOBBY ROUTER" badgeColor="var(--neon-cyan)">
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <div className="osd-text" style={{ color: 'var(--ink)' }}>
            SPOOLING UP…
          </div>
        </div>
      </CrtShell>
    );
  }

  // ── Guest identity gate ──────────────────────────────────────────
  if (isGuest && !guestSetup) {
    return (
      <CrtShell home badge="LOBBY ROUTER" badgeColor="var(--neon-cyan)">
        <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 20 }}>
          <div className="modal-card" style={{ maxWidth: 420 }}>
            <h2 className="brutal-title modal-title">📼 PLAYER IDENTITY</h2>
            <p className="modal-subtitle">LABEL YOUR CASSETTE TO CONTINUE</p>
            <div style={{ fontSize: '3.5rem', textAlign: 'center', margin: '10px 0' }}>
              {guestAvatar}
            </div>
            <label className="brutal-label" htmlFor="guest-name-input">
              NICKNAME:
            </label>
            <input
              id="guest-name-input"
              type="text"
              className="brutal-input"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              placeholder="CoolNickname2774"
              maxLength={20}
              onKeyDown={(e) => e.key === 'Enter' && completeGuestSetup(guestName)}
            />
            <div className="modal-actions">
              <button
                id="guest-continue-btn"
                className="btn-brutal green large-brutal-btn"
                disabled={guestName.trim().length < 2}
                onClick={() => completeGuestSetup(guestName)}
              >
                START PLAYING ⏵
              </button>
            </div>
            <p className="osd-text" style={{ textAlign: 'center', color: 'var(--ink-soft)', marginTop: 10 }}>
              <Link href="/signup" style={{ color: 'var(--link-accent)' }}>
                CREATE AN ACCOUNT
              </Link>{' '}
              TO SAVE PRESETS &amp; HISTORY
            </p>
          </div>
        </div>
      </CrtShell>
    );
  }

  const headerExtra = (
    <>
      <Link href="/shop" id="shop-nav-btn" className="coin-balance-display">
        <span className="coin-icon">🪙</span>
        <span className="coin-amount">{coins}</span>
        <span className="coin-label">REWIND COINS</span>
      </Link>
      <div
        className="coin-balance-display"
        style={{ borderColor: 'var(--neon-cyan)', background: 'rgba(0,0,0,0.6)' }}
      >
        <span style={{ marginRight: 5, fontSize: '1.2rem' }}>{playerAvatar}</span>
        <span
          className="coin-amount"
          style={{
            fontFamily: 'var(--font-marker)',
            fontSize: '1.1rem',
            color: 'var(--neon-cyan)',
            textShadow: 'none',
          }}
        >
          {playerName}
        </span>
        <span className="coin-label" style={{ color: '#aaa', marginLeft: 8 }}>
          {session?.user ? 'CONNECTED VCR' : 'GUEST VCR'}
        </span>
      </div>
      {session?.user && (
        <button
          id="signout-btn"
          className="btn-brutal dark"
          style={{ fontSize: '0.8rem', padding: '6px 12px' }}
          onClick={() => signOut({ callbackUrl: '/' })}
        >
          SIGN OUT
        </button>
      )}
    </>
  );

  const openRooms = publicRooms.filter((r) => r.phase === 'lobby');

  return (
    <CrtShell home badge="LOBBY ROUTER" badgeColor="var(--neon-cyan)" headerExtra={headerExtra} recording>
      <section className="gartic-hero-section" style={{ padding: '20px 0' }}>
        <div className="gartic-container-wrapper" style={{ maxWidth: 1200, width: '95%' }}>
          <div
            className="gartic-main-box"
            style={{ padding: 24, minHeight: '78vh', display: 'flex', flexDirection: 'column' }}
          >
            {error && (
              <div className="word-phase-banner" style={{ display: 'block', marginBottom: 12 }}>
                ⛔ {error}
              </div>
            )}

            <div
              className="gartic-inner-grid"
              style={{ flexGrow: 1, gridTemplateColumns: '1.1fr 1.3fr', gap: 24, height: '100%' }}
            >
              {/* ── Left: browse & join ────────────────────────── */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                  overflowY: 'auto',
                  paddingRight: 8,
                }}
              >
                <div
                  className="brutal-card cyan-border"
                  style={{ flexGrow: 1, padding: 18, background: 'rgba(13, 13, 26, 0.9)' }}
                >
                  <h3
                    className="brutal-title"
                    style={{
                      fontSize: '1.3rem',
                      color: 'var(--neon-cyan)',
                      marginBottom: 12,
                      textShadow: 'none',
                    }}
                  >
                    🌐 ACTIVE PUBLIC TAPES ({openRooms.length})
                  </h3>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {openRooms.length === 0 && (
                      <p className="osd-text" style={{ color: '#888' }}>
                        NO PUBLIC DECKS ROLLING — FORMAT ONE ON THE RIGHT.
                      </p>
                    )}

                    {openRooms.map((room) => {
                      const host = room.players.find((p) => p.id === room.hostId);
                      const full = room.players.length >= room.settings.maxPlayers;
                      const cat = room.settings.videoCategory
                        ? VIDEO_CATEGORIES[room.settings.videoCategory]
                        : null;
                      const chat = room.settings.chatType ?? 'text';

                      return (
                        <div
                          key={room.code}
                          className={`lobby-item-card${full ? ' full-lobby' : ''}`}
                        >
                          <div className="lobby-item-meta">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span className="lobby-item-avatar">{host?.avatar || '🎮'}</span>
                              <div>
                                <span className="lobby-item-host">{host?.name || 'Host'}</span>
                                <span className="lobby-item-code">{room.code}</span>
                              </div>
                            </div>
                            <div className="lobby-item-players">
                              {room.players.length}/{room.settings.maxPlayers} Players
                            </div>
                          </div>

                          <div className="lobby-item-options">
                            <span className="lobby-pill yellow">
                              {cat ? `${cat.icon} ${cat.name.toUpperCase()}` : '⚙️ CUSTOM'}
                            </span>
                            <span className={`lobby-pill ${CHAT_LABELS[chat].pill}`}>
                              {CHAT_LABELS[chat].icon} {CHAT_LABELS[chat].label}
                            </span>
                          </div>

                          <button
                            className={`btn-brutal ${full ? 'dark' : 'cyan'}`}
                            disabled={full || joining}
                            style={full ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                            onClick={() => joinByCode(room.code)}
                          >
                            {full ? 'FULL 🚫' : 'JOIN TAPE ⏵'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div
                  className="brutal-card magenta-border"
                  style={{ padding: 16, background: 'rgba(13, 13, 26, 0.9)' }}
                >
                  <h3
                    className="brutal-title"
                    style={{
                      fontSize: '1.2rem',
                      color: 'var(--neon-magenta)',
                      marginBottom: 10,
                      textShadow: 'none',
                    }}
                  >
                    🔑 ACCESS PRIVATE TAPE
                  </h3>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <input
                      id="room-code-input"
                      type="text"
                      className="osd-text"
                      style={{
                        ...inputStyle,
                        flexGrow: 1,
                        marginTop: 0,
                        padding: '10px 14px',
                        textTransform: 'uppercase',
                        fontSize: '1.1rem',
                        letterSpacing: 3,
                      }}
                      placeholder="ABC123"
                      maxLength={6}
                      value={privateCode}
                      onChange={(e) => setPrivateCode(e.target.value.toUpperCase().slice(0, 6))}
                      onKeyDown={(e) => e.key === 'Enter' && joinByCode(privateCode)}
                    />
                    <button
                      id="join-room-btn"
                      className="btn-brutal magenta"
                      style={{ margin: 0, padding: '0 16px', whiteSpace: 'nowrap' }}
                      disabled={joining || privateCode.trim().length !== 6}
                      onClick={() => joinByCode(privateCode)}
                    >
                      INSERT TAPE
                    </button>
                  </div>
                </div>
              </div>

              {/* ── Right: host a deck ─────────────────────────── */}
              <div
                className="brutal-card yellow-border"
                style={{
                  padding: 20,
                  background: 'rgba(13, 13, 26, 0.9)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflowY: 'auto',
                }}
              >
                <h3
                  className="brutal-title"
                  style={{
                    fontSize: '1.4rem',
                    color: 'var(--neon-yellow)',
                    marginBottom: 16,
                    textShadow: 'none',
                  }}
                >
                  📟 FORMAT BLANK DECK (HOST LOBBY)
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flexGrow: 1 }}>
                  <div>
                    <label className="form-section-title">🔒 DECK VISIBILITY</label>
                    <div style={{ display: 'flex', gap: 10, marginTop: 5 }}>
                      <button
                        id="opt-public"
                        className={`btn-brutal option-btn flex-1${isPublic ? ' active' : ''}`}
                        onClick={() => setIsPublic(true)}
                      >
                        🌐 PUBLIC
                      </button>
                      <button
                        id="opt-private"
                        className={`btn-brutal option-btn flex-1${!isPublic ? ' active' : ''}`}
                        onClick={() => setIsPublic(false)}
                      >
                        🔒 PRIVATE
                      </button>
                    </div>
                  </div>

                  {/* Phase 1 is text-only plus the 'none' external option
                      (spec §16); voice and video lobbies arrive in Phase 2. */}
                  <div>
                    <label className="form-section-title">💬 IN-APP TEXT CHAT</label>
                    <div style={{ display: 'flex', gap: 10, marginTop: 5 }}>
                      <button
                        id="opt-chat-text"
                        className={`btn-brutal option-btn flex-1${
                          chatType === 'text' ? ' active' : ''
                        }`}
                        onClick={() => setChatType('text')}
                      >
                        ⌨️ ON
                      </button>
                      <button
                        id="opt-chat-none"
                        className={`btn-brutal option-btn flex-1${
                          chatType === 'none' ? ' active' : ''
                        }`}
                        onClick={() => setChatType('none')}
                      >
                        🔇 OFF
                      </button>
                    </div>
                    <p
                      className="osd-text"
                      style={{ fontSize: '0.75rem', color: '#888', marginTop: 6 }}
                    >
                      {chatType === 'text'
                        ? 'Players argue in the app during the 90s window.'
                        : 'No in-app chat — for lobbies already on Discord or FaceTime.'}
                    </p>
                  </div>

                  {/* Spec §4: the host picks whether the ballot is live. */}
                  <div>
                    <label className="form-section-title">🗳️ VOTING VISIBILITY</label>
                    <div style={{ display: 'flex', gap: 10, marginTop: 5 }}>
                      <button
                        id="opt-vote-public"
                        className={`btn-brutal option-btn flex-1${
                          voteVisibility === 'public' ? ' active' : ''
                        }`}
                        onClick={() => setVoteVisibility('public')}
                      >
                        👁 PUBLIC
                      </button>
                      <button
                        id="opt-vote-anonymous"
                        className={`btn-brutal option-btn flex-1${
                          voteVisibility === 'anonymous' ? ' active' : ''
                        }`}
                        onClick={() => setVoteVisibility('anonymous')}
                      >
                        🕶 ANONYMOUS
                      </button>
                    </div>
                    <p
                      className="osd-text"
                      style={{ fontSize: '0.75rem', color: '#888', marginTop: 6 }}
                    >
                      {voteVisibility === 'public'
                        ? 'Everyone watches the votes land as they are cast.'
                        : 'Nobody sees a vote until the final tally at the reveal.'}
                    </p>
                  </div>

                  <div>
                    <label className="form-section-title">🎬 VIDEO RECORDING STYLE</label>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(2, 1fr)',
                        gap: 10,
                        marginTop: 5,
                      }}
                    >
                      {Object.values(VIDEO_CATEGORIES).map((c) => (
                        <button
                          key={c.id}
                          className={`btn-brutal option-btn category-btn${
                            category === c.id ? ' active' : ''
                          }`}
                          // Five genres in a two-column grid: let Custom take
                          // the orphan row rather than leaving a hole.
                          style={c.isCustom ? { gridColumn: '1 / -1' } : undefined}
                          onClick={() => setCategory(c.id)}
                        >
                          <span style={{ fontSize: '1.3rem', display: 'block', marginBottom: 2 }}>
                            {c.icon}
                          </span>
                          {c.name.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>

                  {category === CUSTOM_CATEGORY && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        marginTop: 5,
                        borderLeft: '4px solid var(--neon-yellow)',
                        paddingLeft: 12,
                      }}
                    >
                      <div>
                        <label
                          className="form-section-title"
                          style={{ fontSize: '0.8rem', color: '#ccc' }}
                          htmlFor="url-crew"
                        >
                          🎬 CREWMATE VIDEO URL
                        </label>
                        <input
                          id="url-crew"
                          type="text"
                          className="osd-text"
                          style={inputStyle}
                          placeholder="https://youtube.com/watch?v=…"
                          value={crewUrl}
                          onChange={(e) => setCrewUrl(e.target.value)}
                        />
                        {crewUrl && !isValidVideoUrl(crewUrl) && (
                          <span
                            className="osd-text"
                            style={{ color: 'var(--neon-magenta)', fontSize: '0.75rem' }}
                          >
                            INVALID VIDEO URL
                          </span>
                        )}
                      </div>
                      <div>
                        <label
                          className="form-section-title"
                          style={{ fontSize: '0.8rem', color: '#ccc' }}
                          htmlFor="url-imposter"
                        >
                          👁️ SUSPECT VIDEO URL
                        </label>
                        <input
                          id="url-imposter"
                          type="text"
                          className="osd-text"
                          style={inputStyle}
                          placeholder="https://youtube.com/watch?v=…"
                          value={imposterUrl}
                          onChange={(e) => setImposterUrl(e.target.value)}
                        />
                        {imposterUrl && !isValidVideoUrl(imposterUrl) && (
                          <span
                            className="osd-text"
                            style={{ color: 'var(--neon-magenta)', fontSize: '0.75rem' }}
                          >
                            INVALID VIDEO URL
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <button
                  id="create-room-btn"
                  className="btn-brutal yellow large-brutal-btn"
                  style={{ marginTop: 20, width: '100%' }}
                  disabled={hosting || !customValid}
                  onClick={hostRoom}
                >
                  {hosting ? 'FORMATTING…' : 'HOST ⏵'}
                </button>
              </div>
            </div>

            <div
              className="gartic-box-footer"
              style={{
                marginTop: 20,
                flexShrink: 0,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Link
                href="/"
                id="btn-back-home"
                className="btn-brutal dark"
                style={{ margin: 0, padding: '6px 16px' }}
              >
                ◀ RETURN HOME
              </Link>
              <div className="balance-pill" style={{ margin: 0 }}>
                <span className="coin-icon">🟢</span>
                {/* join-host.html sets this label to #000, but .balance-pill's
                    background is rgba(0,0,0,0.4) — black on black. */}
                <span className="coin-label" style={{ color: 'var(--neon-green)' }}>
                  SYSTEM OPERATIONAL
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </CrtShell>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <CrtShell home badge="LOBBY ROUTER" badgeColor="var(--neon-cyan)">
          <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
            <div className="osd-text" style={{ color: 'var(--ink)' }}>
              SPOOLING UP…
            </div>
          </div>
        </CrtShell>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
