// src/app/not-found.tsx — the 404.
//
// Rendered by Next for any unmatched route, and by any `notFound()` call. It
// is a `home` route: same CRT frame, same centred box as /dashboard, so a
// mistyped URL lands somewhere that is obviously still the app rather than on
// the framework's black-on-white default.
//
// No `metadata` export — Next only reads that from layouts and pages, and a
// not-found file is neither. The title stays whatever the root layout set.
//
// The one job of the page is the way out. A guest and a signed-in player need
// different doors (/dashboard bounces anyone without `?guest=1`), and the
// header logo already resolves that correctly for both, so the body offers the
// two that are safe from anywhere: the landing page, and the shop.
import Link from 'next/link';
import { CrtShell } from '@/components/vhs/CrtShell';

export default function NotFound() {
  return (
    <CrtShell home badge="NO SIGNAL" badgeColor="var(--neon-magenta)">
      <section className="gartic-hero-section" style={{ padding: '20px 0' }}>
        <div className="gartic-container-wrapper" style={{ maxWidth: 640, width: '95%' }}>
          {/* `.router-box` rather than a bare `.gartic-main-box`: the plain one
              reserves 64px at the top for the floating logo the landing page
              hangs over it, and there is no logo here. It also carries the
              light-mode bevel, which is keyed on that class. */}
          <div className="gartic-main-box router-box notfound-box">
            <div className="notfound-code brutal-title">404</div>

            {/* Colour bars are what a VHS deck shows when there is nothing on
                the channel, which is exactly what a 404 is. Decorative and
                aria-hidden — the heading below says the same thing in words. */}
            <div className="notfound-bars" aria-hidden="true" />

            <h2 className="notfound-title">NO SIGNAL ON THIS CHANNEL</h2>

            <p className="notfound-copy">
              That page isn&apos;t in the machine. The tape may have been ejected, or the
              address mistyped.
            </p>

            <div className="notfound-actions">
              <Link href="/" className="btn-brutal magenta">
                ◀ BACK TO THE DECK
              </Link>
              <Link href="/shop" className="btn-brutal dark">
                COSMETICS SHOP
              </Link>
            </div>
          </div>
        </div>
      </section>
    </CrtShell>
  );
}
