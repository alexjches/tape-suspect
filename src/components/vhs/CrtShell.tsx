'use client';
// src/components/vhs/CrtShell.tsx
// The VHS/CRT viewport frame every game screen renders inside.
// Markup mirrors #crt-viewport in vhs-frontend-example/index.html — the
// authoritative visual reference (spec section 21).

import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AdRail } from '@/components/ads/AdRail';
import { useHomeHref } from '@/lib/useHomeHref';
import { HeaderProfile } from './HeaderProfile';
import { ThemeToggle } from './ThemeToggle';

interface Props {
  children: ReactNode;
  /** Shown next to the logo, e.g. a room code. */
  badge?: string;
  /** Colour of the badge text. */
  badgeColor?: string;
  /** Right-hand header slot, rendered before the CRT toggle. */
  headerExtra?: ReactNode;
  /** REC dot pulses while true — on during the watch phase. */
  recording?: boolean;
  /**
   * Makes the wordmark a link out to the lobby router. On in the pre-game
   * lobby, where walking away costs nothing; off once a round is under way,
   * because identity is socket.id and there is no way back into a round you
   * have left.
   */
  logoLeaves?: boolean;
  /**
   * Marketing/console layout (home.html, join-host.html) rather than the
   * in-game `.view-panel` stack: fixed-height scroll area plus a footer.
   */
  home?: boolean;
}

export function CrtShell({
  children,
  badge,
  badgeColor = 'var(--neon-magenta)',
  headerExtra,
  recording = false,
  home = false,
  logoLeaves = false,
}: Props) {
  // Where the header logo goes. Shared with both LEAVE buttons — see the note
  // in useHomeHref for why a bare /dashboard link is the wrong destination.
  const logoHref = useHomeHref();

  // Only used as a React key — see the note at the bottom of the tree.
  const pathname = usePathname();

  const linkLogo = home || logoLeaves;

  // The CRT effect is always on — it is the look, not a setting.
  return (
    <div
      id="crt-viewport"
      className={`crt-viewport crt-active${home ? ' home-viewport' : ''}`}
    >
      <header>
        <div className="logo-container">
          {/* A link on the marketing/console routes and in the pre-game
              lobby, where leaving costs nothing. Inert once a round is under
              way: identity is socket.id with no way back into a round you
              have left, so the logo must not be an unlabelled second exit
              sitting beside the room code — LEAVE is the deliberate one.
              The badge stays outside the link either way — it's a room code
              or page label, not part of the home affordance. */}
          {linkLogo ? (
            <Link
              href={logoHref}
              className="logo-home-link"
              aria-label="Tape Suspect — go to lobby router"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="Tape Suspect" className="site-logo" />
              <h1 className="brutal-title" style={{ fontSize: '2.2rem' }}>
                TAPE SUSPECT
              </h1>
            </Link>
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="Tape Suspect" className="site-logo" />
              <h1 className="brutal-title" style={{ fontSize: '2.2rem' }}>
                TAPE SUSPECT
              </h1>
            </>
          )}
          {badge && (
            <span
              // `home` is what separates a caption from data. Every home route
              // passes a page label here ("LOBBY ROUTER", "SHOP", "SIGN IN")
              // while the room routes pass the room code, so the flag doubles
              // as the answer to "is this badge worth a phone's header bar?" —
              // the MOBILE block hides the labelled ones. Don't drop the class
              // on a code: in-game the header is the only place it appears.
              className={`osd-text${home ? ' header-badge-label' : ''}`}
              style={{ color: badgeColor, fontWeight: 'bold', marginLeft: 10 }}
            >
              {badge}
            </span>
          )}
        </div>

        {/* The theme switch lives in the shell, so it is reachable from every
            route including mid-round, rather than only from the pages that
            happen to pass headerExtra. */}
        <div className="header-controls">
          {headerExtra}
          {/* Same argument, one route class narrower: the profile chip has to
              be in the same corner everywhere it appears or "click your face"
              is advice that only works on one page — but it is a route *out*
              of the screen, and the in-game screens already have exactly one
              deliberate exit. `home` is the flag that separates the two, as it
              does for the ad rails and the badge label. Renders nothing while
              signed out, so /login and /signup are unaffected. */}
          {home && <HeaderProfile />}
          <ThemeToggle />
        </div>
      </header>

      {/* Camcorder HUD overlays */}
      <div className="camcorder-hud">
        <div className="hud-row">
          <div className="rec-indicator osd-text">
            <span className={`rec-dot${recording ? ' active' : ''}`} />
            <span>REC</span>
          </div>
        </div>
        <div className="hud-bracket-tl" />
        <div className="hud-bracket-tr" />
        <div className="hud-bracket-bl" />
        <div className="hud-bracket-br" />
      </div>

      <div className="static-noise" />
      <div className="tracking-line" />

      {/* The field's halftone bands (globals.css). An element rather than a
          background layer, because the diagonal bands are a mask and only an
          element can carry one — and .crt-viewport's own ::before/::after are
          taken by vhs.css's vignette and scanlines.

          `z-index: -1` is what keeps it *behind* the page: a negatively
          stacked child paints after its parent's background but before the
          parent's in-flow content, whereas z-index 0 or auto would paint the
          dots on top of every screen. It stays inside the frame because
          .crt-viewport is positioned with a z-index of its own, so it is a
          stacking context. */}
      <div className="field-texture" aria-hidden="true" />

      {/* No footer. The copyright strip used to sit under the scroll area on
          every `home` route; it added a second bar to a screen whose whole
          frame is already a bar, and it was the only thing on these pages that
          was not the thing you came for. The `.home-scroll-area` wrapper stays
          — it owns the scroll and the auto-margin centring, so removing it
          would uncentre the landing, dashboard, auth and shop boxes. */}
      {/* The gutters either side of the content box. `home` only: those routes
          are one centred box with real empty space beside it, while the
          in-game screens are full-bleed and an ad there would sit on the
          round. They are siblings of the scroll area rather than inside it, so
          they stay put while the page scrolls, and they hide themselves at any
          width where the gutter is too narrow — see `.ad-rail` in
          globals.css. */}
      {home && <AdRail side="left" />}
      {home && <AdRail side="right" />}

      {/* Keyed on the pathname so the route-enter animation (globals.css) plays
          on every navigation. Without it, two routes that render the same
          shape — /login and /signup, or any two `home` pages — can be
          reconciled in place, and an element that is never re-created never
          restarts a CSS animation. The key throws the subtree away instead,
          which is what a page change is. It does not fire inside a room: the
          pathname is the room code there, so phase changes are left to the
          panel's own mount, which is already one per phase.

          A keyed Fragment for the in-game branch rather than a wrapper div —
          the room screens are laid out against `.crt-viewport` directly and an
          extra block in between would take the flex sizing off them. */}
      {home ? (
        <div className="home-scroll-area" key={pathname}>
          {children}
        </div>
      ) : (
        <Fragment key={pathname}>{children}</Fragment>
      )}
    </div>
  );
}
