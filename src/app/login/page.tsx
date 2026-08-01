'use client';
// src/app/login/page.tsx
// Access console styled on the identity modal in vhs-frontend-example/home.html.

import { useEffect, useState } from 'react';
import { signIn, getProviders } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CrtShell } from '@/components/vhs/CrtShell';

// Spec §11: email, Google and Apple. Both OAuth providers are spliced into
// authOptions only when their env vars exist, so the buttons are driven off
// what the server actually has rather than hardcoded — an unconfigured
// provider would otherwise render a button that only produces an error page.
const OAUTH_BUTTONS = [
  { id: 'google', label: 'CONTINUE WITH GOOGLE', className: 'btn-brutal cyan' },
  { id: 'apple', label: 'CONTINUE WITH APPLE', className: 'btn-brutal dark' },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [enabledOauth, setEnabledOauth] = useState<string[]>([]);

  useEffect(() => {
    getProviders().then((providers) => {
      setEnabledOauth(Object.keys(providers ?? {}));
    });
  }, []);

  const oauthButtons = OAUTH_BUTTONS.filter((p) => enabledOauth.includes(p.id));

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
      <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 20 }}>
        <div className="modal-card" style={{ maxWidth: 440 }}>
          <h2 className="brutal-title modal-title">📼 INSERT PROFILE CASSETTE</h2>
          <p className="modal-subtitle">SIGN IN TO YOUR ACCOUNT</p>

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

            <div className="modal-actions">
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

          {oauthButtons.length > 0 && (
            <>
              <div
                className="osd-text"
                style={{ textAlign: 'center', color: 'var(--ink-soft)', margin: '14px 0 10px' }}
              >
                ─── OR ───
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {oauthButtons.map((p) => (
                  <button
                    key={p.id}
                    id={`login-${p.id}-btn`}
                    type="button"
                    className={p.className}
                    onClick={() => signIn(p.id, { callbackUrl: '/dashboard' })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <p className="osd-text" style={{ textAlign: 'center', color: 'var(--ink-soft)', marginTop: 16 }}>
            NO ACCOUNT?{' '}
            <Link href="/signup" style={{ color: 'var(--link-accent)' }}>
              FORMAT A NEW ONE
            </Link>
            {' · '}
            <Link href="/" style={{ color: 'var(--ink-soft)' }}>
              HOME
            </Link>
          </p>
        </div>
      </div>
    </CrtShell>
  );
}
