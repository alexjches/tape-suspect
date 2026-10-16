'use client';
// src/components/home/LandingHero.tsx
// Landing "Access Deck" box — mirrors #hero-section in
// vhs-frontend-example/home.html (spec section 21).
//
// The Access Deck is the identity step itself now, not a menu in front of it:
// character, name, START. There is no "play as guest" door because guest *is*
// the default path — signing in is the exception, and it lives in the header
// (see page.tsx) rather than inside this panel, so nothing competes with START
// for the eye on the way into a round.
//
// The panel is the same panel whether or not you are signed in; what changes is
// which store it reads and writes. A guest's identity is the two localStorage
// keys the /dashboard guest gate reads (imposter_guest_name /
// imposter_guest_avatar), which is what makes that gate fall through instead of
// asking the identical questions a second time. An account's identity is the
// User row, seeded here from the session by page.tsx and written back through
// /api/profile — the same endpoint /profile uses.
//
// Both stores are written by the same button, on the same event: START. A
// guest's character and name are not committed until then either, so making an
// account save on some other trigger would be the panel behaving differently
// for the two kinds of player. What does change is the label — see below.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useShop } from '@/hooks/useShop';
import { Avatar } from '@/components/vhs/Avatar';
import { randomAvatar, nextAvatar, toAvatarCode, FIRST_FRAME_AVATAR } from '@/lib/avatars';

/** The signed-in player's stored identity, or null for a guest. */
export interface LandingAccount {
  name: string;
  /** Roster character code, already normalised by page.tsx. */
  avatar: string;
}


const SLIDES = [
  {
    title: '1. INSERT TAPE',
    desc: 'Everyone loads a tape and watches. One of them is formatted differently — that player is the Suspect.',
    graphic: (
      <div
        className="vhs-tape shop-tape-preview"
        style={{
          backgroundColor: '#0d0d1a',
          borderColor: '#00f0ff',
          width: 140,
          margin: '0 auto',
        }}
      >
        <div
          className="tape-tag"
          style={{ background: '#00f0ff', color: '#000', fontSize: '0.6rem' }}
        >
          TAPE_01
        </div>
        <div className="tape-window-panel" style={{ marginTop: 5 }}>
          <div className="spool spinning">
            <div className="spool-gear" />
          </div>
          <div className="spool spinning">
            <div className="spool-gear" />
          </div>
        </div>
      </div>
    ),
  },
  {
    title: '2. WATCH THE FEED',
    desc: 'The tape rolls for everyone at once. No pausing, no scrubbing — watch closely.',
    graphic: (
      <div className="crt-mini-screen">
        <div className="rec-icon">● PLAY</div>
        <div className="static-mini" />
        <span className="mini-glitch-text">VIDEO FEED</span>
      </div>
    ),
  },
  {
    title: '3. ONE WORD EACH',
    desc: 'Take turns describing what you saw in a single word. 10 seconds on the clock, then it passes on.',
    graphic: (
      <>
        <div className="chat-mini-bubble">
          <span className="chat-author" style={{ color: 'var(--neon-magenta)' }}>
            Alex:
          </span>{' '}
          &quot;fireworks&quot;
        </div>
        <div className="chat-mini-bubble right">
          <span className="chat-author" style={{ color: 'var(--neon-cyan)' }}>
            Sam:
          </span>{' '}
          &quot;…fireworks?&quot;
        </div>
      </>
    ),
  },
  {
    title: '4. EJECT THE SUSPECT',
    desc: 'Ninety seconds to argue and vote. Catch the Suspect and the crew wins — miss and they walk.',
    graphic: (
      <div className="eject-graphic">
        <div className="eject-button-mini">⏏ EJECT</div>
        <div className="ejecting-mini-tape">📼 SUSPECT_TAPE</div>
      </div>
    ),
  },
];

