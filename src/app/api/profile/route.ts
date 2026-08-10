// src/app/api/profile/route.ts
// GET  /api/profile — the signed-in player's display name, character and email.
// PATCH /api/profile — change the name and/or the character.
//
// Whose profile is decided by the session, never by the request — the same rule
// the wallet routes run on. A body that named a user id would be a rename-anyone
// endpoint, and the display name is what a lobby identifies a player by.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAllowedAvatar, toAvatarCode } from '@/lib/avatars';

// Same bounds as /api/auth/signup's name field, deliberately: a rename must not
// be a way past the limit signup enforces.
const ProfileSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(20, 'Name too long'),
  // Rejected rather than silently re-rolled, which is what signup does with a
  // bad code. Signup is dealing a character nobody chose, so a fallback is
  // right there; here the player picked one, and quietly storing a different
  // face would look like the save failed.
  avatar: z.string().refine(isAllowedAvatar, 'Unknown character'),
});

async function currentUserId() {
  const session = await getServerSession(authOptions);
  return (session?.user as { id?: string } | undefined)?.id ?? null;
}

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, avatar: true, email: true, coins: true },
  });
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Normalised on the way out for the same reason characterFor never throws:
  // accounts predating the roster hold an emoji or a composer part-code, and
  // the picker has to open on a character that actually exists.
  return NextResponse.json({ ...user, avatar: toAvatarCode(user.avatar) });
}

export async function PATCH(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 });
  }

  const { name, avatar } = parsed.data;

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { name, avatar },
      select: { name: true, avatar: true },
    });
    return NextResponse.json({ success: true, ...user });
  } catch (error) {
    console.error('[Profile] Update failed:', error);
    return NextResponse.json({ error: 'Could not save profile' }, { status: 500 });
  }
}
