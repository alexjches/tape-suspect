// src/app/api/wallet/claim/route.ts
// POST /api/wallet/claim { coins, owned, equipped } — fold a guest session's
// localStorage progress into the account that just signed in (spec §11).
//
// The payload is unverifiable by construction: it is whatever was in the
// browser. Two things keep that from being a coin printer — the claim runs at
// most once per account (`claimedGuestAt`), and the amount is capped. Both
// live in server/wallet.ts.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { claimGuestProgress } from '@/server/wallet';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const result = await claimGuestProgress(userId, {
    coins: body?.coins,
    owned: body?.owned,
    equipped: body?.equipped,
  });

  return NextResponse.json({ claimed: result.claimed, ...result.wallet });
}
