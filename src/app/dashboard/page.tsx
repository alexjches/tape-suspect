'use client';
// src/app/dashboard/page.tsx — "Lobby Router"
//
// Three doors and nothing else: browse the public decks, punch in a private
// code, or format a deck of your own. Hosting no longer asks any questions
// first — the settings form moved into the lobby, where the people who are
// about to play can see it change. See LobbyScreen.

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import { getPlayerId } from '@/lib/playerId';
import { RoomPublic, ChatType } from '@/types';
import { VIDEO_CATEGORIES } from '@/lib/videoCategories';
import { useShop } from '@/hooks/useShop';
import { CrtShell } from '@/components/vhs/CrtShell';
import { Avatar } from '@/components/vhs/Avatar';
import { randomAvatar, nextAvatar, FIRST_FRAME_AVATAR } from '@/lib/avatars';
import Link from 'next/link';


// What a deck gets formatted with when you press HOST. Everything here is
// changeable from the lobby OSD a second later, so these only have to be the
// least surprising round rather than the right one: a public memes lobby with
// a live ballot is the game most people mean.
const HOST_DEFAULTS = {
  isPublic: true,
  chatType: 'text' as ChatType,
  voteVisibility: 'public' as const,
  videoCategory: 'memes',
};

// Shared by the footer's two RETURN elements — a <button> behind the browse
// door and a <Link> on the router — so the one control cannot drift in size
// between the two views it appears in.
const FOOTER_BACK_STYLE = { margin: 0, padding: '6px 16px' } as const;

// Display lookup for the lobby list. Covers all four modes even though the
// lobby only offers two — voice and video are Phase 2 (spec §16), and a room
// carrying one of them must still render a sensible pill.
const CHAT_LABELS: Record<ChatType, { icon: string; label: string; pill: string }> = {
  text: { icon: '⌨️', label: 'TEXT', pill: 'magenta' },
  voice: { icon: '🎤', label: 'VOICE', pill: 'green' },
  video: { icon: '📷', label: 'VIDEO', pill: 'cyan' },
  none: { icon: '🔇', label: 'EXTERNAL', pill: 'yellow' },
};

