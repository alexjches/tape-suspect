// src/lib/authAdapter.ts
// PrismaAdapter, corrected for this schema.
//
// The stock `@auth/prisma-adapter` assumes the NextAuth reference schema, and
// ours differs in two ways that break OAuth sign-up outright:
//
//  1. There is no `User.image` column. The adapter does
//     `p.user.create({ data })` with the provider profile spread in, so
//     Google's `picture` arrives as an unknown Prisma argument and the very
//     first Google sign-in dies with a PrismaClientValidationError.
//  2. `User.name` is required, and Apple never sends one — its id_token has
//     no `name` claim, so the profile resolves to `name: undefined` and the
//     insert violates the not-null constraint.
//
// Both are only reachable on account *creation*, which is why they never
// showed up while credentials sign-in was the only live path.
//
// An avatar in this game is a generated character, not a photo: lib/avatars
// composes one from a body, eyes, a mouth and an accessory, and the whole
// thing travels as a short code. So a provider picture is deliberately
// discarded rather than stored — an OAuth account is dealt a random character
// exactly like a guest is.

import { PrismaAdapter } from '@auth/prisma-adapter';
import type { PrismaClient } from '@prisma/client';
import type { Adapter, AdapterUser } from 'next-auth/adapters';
import { randomAvatar } from './avatars';

/** Same bounds the /signup form and its API route enforce. */
const NAME_MIN = 2;
const NAME_MAX = 20;

/**
 * A display name for a provider that gave us little or nothing.
 * Apple sends none at all; Google sends the account's full name.
 */
function displayName(name: string | null | undefined, email: string | null | undefined): string {
  const given = name?.trim();
  if (given && given.length >= NAME_MIN) return given.slice(0, NAME_MAX);

  // Fall back to the email's local part — recognisable to the player, and
  // stripped to the characters a nickname is allowed to contain.
  const local = (email ?? '').split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '');
  if (local.length >= NAME_MIN) return local.slice(0, NAME_MAX);

  return 'PLAYER';
}

/**
 * NextAuth wants `image` on the user it hands to the callbacks. We keep the
 * character code there, so `session.user.image` means the same thing whichever
 * provider a player signed in with — see the jwt callback in lib/auth.ts.
 */
function toAdapterUser(user: {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  emailVerified: Date | null;
}): AdapterUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.avatar,
    emailVerified: user.emailVerified,
  };
}

export function gameAdapter(prisma: PrismaClient): Adapter {
  const base = PrismaAdapter(prisma);

  return {
    ...base,

    async createUser({
      image,
      name,
      email,
      emailVerified,
    }: Omit<AdapterUser, 'id'>): Promise<AdapterUser> {
      const user = await prisma.user.create({
        data: {
          email: email!,
          name: displayName(name, email),
          emailVerified: emailVerified ?? null,
          avatar: randomAvatar(),
        },
      });
      return toAdapterUser(user);
    },

    // Reached when a provider reports a changed profile. Same two corrections:
    // drop the photo, never write an empty name over a good one.
    async updateUser({
      id,
      image,
      name,
      ...data
    }: Partial<AdapterUser> & Pick<AdapterUser, 'id'>): Promise<AdapterUser> {
      const user = await prisma.user.update({
        where: { id },
        data: {
          ...data,
          ...(name?.trim() ? { name: name.trim().slice(0, NAME_MAX) } : {}),
        },
      });
      return toAdapterUser(user);
    },
  };
}
