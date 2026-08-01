// src/app/api/wallet/equip/route.ts
// POST /api/wallet/equip { category, itemId } — equip an owned cosmetic, or
// clear the slot with itemId: null.
//
// Ownership is checked server-side because a loadout is broadcast to the whole
// room (§10) — "what everyone else sees you wearing" has to be something you
// actually bought.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { equipCosmetic } from '@/server/wallet';
import { COSMETIC_CATEGORIES } from '@/lib/cosmetics';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const category = typeof body?.category === 'string' ? body.category : null;
  const itemId = typeof body?.itemId === 'string' ? body.itemId : null;

  if (!category || !COSMETIC_CATEGORIES.some((c) => c.id === category)) {
    return NextResponse.json({ error: 'Unknown cosmetic slot' }, { status: 400 });
  }

  const result = await equipCosmetic(userId, category, itemId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason === 'not_owned' ? 'You do not own that' : 'No such item' },
      { status: result.reason === 'not_owned' ? 403 : 404 }
    );
  }

  return NextResponse.json(result.wallet);
}
