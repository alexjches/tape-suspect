'use client';
// src/components/ads/AdRail.tsx
//
// A skyscraper ad unit parked in the empty gutter beside the page's content
// box. Rendered by CrtShell on the `home` routes only (landing, dashboard,
// auth, shop) — the in-game screens are full-bleed and have no gutter to sit
// in, and an ad over a round in progress is not a gap, it is the game.
//
// Spec §13 asks for interstitials between rounds and rewarded ads; these rails
// are an addition to that, not a replacement for it.
//
// Whether there is *room* is a CSS question, not a React one: `.ad-rail` is
// display:none until the viewport is wide enough for a 160px column plus its
// margin beside that route's content box. See globals.css.

import { useEffect, useRef } from 'react';

/** Publisher id, e.g. `ca-pub-1234567890123456`. Unset ⇒ no live ads. */
const CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT;

const SLOTS: Record<'left' | 'right', string | undefined> = {
  left: process.env.NEXT_PUBLIC_ADSENSE_SLOT_LEFT,
  right: process.env.NEXT_PUBLIC_ADSENSE_SLOT_RIGHT,
};

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

export function AdRail({ side }: { side: 'left' | 'right' }) {
  const slot = SLOTS[side];
  const live = Boolean(CLIENT && slot);
  const ins = useRef<HTMLModElement>(null);
  // React Strict Mode double-invokes effects in development, and AdSense
  // throws ("All ins elements in the DOM with class=adsbygoogle already have
  // ads in them") on a second push for the same element. The ref is the guard;
  // `data-adsbygoogle-status` is the belt to its braces, since the script sets
  // that on the element itself and it survives a remount of this component.
  const pushed = useRef(false);

  useEffect(() => {
    if (!live || pushed.current) return;
    if (ins.current?.dataset.adsbygoogleStatus) return;
    pushed.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // A blocked or not-yet-loaded script must not take the page down with
      // it: the rail is furniture, and every route renders fine without it.
      pushed.current = false;
    }
  }, [live]);

  // No publisher id configured. In development that is the normal state, and a
  // labelled placeholder is what makes the reserved space visible while you
  // lay a screen out; in production it would be an empty dashed box on a live
  // page, which is worse than no rail at all.
  if (!live) {
    if (process.env.NODE_ENV === 'production') return null;
    return (
      <aside className={`ad-rail ad-rail-${side} ad-rail-placeholder`} aria-hidden="true">
        <span className="osd-text">AD 160×600</span>
      </aside>
    );
  }

  return (
    <aside className={`ad-rail ad-rail-${side}`} aria-label="Advertisement">
      <ins
        ref={ins}
        className="adsbygoogle"
        style={{ display: 'block', width: 160, height: 600 }}
        data-ad-client={CLIENT}
        data-ad-slot={slot}
      />
    </aside>
  );
}
