'use client';
// src/lib/cookieConsent.ts
//
// What the player has agreed to have stored, and the plumbing that keeps every
// consumer of that answer in step.
//
// There are exactly two answers, because there are exactly two kinds of storage
// in this app:
//
//   'essential'  the NextAuth session cookie, plus the localStorage this game
//                is built on — `imposter_theme`, `imposter_player_id`,
//                `imposter_guest_name`/`_avatar`, and the guest wallet keys.
//                None of that is tracking; all of it is the thing the player
//                asked for (stay signed in, keep my character, keep my coins),
//                so it is not gated and there is no way to switch it off short
//                of not playing.
//   'all'        the above plus AdSense, which is the one third party that
//                sets cookies here and the only reason this banner exists.
//
// So the gate is narrow on purpose: `consent === 'all'` is the single condition
// on the ad script (AdScript.tsx) and on the units that fill it (AdRail.tsx).
// Nothing else in the app reads it, and nothing else should — widening it to
// cover the essential keys would mean a player who declines cannot hold a seat
// through a refresh, which is not a privacy win, it is a broken game.
//
// `null` means undecided, which is what shows the banner. That is also the
// state the app runs in on a first paint, so ads are off until asked, never on
// until refused.

import { useCallback, useEffect, useState } from 'react';

export type Consent = 'all' | 'essential';

/** Bump the key (not the values) to re-ask everyone after a policy change. */
const KEY = 'imposter_cookie_consent';

/** Fired on this tab when the choice changes; `storage` covers the others. */
const CHANGE_EVENT = 'imposter:consent';

export function readConsent(): Consent | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === 'all' || stored === 'essential' ? stored : null;
  } catch {
    // Storage blocked (private mode, or a browser setting). Undecided is the
    // right read: it keeps ads off, and the banner reappearing every load is
    // the honest consequence of not being allowed to remember the answer.
    return null;
  }
}

export function writeConsent(choice: Consent) {
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    // Same as above — the choice still holds for this session, through the
    // event below. No reason to fail louder.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/**
 * The choice, live. Three consumers hold this independently — the banner, the
 * ad script and the two rails — and the `CHANGE_EVENT` listener is what makes
 * pressing ACCEPT ALL light the gutters up without a reload.
 *
 * `ready` starts false and the value starts null for the reason ThemeToggle's
 * does: every route here is prerendered, so reading localStorage during render
 * would put one answer in the static HTML and possibly another at hydration.
 * Consumers must render nothing identity-dependent until `ready` — otherwise a
 * player who accepted last week gets a frame of the banner on every load.
 */
export function useConsent() {
  const [consent, setConsent] = useState<Consent | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setConsent(readConsent());
    sync();
    setReady(true);
    window.addEventListener(CHANGE_EVENT, sync);
    // Fires only in *other* tabs, which is exactly the gap the custom event
    // above cannot cover: two lobbies open, consent changed in one of them.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const choose = useCallback((next: Consent) => {
    writeConsent(next);
    setConsent(next);
  }, []);

  return { consent, ready, choose };
}
