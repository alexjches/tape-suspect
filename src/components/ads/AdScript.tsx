'use client';
// src/components/ads/AdScript.tsx
//
// The AdSense loader, which used to be an inline <Script> in layout.tsx. It
// moved here for one reason: it is now gated on consent, and consent lives in
// localStorage, which a server component cannot read.
//
// Two conditions, and they are independent. No publisher id ⇒ the tag 400s on
// every page, which is why it was already conditional. No 'all' consent ⇒ the
// script must not run at all: it is what sets the third-party cookies the
// banner is asking about, so gating the *units* alone would be a banner that
// does nothing.
//
// The script is loaded, never unloaded. Switching back to ESSENTIAL ONLY
// unmounts this and the rails, so nothing further is requested and no unit
// renders — but a cookie already set by Google is on Google's domain and no
// script of ours can delete it. That is the normal shape of this; if it needs
// to be stronger the answer is Google's consent-mode API, not a bigger gate
// here.

import Script from 'next/script';
import { useConsent } from '@/lib/cookieConsent';

const ADSENSE_CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT;

export function AdScript() {
  const { consent } = useConsent();

  if (!ADSENSE_CLIENT || consent !== 'all') return null;

  return (
    <Script
      id="adsbygoogle-init"
      async
      // `afterInteractive`, because an ad in the gutter must never be on the
      // critical path of a game that is waiting on a websocket.
      strategy="afterInteractive"
      crossOrigin="anonymous"
      src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
    />
  );
}
