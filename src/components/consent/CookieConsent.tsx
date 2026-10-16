'use client';
// src/components/consent/CookieConsent.tsx
//
// The consent bar. Asked once per browser, and once answered it never appears
// again — there is deliberately no way back to it, which is why there is no
// reopen event, no close button and no "currently:" read-out. Changing a stored
// answer means clearing site data.
//
// That is an owner's decision and worth naming, since the code cannot: "as easy
// to withdraw as to give" is an explicit requirement under GDPR/ePrivacy, and a
// header control (the shape this had) is the usual way to satisfy it. If it
// comes back, it is a button that calls `writeConsent(null)`-equivalent — i.e.
// re-expose an open event here and render a control from CrtShell's
// `.header-controls`, `home` routes only.
//
// Rendered from layout.tsx rather than from CrtShell, so it appears on every
// route including mid-round: a player whose first URL is /room/ABC123 must get
// the same question as one who came through the landing page.
//
// It is a bar, not a blocking overlay. Nothing loads without consent — the ad
// script is gated on the answer rather than on the bar being dismissed — so
// there is nothing to protect by trapping the player behind it, and a modal
// over a lobby that is waiting on a websocket is worse than the question.
//
// It sits *outside* #crt-viewport, which is `position: fixed` with `z-index:
// 10`; the bar's own 1000 is what puts it over the frame and over the header
// profile menu's 500.

import { useConsent } from '@/lib/cookieConsent';

export function CookieConsent() {
  const { consent, ready, choose } = useConsent();

  // Nothing until an effect has read the real answer — see useConsent. Without
  // the guard, a player who answered last week gets a frame of the bar on every
  // load, and this one has no dismiss control to recover with.
  if (!ready) return null;
  if (consent !== null) return null;

  return (
    <div
      className="cookie-banner"
      role="region"
      aria-labelledby="cookie-banner-title"
    >
      <div className="cookie-banner-copy">
        <h2 id="cookie-banner-title" className="cookie-banner-title">
          🍪 COOKIES
        </h2>
        <p className="cookie-banner-text">
          We keep a sign-in cookie and a little local storage so your character,
          your seat in a room and your coins survive a refresh — that part is
          what makes the game work. Accepting also lets our ad partner use
          cookies to choose the ads in the gutters.
        </p>
      </div>

      {/* Accept is the primary and reads as one: first in the order, the
          accent fill, the full drop. Essential-only is the secondary — an
          outline key in the same shape and the same row, deliberately still a
          plain visible button with real ink rather than a ghost link, because
          the answer a player is nudged away from still has to be one they can
          see and press. Owner's call; equal prominence is the more cautious
          reading of GDPR/ePrivacy and is what this started as. */}
      <div className="cookie-banner-actions">
        <button
          type="button"
          className="btn-brutal magenta cookie-btn cookie-btn-primary"
          onClick={() => choose('all')}
        >
          ACCEPT ALL
        </button>
        {/* No `dark` class: .btn-brutal on its own supplies no fill and no
            shadow, so the outline treatment in globals.css is a plain override
            rather than a specificity fight with the EDGE LANGUAGE block. */}
        <button
          type="button"
          className="btn-brutal cookie-btn cookie-btn-secondary"
          onClick={() => choose('essential')}
        >
          ESSENTIAL ONLY
        </button>
      </div>
    </div>
  );
}
