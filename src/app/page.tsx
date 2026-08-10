// src/app/page.tsx — Landing page ("Access Deck")
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import Link from 'next/link';
import { CrtShell } from '@/components/vhs/CrtShell';
import { LandingHero } from '@/components/home/LandingHero';
import { toAvatarCode } from '@/lib/avatars';

export default async function LandingPage() {
  const session = await getServerSession(authOptions);

  // A signed-in visitor used to be redirected straight to /dashboard, on the
  // reading that the landing page is the door for people who have not signed
  // in. That made the Profile panel — the app's one place to change a display
  // name and character — unreachable for exactly the players whose identity is
  // worth keeping, and it made /dashboard's own "◀ RETURN" a link that bounced
  // you back where you came from. The page is now the same page for everyone;
  // what changes is where the panel reads identity from and where it writes it.
  //
  // Passed from the server rather than read with useSession() in the panel, so
  // a signed-in player's name and face are in the first paint instead of
  // arriving a frame later over an empty field.
  const account = session?.user
    ? {
        name: session.user.name ?? '',
        // A roster character code, not a URL — see the jwt callback in
        // lib/auth.ts. Normalised here because characterFor() never throws and
        // an account older than the roster still has to open on a real face.
        avatar: toAvatarCode(session.user.image),
      }
    : null;

  return (
    <CrtShell
      home
      badge="HOME"
      recording
      // Signing in is the returning player's door, and it belongs beside the
      // wordmark rather than inside the Access Deck: guest is the default path,
      // so nothing in that panel should compete with START. Hidden once you are
      // signed in — CrtShell renders the profile chip in the same corner on
      // every `home` route, and a SIGN IN button next to your own face is an
      // offer that has already been taken.
      headerExtra={
        account ? null : (
          <Link id="header-signin-btn" href="/login" className="btn-brutal yellow header-signin-btn">
            {/* A generic account glyph, not one of the 12 roster characters —
                a real character here would read as a specific player rather
                than as "the account you don't have yet". Drawn the way the
                roster art is: filled shapes, no strokes, one ink colour. */}
            <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" focusable="false">
              <circle cx="12" cy="8" r="4.2" fill="currentColor" />
              <path d="M12 13.6c-4.2 0-7.2 2.6-7.6 6.4h15.2c-.4-3.8-3.4-6.4-7.6-6.4Z" fill="currentColor" />
            </svg>
            SIGN IN
          </Link>
        )
      }
    >
      <LandingHero account={account} />
    </CrtShell>
  );
}