function DashboardContent() {
  const { data: session, status } = useSession();
  const { coins, equipped: cosmetics } = useShop();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isGuest = searchParams.get('guest') === '1';

  const [publicRooms, setPublicRooms] = useState<RoomPublic[]>([]);
  const [guestName, setGuestName] = useState('');
  const [guestAvatar, setGuestAvatar] = useState(FIRST_FRAME_AVATAR);
  const [guestSetup, setGuestSetup] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState('');

  // 'router' is the three doors; 'browse' is the public list behind door one.
  const [view, setView] = useState<'router' | 'browse'>('router');
  const [hosting, setHosting] = useState(false);
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
      setGuestAvatar(randomAvatar());
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
        {
          code: trimmed,
          playerName: playerName || 'Guest',
          avatar: playerAvatar,
          userId,
          // Same durable identity the room page will join with a moment later.
          // Omitting it here made the server fall back to `socket.id`, so the
          // second join looked like a stranger and the room ended up holding
          // two rows for one person. See src/lib/playerId.ts.
          playerId: getPlayerId(),
          cosmetics,
        },
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

  const hostRoom = useCallback(() => {
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
        ...HOST_DEFAULTS,
      },
      (res: { success: boolean; code?: string; error?: string }) => {
        if (res.success && res.code) router.push(`/room/${res.code}`);
        else {
          setError((res.error || 'COULD NOT FORMAT DECK').toUpperCase());
          setHosting(false);
        }
      }
    );
  }, [playerName, playerAvatar, userId, cosmetics, router]);

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
            {/* Same creator as /signup: dealt on arrival, re-rolled with the
                button on the corner. */}
            <div className="avatar-creator-box" style={{ margin: '10px 0 16px' }}>
              <div className="avatar-preview-container character-slot">
                <div id="avatar-svg-wrapper">
                  <Avatar code={guestAvatar} size={150} />
                </div>
                <button
                  id="btn-randomize-avatar"
                  type="button"
                  className="btn-circular"
                  title="Next character"
                  aria-label="Next character"
                  onClick={() => setGuestAvatar((c) => nextAvatar(c))}
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
      </Link>
      {/* Guests only. A signed-in player's face and name are the header profile
          chip that CrtShell renders next to this (see HeaderProfile) — it is
          the same information plus the menu that leads to /profile and SIGN
          OUT, so showing both put the name on screen twice and left the old
          static chip looking like the clickable one. A guest has no account to
          open, so they keep the plain read-out; their identity is editable from
          the landing page's Profile panel. */}
      {!session?.user && (
        <div
          className="coin-balance-display"
          style={{ borderColor: 'var(--neon-cyan)', background: 'rgba(0,0,0,0.6)' }}
        >
          <span style={{ marginRight: 5, display: 'inline-flex' }}>
            <Avatar code={playerAvatar} size={22} />
          </span>
          <span
            className="coin-amount"
            style={{
              // Matches .header-profile-name, which is the signed-in player's
              // version of this same chip — the two sit in the same corner and
              // must not be set in different faces.
              fontFamily: 'var(--font-ui)',
              fontWeight: 600,
              letterSpacing: '0.5px',
              fontSize: '1.1rem',
              color: 'var(--neon-cyan)',
              textShadow: 'none',
            }}
          >
            {playerName}
          </span>
        </div>
      )}
    </>
  );

  const openRooms = publicRooms.filter((r) => r.phase === 'lobby');

  return (
    <CrtShell home badge="LOBBY ROUTER" badgeColor="var(--neon-cyan)" headerExtra={headerExtra} recording>
      <section className="gartic-hero-section" style={{ padding: '20px 0' }}>
        {/* 988 = the original 900 plus the 44px of extra padding .router-box
            now carries on each side, so the panel grew and the cards did not.
            Move one of these two numbers without the other and the doors
            resize. */}
        <div className="gartic-container-wrapper" style={{ maxWidth: 988, width: '95%' }}>
          <div className="gartic-main-box router-box">
            {error && (
              <div className="word-phase-banner" style={{ display: 'block', marginBottom: 12 }}>
                ⛔ {error}
              </div>
            )}

            {view === 'router' ? (
              /* ── The three cards ──────────────────────────────────
                 Browsing the public list sits in the middle seat: it is the
                 door most people take, and the two that need something from
                 you first — a code, a decision to host — flank it. */
              <div className="deck-cards">
                {/* Holds an input, so it is a <div>: a card you type into must
                    not swallow the click that focuses the field. */}
                <div className="deck-card magenta deck-card-static">
                  <span className="deck-card-art">
                    <span className="deck-card-crowd">
                      <Avatar code="ninja" size={126} />
                    </span>
                    <span className="deck-card-glyph">🔑</span>
                  </span>
                  <span className="deck-card-label">
                    <span className="deck-card-title">
                      Enter
                      <br />
                      code
                    </span>
                    <span className="router-code-entry">
                      <input
                        id="room-code-input"
                        type="text"
                        // No `.osd-text`: that class is the VCR on-screen
                        // display — monospace with a hard 2px black shadow —
                        // which belongs on a caption over a tape, not on a
                        // field you type into. The code field takes the same
                        // type as the landing page's name field instead.
                        className="router-code-input"
                        placeholder="ABC123"
                        maxLength={6}
                        value={privateCode}
                        onChange={(e) => setPrivateCode(e.target.value.toUpperCase().slice(0, 6))}
                        onKeyDown={(e) => e.key === 'Enter' && joinByCode(privateCode)}
                      />
                      <button
                        id="join-room-btn"
                        className="btn-brutal dark router-code-btn"
                        disabled={joining || privateCode.trim().length !== 6}
                        onClick={() => joinByCode(privateCode)}
                      >
                        GO
                      </button>
                    </span>
                  </span>
                </div>

                <button
                  id="browse-public-btn"
                  className="deck-card cyan"
                  onClick={() => {
                    setError('');
                    setView('browse');
                  }}
                >
                  <span className="deck-card-art">
                    {/* The roster art doubles as card illustration — three of
                        them overlapping reads as "a room with people in it"
                        faster than any icon does. */}
                    <span className="deck-card-crowd">
                      <Avatar code="dragon" size={104} />
                      <Avatar code="penguin-pilot" size={128} />
                      <Avatar code="ninja" size={104} />
                    </span>
                  </span>
                  <span className="deck-card-label">
                    <span className="deck-card-title">
                      Public
                      <br />
                      lobbies
                    </span>
                    <span className="deck-card-note">
                      {openRooms.length === 0
                        ? 'NO DECKS ROLLING'
                        : `${openRooms.length} OPEN DECK${openRooms.length === 1 ? '' : 'S'}`}
                    </span>
                  </span>
                </button>

                {/* No form in front of this: the deck is formatted on click and
                    every setting is editable from inside the lobby (§4 scopes
                    changes to between rounds, which a fresh lobby is). */}
                <button
                  id="create-room-btn"
                  className="deck-card yellow"
                  disabled={hosting}
                  onClick={hostRoom}
                >
                  <span className="deck-card-art">
                    <span className="deck-card-crowd">
                      <Avatar code="dragon" size={126} />
                    </span>
                    <span className="deck-card-glyph">📼</span>
                  </span>
                  <span className="deck-card-label">
                    <span className="deck-card-title">
                      {hosting ? (
                        'Formatting…'
                      ) : (
                        <>
                          Host a<br />
                          lobby
                        </>
                      )}
                    </span>
                    <span className="deck-card-note">PICK THE MODE INSIDE</span>
                  </span>
                </button>
              </div>
            ) : (
              /* ── Public deck browser ──────────────────────────── */
              <div className="router-browse">
                {/* No BACK button up here. RETURN in the footer is the way out
                    of this view now (see below), and two back affordances on
                    one screen — one at the top, one at the bottom, going to
                    different places — is the thing that made RETURN read as
                    "leave the router" rather than "leave the list". */}
                <div className="router-browse-head">
                  <h3
                    className="brutal-title"
                    style={{ fontSize: '1.3rem', color: 'var(--neon-cyan)', textShadow: 'none', margin: 0 }}
                  >
                    🌐 PUBLIC TAPES ({openRooms.length})
                  </h3>
                </div>

                <div className="router-browse-list">
                  {openRooms.length === 0 && (
                    <p className="osd-text" style={{ color: '#888' }}>
                      NO PUBLIC DECKS ROLLING — HOST ONE AND THEY WILL COME.
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
                      <div key={room.code} className={`lobby-item-card${full ? ' full-lobby' : ''}`}>
                        <div className="lobby-item-meta">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="lobby-item-avatar">
                              <Avatar code={host?.avatar} size={26} />
                            </span>
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
                          {/* The mode, and — separately — whether it is running
                              on the host's own content. Custom is a switch on a
                              mode now, so it can no longer be shown *instead*
                              of one. */}
                          <span className="lobby-pill yellow">
                            {cat ? `${cat.icon} ${cat.name.toUpperCase()}` : '📼 NO MODE SET'}
                          </span>
                          {room.settings.useCustomContent && (
                            <span className="lobby-pill magenta">⚙️ CUSTOM</span>
                          )}
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
            )}

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
              {/* RETURN goes back one step, not all the way out. Behind the
                  browse door that step is the router itself; from the router
                  it is the landing page. It used to leave for `/` from both,
                  so opening the public list and pressing the only visible
                  RETURN threw away the door you had just come through.

                  A <button> in one case and a <Link> in the other, rather than
                  a button that calls router.push for both: the router → `/`
                  step is a real navigation and should stay a real link, so it
                  prefetches and answers a middle-click. */}
              {view === 'browse' ? (
                <button
                  id="btn-back-home"
                  className="btn-brutal dark"
                  style={FOOTER_BACK_STYLE}
                  onClick={() => {
                    setError('');
                    setView('router');
                  }}
                >
                  ◀ RETURN
                </button>
              ) : (
                <Link
                  href="/"
                  id="btn-back-home"
                  className="btn-brutal dark"
                  style={FOOTER_BACK_STYLE}
                >
                  ◀ RETURN
                </Link>
              )}
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
