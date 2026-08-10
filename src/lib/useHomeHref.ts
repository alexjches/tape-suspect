'use client';
// src/lib/useHomeHref.ts
//
// Where "out of here" goes: the header logo, and both LEAVE buttons.
//
// `/dashboard` on its own is not that destination. Its gate keys on the
// `?guest=1` query alone — a saved guest identity in localStorage is not
// enough — so a bare /dashboard link pushes any guest straight back to `/`.
// That is exactly what LEAVE used to do: it routed to /dashboard and the
// player landed on the landing page, having asked to go to the router.
//
// Resolve to somewhere actually reachable instead:
//   signed in            → /dashboard
//   saved guest identity → /dashboard?guest=1
//   neither              → /, which is where /dashboard would send them
//                          anyway, minus the redirect flash.
//
// The last case is close to unreachable from a room: both the landing page's
// START and the room page's own name gate write `imposter_guest_name`, so
// anyone sitting in a lobby has one. It is the safety net, not a path.
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

export function useHomeHref(): string {
  const { status } = useSession();
  const [hasGuestIdentity, setHasGuestIdentity] = useState(false);

  // Read after mount: touching localStorage during render would desync the
  // server and client HTML and trip hydration.
  useEffect(() => {
    setHasGuestIdentity(localStorage.getItem('imposter_guest_name') !== null);
  }, []);

  if (status === 'authenticated') return '/dashboard';
  return hasGuestIdentity ? '/dashboard?guest=1' : '/';
}
