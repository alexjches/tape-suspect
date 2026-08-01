// src/server/wallet.ts
// The only place a coin balance is allowed to change (spec §9, §11).
//
// SERVER-ONLY. Importing this from a component pulls Prisma into the browser
// bundle. Everything the client may do goes through /api/wallet/*, and every
// one of those routes re-derives the user from the session — a request body
// never names whose wallet to touch.
//
// Two writers:
//   - finalizeResults() in socketHandlers.ts credits the round's rewards
//   - the /api/wallet/* routes spend and equip
//
// Guests have no row here at all. Their coins stay in localStorage and die
// with it, which is exactly what §11's claim-your-account prompt warns about.

import { prisma } from '../lib/prisma';
import { EMPTY_EQUIPPED, getShopItem, sanitizeCosmetics } from '../lib/cosmetics';
import type { EquippedCosmetics } from '../types';

export interface Wallet {
  coins: number;
  owned: string[];
  equipped: EquippedCosmetics;
}

export const EMPTY_WALLET: Wallet = {
  coins: 0,
  owned: [],
  equipped: { ...EMPTY_EQUIPPED },
};

function parseEquipped(raw: string | null): EquippedCosmetics {
  if (!raw) return { ...EMPTY_EQUIPPED };
  try {
    return sanitizeCosmetics(JSON.parse(raw));
  } catch {
    return { ...EMPTY_EQUIPPED };
  }
}

/**
 * Drops any slot holding an item this player doesn't own.
 *
 * Ownership can lapse behind an equipped loadout — a claim that merged a
 * shorter list, a catalogue entry withdrawn — and a loadout is broadcast to
 * the whole room, so it has to be true rather than merely well-formed.
 */
function withoutUnowned(equipped: EquippedCosmetics, owned: string[]): EquippedCosmetics {
  const has = new Set(owned);
  const out = { ...equipped };
  for (const slot of Object.keys(out) as (keyof EquippedCosmetics)[]) {
    const id = out[slot];
    if (id && !has.has(id)) out[slot] = null;
  }
  return out;
}

export async function getWallet(userId: string): Promise<Wallet> {
  const [user, owned] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { coins: true, equipped: true } }),
    prisma.cosmeticOwnership.findMany({ where: { userId }, select: { itemId: true } }),
  ]);
  if (!user) return { ...EMPTY_WALLET, equipped: { ...EMPTY_EQUIPPED } };

  const ownedIds = owned.map((o) => o.itemId);
  return {
    coins: user.coins,
    owned: ownedIds,
    equipped: withoutUnowned(parseEquipped(user.equipped), ownedIds),
  };
}

/**
 * Credits a round reward. Called once per player per round, from the results
 * broadcast — the client is told what it earned but never asked to bank it.
 *
 * Silently ignores a userId that no longer exists: an account deleted between
 * the tape rolling and the vote closing must not take the whole results
 * broadcast down with it.
 */
export async function awardCoins(userId: string, amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) return;
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { coins: { increment: Math.floor(amount) } },
    });
  } catch (err) {
    console.error(`[Wallet] Could not credit ${amount} to ${userId}:`, err);
  }
}

export type PurchaseRejection = 'no_such_item' | 'already_owned' | 'insufficient_funds';

/**
 * Buys a cosmetic and equips it — a fresh purchase has nothing to compete
 * with in its slot, which is what the localStorage version did too.
 *
 * The price comes from the catalogue, never from the request. Runs in one
 * transaction so a balance cannot be read, spent twice and written back:
 * the unique constraint on (userId, itemId) blocks double-owning, and the
 * post-decrement check blocks a balance racing below zero across two
 * different items.
 */
export async function purchaseCosmetic(
  userId: string,
  itemId: string
): Promise<{ ok: true; wallet: Wallet } | { ok: false; reason: PurchaseRejection }> {
  const item = getShopItem(itemId);
  if (!item) return { ok: false, reason: 'no_such_item' };

  try {
    await prisma.$transaction(async (tx) => {
      const owned = await tx.cosmeticOwnership.findUnique({
        where: { userId_itemId: { userId, itemId } },
        select: { id: true },
      });
      if (owned) throw new Error('already_owned');

      const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
      if (!user || user.coins < item.price) throw new Error('insufficient_funds');

      await tx.cosmeticOwnership.create({ data: { userId, itemId } });
      const after = await tx.user.update({
        where: { id: userId },
        data: { coins: { decrement: item.price } },
        select: { coins: true, equipped: true },
      });
      // Belt and braces: two concurrent purchases of *different* items could
      // each pass the check above and overdraw. Rolling back is cheaper than
      // reasoning about SQLite's write serialisation holding forever.
      if (after.coins < 0) throw new Error('insufficient_funds');

      const equipped = { ...parseEquipped(after.equipped), [item.category]: itemId };
      await tx.user.update({ where: { id: userId }, data: { equipped: JSON.stringify(equipped) } });
    });
  } catch (err) {
    const reason = (err as Error).message;
    if (reason === 'already_owned' || reason === 'insufficient_funds') {
      return { ok: false, reason };
    }
    console.error(`[Wallet] Purchase of ${itemId} by ${userId} failed:`, err);
    return { ok: false, reason: 'insufficient_funds' };
  }

  return { ok: true, wallet: await getWallet(userId) };
}

