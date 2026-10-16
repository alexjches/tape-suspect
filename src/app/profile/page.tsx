'use client';
// src/app/profile/page.tsx
// The signed-in player's identity: display name and character.
//
// This is the account-holder's version of the landing page's Profile panel. A
// guest picks a character and a name there and it goes to localStorage; an
// account holder has nowhere to do the same thing, because /dashboard is three
// doors and no form and page.tsx redirects them away from the landing page
// before it renders. The header profile chip (HeaderProfile) is the door in.
//
// Same frame as /login and /signup — a dissolved `.gartic-hero-section` holding
// one `.gartic-main-box.router-box` — because it is the fourth screen in that
// family, not a settings page in a style of its own.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import Link from 'next/link';
import { CrtShell } from '@/components/vhs/CrtShell';
import { Avatar } from '@/components/vhs/Avatar';
import { nextAvatar, toAvatarCode, FIRST_FRAME_AVATAR } from '@/lib/avatars';


export default function ProfilePage() {
  const router = useRouter();
  const { data: session, status, update } = useSession();

  // Read straight from the session rather than fetched or copied into state:
  // the JWT already carries the name and the character code, so the fields fill
  // without waiting on a round trip, and update() rewrites it in place so a save
  // anywhere in the app lands here too. /api/profile's GET exists for anything
  // that needs the row itself (the email below), and this page does not.
  //
  // characterFor() never throws, so an account predating the roster — an emoji,
  // or a composer part-code — opens the picker on a real character.
  const accountName = status === 'authenticated' ? session?.user?.name ?? '' : null;
  const accountAvatar = status === 'authenticated' ? toAvatarCode(session?.user?.image) : null;

  // Edits are an *override* of that, not a copy of it: null means "showing what
  // the account holds". The obvious alternative — copy into state, re-seed with
  // an effect — loses a half-typed name every time the player alt-tabs, because
  // next-auth refetches the session on window focus and the effect fires again
  // on a new session object. Same pattern as the landing page's Profile panel.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [avatarEdit, setAvatarEdit] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const name = nameEdit ?? accountName ?? '';
  const avatar = avatarEdit ?? accountAvatar ?? FIRST_FRAME_AVATAR;

  const trimmed = name.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 20;
  const changed = trimmed !== accountName || avatar !== accountAvatar;

  const save = useCallback(async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    setNotice('');

    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, avatar }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError((data.error || 'COULD NOT SAVE PROFILE').toUpperCase());
        setBusy(false);
        return;
      }

      // The session is a JWT, so the database row is not re-read on the next
      // request — without this the header chip, the lobby and the socket join
      // would all go on using the old name until the token expired. The jwt
      // callback in lib/auth.ts is what receives this. Values come back from
      // the API's own response rather than from the form, so what lands on the
      // token is what actually got written.
      await update({ name: data.name, picture: data.avatar });

      // Drop the overrides so the fields follow the account again. After
      // update(), so they never flicker back through the old values on the way.
      setNameEdit(null);
      setAvatarEdit(null);
      setNotice('PROFILE SAVED');
    } catch {
      setError('SOMETHING WENT WRONG');
    }
    setBusy(false);
  }, [valid, busy, trimmed, avatar, update]);

  // Signed out — including a session that expired while this tab sat open.
  // `replace`, not `push`: an account page nobody is signed in to should not be
  // somewhere the back button returns to.
  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <CrtShell home badge="PROFILE" badgeColor="var(--neon-cyan)">
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <div className="osd-text" style={{ color: 'var(--ink)' }}>
            SPOOLING UP…
          </div>
        </div>
      </CrtShell>
    );
  }

  return (
    <CrtShell home badge="PROFILE" badgeColor="var(--neon-cyan)">
      <section className="gartic-hero-section" style={{ padding: '20px 0' }}>
        <div className="gartic-container-wrapper" style={{ maxWidth: 480, width: '95%' }}>
          <div className="gartic-main-box router-box">
            <h2 className="brutal-title modal-title title-wordmark auth-title">PROFILE</h2>
            {/* Short enough for one line in a 480px box, as /login's and
                /signup's straplines are. */}
            <p className="modal-subtitle auth-subtitle">HOW OTHER PLAYERS SEE YOU</p>

            {error && (
              <div className="word-phase-banner" style={{ display: 'block', margin: '12px 0' }}>
                ⛔ {error}
              </div>
            )}
            {notice && (
              <div className="profile-notice osd-text">✅ {notice}</div>
            )}

            <label className="brutal-label">CHARACTER:</label>
            {/* The same creator as /signup and the landing page's Profile
                panel, at the same size — this is that panel for an account, so
                it must not be a different control. */}
            <div className="avatar-creator-box" style={{ margin: '8px 0 14px' }}>
              <div className="avatar-preview-container character-slot">
                <div id="avatar-svg-wrapper">
                  <Avatar code={avatar} size={120} />
                </div>
                <button
                  id="profile-avatar-btn"
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
              <div className="avatar-helper-text">CLICK TO CHANGE CHARACTER</div>
            </div>

            <label className="brutal-label" htmlFor="profile-name">
              DISPLAY NAME:
            </label>
            <input
              id="profile-name"
              type="text"
              className="brutal-input"
              value={name}
              onChange={(e) => {
                setNameEdit(e.target.value);
                setNotice('');
              }}
              placeholder="CoolNickname2774"
              minLength={2}
              maxLength={20}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />

            {/* Read-only. Changing the address an account signs in with is an
                identity change, not a cosmetic one — it wants the verification
                step signup does not have yet (see the OAuthAccountNotLinked
                note in /login), so it is deliberately not a field here. */}
            <label className="brutal-label" style={{ marginTop: 10 }}>
              EMAIL:
            </label>
            <div className="profile-readonly osd-text">{session.user?.email || '—'}</div>

            <div className="modal-actions auth-actions">
              <button
                id="profile-save-btn"
                type="button"
                className="btn-brutal green large-brutal-btn"
                disabled={!valid || !changed || busy}
                onClick={save}
              >
                {busy ? 'SAVING…' : changed ? 'SAVE ⏵' : 'SAVED'}
              </button>
            </div>

            <div className="profile-exits">
              <Link href="/dashboard" className="btn-brutal dark profile-exit-btn">
                ◀ BACK
              </Link>
              <button
                id="profile-signout-btn"
                type="button"
                className="btn-brutal dark profile-exit-btn"
                onClick={() => signOut({ callbackUrl: '/' })}
              >
                ⏏ SIGN OUT
              </button>
            </div>
          </div>
        </div>
      </section>
    </CrtShell>
  );
}
