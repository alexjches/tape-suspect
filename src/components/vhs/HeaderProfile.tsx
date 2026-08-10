'use client';
// src/components/vhs/HeaderProfile.tsx
// The signed-in player's chip in the top right of the header, and the menu it
// opens: PROFILE (name and character) and SIGN OUT.
//
// It lives in the shell rather than in one page's `headerExtra` for the same
// reason ThemeToggle does — it has to be in the same corner on every screen
// that has one, or "click your face" is advice that only works on /dashboard.
// It renders on `home` routes only: the in-game screens are a round in
// progress, and an unlabelled route out of one sitting beside the room code is
// exactly what LobbyScreen's LEAVE button exists to be instead.
//
// Nothing renders while signed out. The guest's identity lives in localStorage
// and is edited on the landing page's Profile panel, which is the door this
// mirrors for an account.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import { Avatar } from './Avatar';

export function HeaderProfile() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else and on Escape. Both are registered only
  // while the menu is open, so a shut menu costs no listeners on a page that
  // may be running a socket.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (status !== 'authenticated' || !session?.user) return null;

  const name = session.user.name || 'PLAYER';
  // `image` is a roster character code, not a URL — see the jwt callback in
  // lib/auth.ts, which normalises it from whichever provider signed you in.
  // Avatar's characterFor() never throws, so an account older than the roster
  // still resolves to a face.
  const avatar = session.user.image;

  return (
    <div className="header-profile" ref={wrapRef}>
      <button
        id="header-profile-btn"
        type="button"
        className="header-profile-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="header-profile-face">
          <Avatar code={avatar} size={26} />
        </span>
        <span className="header-profile-name">{name}</span>
        <span className={`header-profile-caret${open ? ' open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="header-profile-menu" role="menu">
          <button
            id="header-profile-edit"
            type="button"
            role="menuitem"
            className="header-profile-item"
            onClick={() => {
              setOpen(false);
              router.push('/profile');
            }}
          >
            <span aria-hidden="true">🎭</span> PROFILE
          </button>
          <button
            id="header-profile-signout"
            type="button"
            role="menuitem"
            className="header-profile-item danger"
            onClick={() => {
              setOpen(false);
              signOut({ callbackUrl: '/' });
            }}
          >
            <span aria-hidden="true">⏏</span> SIGN OUT
          </button>
        </div>
      )}
    </div>
  );
}