/** Equips an owned item, or clears its slot when `itemId` is null. */
export async function equipCosmetic(
  userId: string,
  category: string,
  itemId: string | null
): Promise<{ ok: true; wallet: Wallet } | { ok: false; reason: 'not_owned' | 'no_such_item' }> {
  const current = await getWallet(userId);

  if (itemId !== null) {
    const item = getShopItem(itemId);
    if (!item || item.category !== category) return { ok: false, reason: 'no_such_item' };
    if (!current.owned.includes(itemId)) return { ok: false, reason: 'not_owned' };
  }

  const equipped = sanitizeCosmetics({ ...current.equipped, [category]: itemId });
  await prisma.user.update({ where: { id: userId }, data: { equipped: JSON.stringify(equipped) } });
  return { ok: true, wallet: { ...current, equipped } };
}

/**
 * The most a guest session can carry into a new account. Roughly a long
 * evening's play — high enough never to bite a real player, low enough that
 * editing localStorage isn't a shortcut past the shop.
 */
export const MAX_CLAIMABLE_COINS = 5000;

/**
 * Folds a guest's localStorage progress into a freshly signed-in account
 * (§11). Runs at most once per account — `claimedGuestAt` is the guard, since
 * the payload is by definition unverifiable and replaying it would mint coins.
 *
 * Coins are added rather than overwritten so a claim can't wipe a balance the
 * account already had, and owned items are merged, not replaced.
 */
export async function claimGuestProgress(
  userId: string,
  guest: { coins?: unknown; owned?: unknown; equipped?: unknown }
): Promise<{ claimed: boolean; wallet: Wallet }> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { claimedGuestAt: true },
  });
  if (!existing || existing.claimedGuestAt) {
    return { claimed: false, wallet: await getWallet(userId) };
  }

  // Cap the claim: a hand-edited localStorage shouldn't buy the catalogue.
  const rawCoins = typeof guest.coins === 'number' && Number.isFinite(guest.coins) ? guest.coins : 0;
  const coins = Math.max(0, Math.min(MAX_CLAIMABLE_COINS, Math.floor(rawCoins)));
  // Deduped, because localStorage is only as tidy as whatever wrote it.
  const owned = Array.from(
    new Set(
      Array.isArray(guest.owned)
        ? guest.owned.filter((id): id is string => typeof id === 'string' && !!getShopItem(id))
        : []
    )
  );

  await prisma.$transaction(async (tx) => {
    if (owned.length > 0) {
      // Merge, don't replace — anything the account already has is left
      // alone. Filtered by hand rather than with `skipDuplicates`, which
      // Prisma does not support on SQLite.
      const already = await tx.cosmeticOwnership.findMany({
        where: { userId, itemId: { in: owned } },
        select: { itemId: true },
      });
      const have = new Set(already.map((o) => o.itemId));
      const fresh = owned.filter((itemId) => !have.has(itemId));
      if (fresh.length > 0) {
        await tx.cosmeticOwnership.createMany({
          data: fresh.map((itemId) => ({ userId, itemId })),
        });
      }
    }
    await tx.user.update({
      where: { id: userId },
      data: { coins: { increment: coins }, claimedGuestAt: new Date() },
    });
  });

  // Equip whatever they were wearing, but only slots the merged account owns.
  const wallet = await getWallet(userId);
  const wanted = withoutUnowned(sanitizeCosmetics(guest.equipped), wallet.owned);
  if (Object.values(wanted).some(Boolean)) {
    await prisma.user.update({
      where: { id: userId },
      data: { equipped: JSON.stringify(wanted) },
    });
    return { claimed: true, wallet: { ...wallet, equipped: wanted } };
  }

  return { claimed: true, wallet };
}
