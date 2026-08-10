'use client';
// src/app/signup/page.tsx
// Account creation, styled on the identity modal in
// vhs-frontend-example/home.html.

import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { randomAvatar, nextAvatar } from '@/lib/avatars';
import { CrtShell } from '@/components/vhs/CrtShell';
import { Avatar } from '@/components/vhs/Avatar';
import { OAuthButtons } from '@/components/auth/OAuthButtons';

// Shown for the single frame between the prerendered HTML and the first roll.
const FIRST_FRAME_AVATAR = 'c00';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Dealt on arrival rather than chosen from a grid — nobody should have to
  // pick before they can play. The button on the corner steps through the
  // roster in order, so browsing the whole cast is a predictable click rather
  // than a slot machine that can show you the same one twice.
  //
  // The first deal is deliberately deferred to an effect. This page is
  // prerendered, so calling Math.random() during render would bake one
  // character into the static HTML and pick a different one at hydration,
  // and React would tear the DOM to reconcile them.
  const [avatar, setAvatar] = useState<string>(FIRST_FRAME_AVATAR);
  useEffect(() => setAvatar(randomAvatar()), []);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server re-vets the code before storing it.
        body: JSON.stringify({ name, email, password, avatar }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError((data.error || 'SIGNUP FAILED').toUpperCase());
        setLoading(false);
        return;
      }

      await signIn('credentials', { email, password, redirect: false });
      router.push('/dashboard');
    } catch {
      setError('SOMETHING WENT WRONG');
      setLoading(false);
    }
  }

  return (
    <CrtShell home badge="SIGN UP" badgeColor="var(--neon-green)">
      {/* Same frame as /login, and for the same reasons — see the note there.
          The two pages are one screen with different fields on it, so every
          value they share is deliberately the same value: 480px, the wordmark
          heading at `.auth-title`'s size, `.auth-subtitle`'s trimmed margin and
          `.auth-actions`' 24px above the submit. This page used to be 500px
          wide with a plain 2rem `.modal-title` and a tape-jargon heading, so
          walking /login → /signup shifted the box and changed the type. */}
      <section className="gartic-hero-section" style={{ padding: '20px 0' }}>
        <div className="gartic-container-wrapper" style={{ maxWidth: 480, width: '95%' }}>
          <div className="gartic-main-box router-box">
            {/* Plain words, as on /login: "FORMAT NEW PROFILE" is in the app's
                voice but it does not say what the page does, and this is one of
                the two screens where a player is being asked for credentials. */}
            <h2 className="brutal-title modal-title title-wordmark auth-title">SIGN UP</h2>
            <p className="modal-subtitle auth-subtitle">CREATE YOUR ACCOUNT</p>

            {error && (
              <div className="word-phase-banner" style={{ display: 'block', margin: '12px 0' }}>
                ⛔ {error}
              </div>
            )}

            <form onSubmit={handleSubmit} id="signup-form">
              <label className="brutal-label">CHARACTER:</label>
              {/* Markup from vhs-frontend-example/home.html — the container
                  positions .btn-circular over its bottom-right corner. The
                  .character-slot modifier strips the white disc, which framed
                  an emoji but crops these characters (see globals.css). */}
              {/* 120, not 150. The character picker is the one field /login
                  does not have, so it is what decides whether the two screens
                  feel like the same object — at 150 it was half the card and
                  the email/password rhythm underneath read as an afterthought.
                  Small enough to sit in the stack, large enough to tell the
                  roster apart. */}
              <div className="avatar-creator-box" style={{ margin: '8px 0 14px' }}>
                <div className="avatar-preview-container character-slot">
                  <div id="avatar-svg-wrapper">
                    <Avatar code={avatar} size={120} />
                  </div>
                  <button
                    id="btn-randomize-avatar"
                    type="button"
                    className="btn-circular"
                    title="Next character"
                    aria-label="Next character"
                    onClick={() => setAvatar((c) => nextAvatar(c))}
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

              <label className="brutal-label" htmlFor="signup-name">
                NICKNAME:
              </label>
              <input
                id="signup-name"
                type="text"
                className="brutal-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CoolNickname2774"
                required
                minLength={2}
                maxLength={20}
              />

              <label className="brutal-label" style={{ marginTop: 10 }} htmlFor="signup-email">
                EMAIL:
              </label>
              <input
                id="signup-email"
                type="email"
                className="brutal-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />

              <label className="brutal-label" style={{ marginTop: 10 }} htmlFor="signup-password">
                PASSWORD:
              </label>
              <input
                id="signup-password"
                type="password"
                className="brutal-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                required
                minLength={6}
              />

              <div className="modal-actions auth-actions">
                <button
                  id="signup-submit-btn"
                  type="submit"
                  className="btn-brutal green large-brutal-btn"
                  disabled={loading}
                >
                  {loading ? 'FORMATTING…' : 'SIGN UP ⏵'}
                </button>
              </div>
            </form>

            {/* An OAuth account is created on first sign-in, so the same button
                serves both pages. The character picker above doesn't apply to
                it — a provider account is dealt a random avatar. */}
            <OAuthButtons idPrefix="signup" />

            {/* One link, mirroring /login's — the HOME link that used to sit
                beside it was a third exit competing with the header wordmark
                (the way out of every screen in the app) and with the one thing
                this page is for. No marginTop either: the box is a flex column
                with a 20px gap, and an inline margin stacked on top of it. */}
            <p className="osd-text" style={{ textAlign: 'center', color: 'var(--ink-soft)' }}>
              {/* Short enough to stay on one line in a 480px box, which
                  "ALREADY HAVE AN ACCOUNT?" was not — it wrapped with SIGN IN
                  alone on the second row. /login's counterpart is one line. */}
              HAVE AN ACCOUNT?{' '}
              <Link href="/login" style={{ color: 'var(--link-accent)' }}>
                SIGN IN
              </Link>
            </p>
          </div>
        </div>
      </section>
    </CrtShell>
  );
}
