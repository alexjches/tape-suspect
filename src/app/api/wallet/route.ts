// src/app/api/wallet/route.ts
// GET /api/wallet — the signed-in player's coins, owned cosmetics and loadout.
//
// Whose wallet is decided by the session, never by the request. Guests get a
// 401 and fall back to localStorage in useShop.

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getWallet } from '@/server/wallet';

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return NextResponse.json(await getWallet(userId));
}
