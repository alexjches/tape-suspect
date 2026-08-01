// src/server/socketAuth.ts
// Who a socket really is, as far as the wallet is concerned.
//
// `room:create` / `room:join` carry a `userId`, but it comes from the client
// and is therefore a claim, not a fact. That was harmless while it only
// labelled a player; now that finalizeResults credits real coins against it,
// an unverified id means anyone can farm rewards into anybody's account.
//
// So the id that touches money is derived here instead, from the NextAuth
// session cookie the browser sends with the socket.io handshake. The client
// cannot forge it without NEXTAUTH_SECRET.

import type { Socket } from 'socket.io';
import { decode } from 'next-auth/jwt';

// NextAuth prefixes the cookie with __Secure- when it decides it is running
// over https, which depends on deployment rather than on anything we can see
// from here — so try both.
const COOKIE_NAMES = ['__Secure-next-auth.session-token', 'next-auth.session-token'];

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * The signed-in user behind this socket, or null for a guest.
 *
 * Returns null on any failure — an expired token, a missing secret, a cookie
 * from a different deployment. A guest playing normally and a forged id are
 * treated identically: no wallet, so nothing to steal.
 */
export async function verifySocketUser(socket: Socket): Promise<string | null> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;

  const header = socket.handshake.headers.cookie;
  for (const name of COOKIE_NAMES) {
    const raw = readCookie(header, name);
    if (!raw) continue;
    try {
      const token = await decode({ token: raw, secret });
      // `id` is what the jwt callback in lib/auth.ts threads through; `sub` is
      // NextAuth's own subject claim, and is the fallback if that ever moves.
      const id = (token?.id as string | undefined) ?? (token?.sub as string | undefined);
      if (id) return id;
    } catch {
      // Malformed or signed with a different secret — keep trying the other
      // cookie name, then fall through to guest.
    }
  }
  return null;
}