export function LandingHero({ account = null }: { account?: LandingAccount | null }) {
  const router = useRouter();
  const { coins } = useShop();
  const { data: session, status, update } = useSession();
  const [slide, setSlide] = useState(0);
  const [mounted, setMounted] = useState(false);

  // ── Where the panel's *baseline* identity comes from ────────────────────
  //
  // The `account` prop is the server's answer at the moment this route's RSC
  // payload was built, and the App Router caches that payload: save on
  // /profile, navigate back here, and you get the old name and face until a
  // hard reload rebuilds it. That was a real bug, and reaching for
  // router.refresh() would only paper over it — the prop is a snapshot by
  // construction, and any other route that writes the profile reintroduces it.
  //
  // The session is the live copy instead: update() rewrites it in place, and
  // every consumer in the tree — this panel, the header chip — sees the new
  // value in the same commit. The prop is kept for exactly one job: covering
  // the window before the session resolves, so a signed-in player's name and
  // face are in the first paint rather than arriving a frame later over an
  // empty field. During `loading` the two agree except in the stale case, and
  // in the stale case the prop is still the better guess than nothing.
  const sessionUser = status === 'authenticated' ? session?.user : null;
  const accountName =
    status === 'loading' ? account?.name ?? null : sessionUser ? sessionUser.name ?? '' : null;
  const accountAvatar =
    status === 'loading'
      ? account?.avatar ?? null
      : sessionUser
        ? toAvatarCode(sessionUser.image)
        : null;
  const signedIn = accountName !== null;

  // ── …and how an edit sits on top of it ──────────────────────────────────
  //
  // The fields are an *override* of the baseline rather than a copy of it:
  // null means "showing what the account holds". Copying into state and
  // re-syncing with an effect is the obvious alternative and it is worse twice
  // over — it repaints once with the stale value before the effect corrects
  // it, and next-auth refetches the session on window focus, so any effect
  // that re-seeds on a new session object would wipe a half-typed name every
  // time the player alt-tabs. An override cannot do either: it is only ever
  // cleared deliberately, on a successful save.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [avatarEdit, setAvatarEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // A guest's baseline is localStorage, which the server cannot read — hence
  // the mount effect below and FIRST_FRAME_AVATAR rather than a value seeded
  // during render.
  const [guestBase, setGuestBase] = useState({ name: '', avatar: FIRST_FRAME_AVATAR });

  const baseName = signedIn ? accountName! : guestBase.name;
  const baseAvatar = signedIn ? accountAvatar! : guestBase.avatar;
  const name = nameEdit ?? baseName;
  const avatar = avatarEdit ?? baseAvatar;

  // Coins come from localStorage for a guest, so hold the SSR value until
  // after mount — and so does a guest's identity.
  useEffect(() => {
    setMounted(true);
    // A signed-in player's identity is the account, not whatever guest keys an
    // earlier session left behind. Reading them here would show the face of a
    // guest this browser used to be, and START would then write it to the
    // account — a rename nobody asked for.
    if (signedIn) return;
    setGuestBase({
      name: localStorage.getItem('imposter_guest_name') ?? '',
      avatar: localStorage.getItem('imposter_guest_avatar') || randomAvatar(),
    });
  }, [signedIn]);

  const trimmed = name.trim();
  const ready = trimmed.length >= 2;
  // Only meaningful when signed in: whether START has a save to do before it
  // routes, which is also what the button labels itself with. Compared against
  // the live baseline, so a stale prop cannot make an unchanged panel offer to
  // save — or a changed one fail to.
  const dirty = signedIn && (trimmed !== baseName || avatar !== baseAvatar);

  const start = useCallback(async () => {
    const value = name.trim();
    if (value.length < 2 || saving) return;
    setError('');

    if (signedIn) {
      // Skipped when nothing changed, so pressing START to go and play is not
      // a database write.
      if (value !== baseName || avatar !== baseAvatar) {
        setSaving(true);
        try {
          const res = await fetch('/api/profile', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: value, avatar }),
          });
          const data = await res.json();
          if (!res.ok) {
            setError((data.error || 'COULD NOT SAVE PROFILE').toUpperCase());
            setSaving(false);
            return;
          }
          // The session is a JWT, so the row is not re-read on the next
          // request — without this the header chip and the socket join would
          // both go on using the old identity. See the jwt callback in
          // lib/auth.ts, and the same call in /profile.
          await update({ name: data.name, picture: data.avatar });
          // Drop the overrides so the panel follows the account again. Doing
          // this *after* update() means the fields never flicker back through
          // the old baseline on the way.
          setNameEdit(null);
          setAvatarEdit(null);
        } catch {
          setError('SOMETHING WENT WRONG');
          setSaving(false);
          return;
        }
        setSaving(false);
      }
      // No `?guest=1`: that flag is what puts /dashboard's guest gate in front
      // of the router, and a signed-in player has already answered it.
      router.push('/dashboard');
      return;
    }

    localStorage.setItem('imposter_guest_name', value);
    localStorage.setItem('imposter_guest_avatar', avatar);
    router.push('/dashboard?guest=1');
  }, [name, avatar, router, signedIn, baseName, baseAvatar, saving, update]);

  const go = useCallback((n: number) => {
    setSlide((s) => (s + n + SLIDES.length) % SLIDES.length);
  }, []);

  // Auto-advance, but stop the moment the visitor takes control.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setSlide((s) => (s + 1) % SLIDES.length), 6000);
    return () => clearInterval(id);
  }, [paused]);

  const takeControl = (fn: () => void) => () => {
    setPaused(true);
    fn();
  };

  return (
    <section id="hero-section" className="gartic-hero-section">
      <div className="gartic-container-wrapper">
        <div className="gartic-main-box">
          <div className="gartic-logo-top">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Tape Suspect" className="gartic-logo-img" />
          </div>

          <div className="gartic-inner-grid">
            {/* ── Access Deck ─────────────────────────────────── */}
            <div className="gartic-panel play-setup-panel">
              <h3 className="gartic-panel-title">Profile</h3>

              <div className="access-identity">
                <div className="avatar-creator-box">
                  <div className="avatar-preview-container character-slot">
                    <div id="avatar-svg-wrapper">
                      <Avatar code={avatar} size={168} />
                    </div>
                    {/* Steps the roster in order rather than randomising:
                        browsing the cast should be predictable, not a slot
                        machine that can repeat the face you just left. */}
                    <button
                      id="hero-avatar-btn"
                      type="button"
                      className="btn-circular"
                      title="Next character"
                      aria-label="Next character"
                      onClick={() => setAvatarEdit(nextAvatar(avatar))}
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
                  <div className="avatar-helper-text">TAP TO CHANGE CHARACTER</div>
                  {/* Signed in, the panel is editing an account rather than a
                      throwaway identity, so it says whose it is. Deliberately
                      not a second heading: the panel is already titled
                      "Profile" and this is one line of caption under it. */}
                  {signedIn && (
                    <div className="avatar-helper-text access-account-note">
                      SIGNED IN — SAVED TO YOUR ACCOUNT
                    </div>
                  )}
                </div>

                <div className="access-name-row">
                  <input
                    id="hero-name-input"
                    type="text"
                    className="brutal-input access-name-input"
                    value={name}
                    onChange={(e) => {
                      setNameEdit(e.target.value);
                      setError('');
                    }}
                    placeholder="YOUR NAME"
                    maxLength={20}
                    aria-label="Your name"
                    onKeyDown={(e) => e.key === 'Enter' && start()}
                  />
                  {/* The label is what tells a signed-in player their edits are
                      not lost — the panel has no SAVE button of its own, and
                      adding one would put a second control beside START on the
                      screen whose whole job is START. When nothing has been
                      touched it stays the plain word, so the extra promise only
                      appears when there is something to promise. */}
                  <button
                    id="hero-start-btn"
                    className="btn-brutal green access-start-btn"
                    disabled={!ready || saving}
                    onClick={start}
                  >
                    {saving ? 'SAVING…' : dirty ? 'SAVE & START ⏵' : 'START ⏵'}
                  </button>
                </div>

                {error && (
                  <div className="access-error osd-text" role="alert">
                    ⛔ {error}
                  </div>
                )}
              </div>
            </div>

            {/* ── How to play ─────────────────────────────────── */}
            <div className="gartic-panel how-to-play-panel">
              <h3 className="gartic-panel-title">How To Play</h3>

              <div className="carousel-container">
                <div className="carousel-track">
                  {SLIDES.map((s, i) => (
                    <div
                      key={s.title}
                      className={`carousel-slide${i === slide ? ' active-slide' : ''}`}
                    >
                      <div className="slide-graphic">{s.graphic}</div>
                      <div className="slide-content">
                        <h4 className="slide-title">{s.title}</h4>
                        <p className="slide-desc">{s.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="carousel-controls">
                  <button
                    className="carousel-arrow prev-arrow"
                    aria-label="Previous slide"
                    onClick={takeControl(() => go(-1))}
                  >
                    ◀
                  </button>
                  <div className="carousel-dots">
                    {SLIDES.map((s, i) => (
                      <span
                        key={s.title}
                        role="button"
                        tabIndex={0}
                        aria-label={`Slide ${i + 1}`}
                        className={`carousel-dot${i === slide ? ' active-dot' : ''}`}
                        onClick={takeControl(() => setSlide(i))}
                        onKeyDown={(e) => e.key === 'Enter' && takeControl(() => setSlide(i))()}
                      />
                    ))}
                  </div>
                  <button
                    className="carousel-arrow next-arrow"
                    aria-label="Next slide"
                    onClick={takeControl(() => go(1))}
                  >
                    ▶
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="gartic-box-footer">
            <div className="balance-pill">
              <span className="coin-icon">🪙</span>
              <span className="box-coin-amount">{mounted ? coins : 0}</span>
              <span className="coin-label">REWIND COINS</span>
            </div>
            <button
              id="hero-shop-btn"
              className="scroll-to-shop-link"
              onClick={() => router.push('/shop')}
            >
              <span>🛒</span> ENTER COSMETICS SHOP
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
