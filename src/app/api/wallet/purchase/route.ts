// src/app/api/wallet/purchase/route.ts
// POST /api/wallet/purchase { itemId } — spend coins on a cosmetic.
//
// The body names an item, never a price and never a balance: both come from
// the catalogue and the database. Returns the whole wallet so the client can
// replace its state rather than trying to patch it.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { purchaseCosmetic, type PurchaseRejection } from '@/server/wallet';

const MESSAGES: Record<PurchaseRejection, string> = {
  no_such_item: 'That item is not in the shop',
  already_owned: 'You already own that',
  insufficient_funds: 'Not enough Rewind Coins',
};

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const itemId = typeof body?.itemId === 'string' ? body.itemId : null;
  if (!itemId) return NextResponse.json({ error: 'Missing itemId' }, { status: 400 });

  const result = await purchaseCosmetic(userId, itemId);
  if (!result.ok) {
    return NextResponse.json(
      { error: MESSAGES[result.reason], reason: result.reason },
      { status: result.reason === 'no_such_item' ? 404 : 409 }
    );
  }

  return NextResponse.json(result.wallet);
}
