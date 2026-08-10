'use client';
// src/app/login/page.tsx
// Access console styled on the identity modal in vhs-frontend-example/home.html.

import { Suspense, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CrtShell } from '@/components/vhs/CrtShell';
import { OAuthButtons } from '@/components/auth/OAuthButtons';

// NextAuth sends every provider failure back here as ?error=<code> (see the
// `pages.error` route in lib/auth.ts). Left unread, a bounced Google sign-in
// looks like the button simply did nothing.
const OAUTH_ERRORS: Record<string, string> = {
  // The one a real player will actually hit: they made an email/password
  // account first, and the same address now arrives from a provider. Linking
  // it automatically would be a takeover route, because signup does not verify
  // the address — anyone can register someone else's email and wait to inherit
  // their Google sign-in. So we make them use the password they set.
  OAuthAccountNotLinked:
    'THAT EMAIL ALREADY HAS A PASSWORD ACCOUNT — SIGN IN WITH IT BELOW',
  OAuthSignin: 'COULD NOT REACH THE SIGN-IN PROVIDER',
  OAuthCallback: 'THE PROVIDER SENT BACK AN INVALID RESPONSE',
  OAuthCreateAccount: 'COULD NOT CREATE AN ACCOUNT FROM THAT PROVIDER',
  Callback: 'SIGN-IN WAS INTERRUPTED — TRY AGAIN',
  AccessDenied: 'ACCESS DENIED BY THE PROVIDER',
  Configuration: 'SIGN-IN IS MISCONFIGURED ON THE SERVER',
};

function LoginConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const oauthError = searchParams.get('error');
  useEffect(() => {
    if (oauthError) {
      setError(OAUTH_ERRORS[oauthError] ?? 'SIGN-IN FAILED — TRY AGAIN');
    }
  }, [oauthError]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const result = await signIn('credentials', { email, password, redirect: false });
    setLoading(false);

    if (result?.error) setError('INVALID EMAIL OR PASSWORD');
    else router.push('/dashboard');
  }

  return (
    <CrtShell home badge="SIGN IN" badgeColor="var(--neon-cyan)">
      {/* The same frame as the landing box, /dashboard's router and the 404:
          a dissolved section holding one `.gartic-main-box.router-box`. This
          screen used to be a `.modal-card`, which is the wrong object twice
          over — it is a dialog treatment on a page that is not a dialog, and
          `.modal-card` carries `transform: translateY(-20px) scale(0.95)` that
          only `.modal-overlay.active-modal` resets, so outside an overlay it
          rendered permanently 20px high and at 95%. */}
      <section className="gartic-hero-section" style={{ padding: '20px 0' }}>
        <div className="gartic-container-wrapper" style={{ maxWidth: 480, width: '95%' }}>
          <div className="gartic-main-box router-box">
            {/* Plain words, not tape jargon. "INSERT PROFILE CASSETTE" is in
                the app's voice but it does not say what the page does, and this
                is the one screen where a player is being asked for
                credentials — the least good place to be cute. */}
            <h2 className="brutal-title modal-title title-wordmark auth-title">SIGN IN</h2>
            <p className="modal-subtitle auth-subtitle">SIGN IN TO YOUR ACCOUNT</p>

            {error && (
              <div className="word-phase-banner" style={{ display: 'block', margin: '12px 0' }}>
                ⛔ {error}
              </div>
            )}

            <form onSubmit={handleSubmit} id="login-form">
              <label className="brutal-label" htmlFor="login-email">
                EMAIL:
              </label>
              <input
                id="login-email"
                type="email"
                className="brutal-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />

              <label className="brutal-label" style={{ marginTop: 10 }} htmlFor="login-password">
                PASSWORD:
              </label>
              <input
                id="login-password"
                type="password"
                className="brutal-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />

              <div className="modal-actions auth-actions">
                <button
                  id="login-submit-btn"
                  type="submit"
                  className="btn-brutal green large-brutal-btn"
                  disabled={loading}
                >
                  {loading ? 'READING TAPE…' : 'SIGN IN ⏵'}
                </button>
              </div>
            </form>

            <OAuthButtons idPrefix="login" />

            {/* No HOME link. The header wordmark is the way out of every screen
                in the app, so a second one at the foot of this card was a
                duplicate exit competing with the one thing this page is for. */}
            {/* No marginTop: the box is a flex column with a 20px gap, and the
                inline 16px stacked on top of it, which is what pushed this so
                far off the button. Spacing here is the container's job. */}
            <p className="osd-text" style={{ textAlign: 'center', color: 'var(--ink-soft)' }}>
              NO ACCOUNT?{' '}
              <Link href="/signup" style={{ color: 'var(--link-accent)' }}>
                SIGN UP
              </Link>
            </p>
          </div>
        </div>
      </section>
    </CrtShell>
  );
}

// useSearchParams needs a Suspense boundary above it or `next build` refuses
// to prerender this route.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginConsole />
    </Suspense>
  );
}
