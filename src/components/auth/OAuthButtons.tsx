'use client';
// src/components/auth/OAuthButtons.tsx
// The Google / Apple buttons shared by /login and /signup.
//
// Spec §11: email, Google and Apple. Both OAuth providers are spliced into
// authOptions only when their env vars exist, so the buttons are driven off
// what the server actually has rather than hardcoded — an unconfigured
// provider would otherwise render a button that only produces an error page.
//
// One flow serves both pages on purpose: an OAuth "sign in" for an unknown
// account *is* the sign-up, so there is nothing for /signup to do differently.

import { useEffect, useState, type ReactNode } from 'react';
import { getProviders, signIn } from 'next-auth/react';

// Google's four-colour mark, drawn rather than fetched: the artwork is fixed
// and tiny, and a remote logo on the sign-in screen is a third-party request on
// the one page a player is about to type a password into.
//
// Google's brand guidelines require the mark in full colour and unmodified, so
// it cannot take the button's ink the way the Apple glyph does — which is what
// the white tile below is for. On a saturated button the four colours have
// nothing to read against.
const GOOGLE_MARK = (
  <svg viewBox="0 0 48 48" width={18} height={18} aria-hidden="true" focusable="false">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.97-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19Z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"
    />
  </svg>
);

// Apple's is one path and monochrome by specification — black on light, white
// on dark — so it sits on the same white tile in the roster's ink rather than
// getting a treatment of its own. A logo on one button and none on the other
// reads as an unfinished screen.
const APPLE_MARK = (
  <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" focusable="false">
    <path
      fill="#000000"
      d="M16.36 12.72c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.42-.14-2.76.83-3.48.83-.72 0-1.82-.81-2.99-.79-1.54.02-2.96.89-3.75 2.27-1.6 2.77-.41 6.88 1.15 9.13.76 1.1 1.67 2.34 2.86 2.29 1.15-.05 1.58-.74 2.97-.74 1.39 0 1.78.74 2.99.72 1.23-.02 2.01-1.12 2.76-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.42-3.64ZM14.1 5.95c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.68-1.09 1.76-.95 2.8 1.01.08 2.04-.52 2.67-1.28Z"
    />
  </svg>
);

const OAUTH_BUTTONS: {
  id: string;
  label: string;
  className: string;
  mark: ReactNode;
}[] = [
  { id: 'google', label: 'CONTINUE WITH GOOGLE', className: 'btn-brutal cyan', mark: GOOGLE_MARK },
  { id: 'apple', label: 'CONTINUE WITH APPLE', className: 'btn-brutal dark', mark: APPLE_MARK },
];

export function OAuthButtons({
  idPrefix,
  callbackUrl = '/dashboard',
}: {
  /** Keeps the button ids unique per page, as the rest of the app does. */
  idPrefix: string;
  callbackUrl?: string;
}) {
  const [enabled, setEnabled] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    getProviders().then((providers) => {
      setEnabled(Object.keys(providers ?? {}));
    });
  }, []);

  const buttons = OAUTH_BUTTONS.filter((p) => enabled.includes(p.id));
  if (buttons.length === 0) return null;

  return (
    <>
      <div
        className="osd-text"
        style={{ textAlign: 'center', color: 'var(--ink-soft)', margin: '14px 0 10px' }}
      >
        ─── OR ───
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {buttons.map((p) => (
          <button
            key={p.id}
            id={`${idPrefix}-${p.id}-btn`}
            type="button"
            className={`${p.className} oauth-btn`}
            disabled={pending !== null}
            onClick={() => {
              // No `redirect: false` here: the whole point is to leave for the
              // provider, so this component never sees the result. `pending`
              // only covers the moment before the browser navigates away.
              setPending(p.id);
              signIn(p.id, { callbackUrl });
            }}
          >
            {/* The mark stays put while the label changes — a logo that
                disappears on click reads as the button breaking. */}
            <span className="oauth-mark">{p.mark}</span>
            <span className="oauth-btn-label">
              {pending === p.id ? 'REDIRECTING…' : p.label}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
