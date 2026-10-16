// src/app/layout.tsx
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AdScript } from '@/components/ads/AdScript';
import { CookieConsent } from '@/components/consent/CookieConsent';
import { SessionProvider } from '@/components/providers/SessionProvider';

export const metadata: Metadata = {
  title: 'Imposter — The Video Deception Game',
  description:
    'Watch videos together, spot the imposter. A real-time multiplayer social deduction game inspired by Sidemen Reacts.',
  keywords: ['imposter game', 'sidemen', 'multiplayer', 'social deduction', 'video game'],
  openGraph: {
    title: 'Imposter — The Video Deception Game',
    description: 'Watch videos together, spot the imposter.',
    type: 'website',
  },
};

/**
 * Next ships a `width=device-width, initial-scale=1` default; this replaces
 * it for two reasons.
 *
 * `viewportFit: 'cover'` lets the layout reach under a notch and the home
 * indicator, which is what makes `env(safe-area-inset-*)` return anything
 * other than zero — the CRT viewport is a full-bleed fixed frame, so without
 * cover it would letterbox itself on every modern phone.
 *
 * Zoom is deliberately NOT capped. `maximumScale: 1` / `userScalable: false`
 * would stop iOS zooming on a focused input, but it stops a low-vision player
 * pinching the word board too, and that trade is not ours to make. The input
 * zoom is fixed properly instead — see the 16px font-size rule in globals.css.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Paints the phone's browser chrome to match the header. Follows the default
  // theme, so it moved with it — this was `#1a0b3d`, a dark tone that is not
  // even the dark theme's field any more (`--field` is `#2b1063`). It is one
  // static value for a two-theme app, so it can only match one of them; light
  // is the one a first-time visitor sees.
  themeColor: '#4f079b',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `data-theme` is the app's own switch and light is now the default a
    // first-time visitor gets; the stored preference still wins, applied by the
    // script below before first paint. `className="dark"` is Tailwind's dark
    // variant hook and is left as it is deliberately — nothing in src/ uses a
    // `dark:` utility, so it selects nothing either way, and removing it is a
    // change to a system this switch does not control.
    <html lang="en" className="dark" data-theme="light">
      <head>
        {/* Outfit's heaviest cut. Every other font this app uses comes from the
            @import at the top of vhs.css, and that one stops at
            `wght@400;600;800` — and only `.router-code-input` wants 900, for
            the six characters a player transcribes off someone else's screen,
            where the weight is what tells B from 8 and O from 0.

            It is a <link> rather than a second @import in globals.css, and that
            is not a style preference — a CSS @import cannot work here. CSS
            requires @import before any other rule, and webpack hoists the
            content of `@import './vhs.css'` above globals.css's own body
            whichever line the sibling @import sits on, so the request lands
            after ~3400 rules and the browser drops it. The failure is silent in
            the worst way: the @import is still there in the compiled CSS, so
            grepping finds it, while `document.fonts` has no 900 face and the
            field quietly renders at 800.

            `document.fonts.check('900 18px Outfit')` is NOT the test — it
            returns true whenever the weight *matches* something, so it says
            true against a family that stops at 800. The real check is
            `[...document.fonts].filter(f => f.family === 'Outfit')`, which has
            to list a 900 entry. */}
        {/* `no-page-custom-font` targets the Pages Router, where a font <link>
            outside `pages/_document.js` really does load for one page only.
            This is the App Router's root layout, which wraps every route — the
            condition the rule warns about cannot arise here. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@900&display=swap"
        />
        {/* Sets the theme before first paint. Without this a light-mode user
            gets a frame of the dark theme on every navigation, because React
            cannot run an effect until after the document has painted. It reads
            the same key ThemeToggle writes — change one and change both. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('imposter_theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-dvh">
        <SessionProvider>
          {children}
        </SessionProvider>
        {/* The consent bar, and the ad script it gates. Both are here rather
            than in CrtShell because both are app-wide: the question has to be
            asked whatever route a player's first URL happens to be, including
            a room code pasted into a fresh browser, and the script is loaded
            once for the whole app. AdRail is what fills the units; AdScript
            only supplies the loader, and only once consent says 'all'. */}
        <CookieConsent />
        <AdScript />
      </body>
    </html>
  );
}
