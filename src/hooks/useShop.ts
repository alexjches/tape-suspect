// src/hooks/useShop.ts
// Coin wallet + cosmetics ownership.
//
// NOTE: everything here is localStorage. Spec sections 9 and 11 call for
// persistent, account-bound currency; the server already computes a
// coinReward in game:results but nothing writes it down. Moving this to the
// database is Phase 3 — keep the API surface stable so that swap is local.

'use client';

import { useState, useEffect, useCallback } from 'react';
import { CosmeticCategory, EquippedCosmetics, ShopItem } from '@/types';

const COINS_KEY = 'imposter_coins';
const OWNED_KEY = 'imposter_shop_owned';
const EQUIPPED_KEY = 'imposter_shop_equipped';

export {
  SHOP_ITEMS,
  COSMETIC_CATEGORIES,
  EMPTY_EQUIPPED,
} from '@/lib/cosmetics';
import { SHOP_ITEMS, EMPTY_EQUIPPED } from '@/lib/cosmetics';

function readOwned(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OWNED_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function readEquipped(): EquippedCosmetics {
  try {
    const raw = JSON.parse(localStorage.getItem(EQUIPPED_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...EMPTY_EQUIPPED };
    return { ...EMPTY_EQUIPPED, ...raw };
  } catch {
    return { ...EMPTY_EQUIPPED };
  }
}

export function useShop() {
  const [coins, setCoins] = useState(0);
  const [ownedItems, setOwnedItems] = useState<string[]>([]);
  const [equipped, setEquipped] = useState<EquippedCosmetics>(EMPTY_EQUIPPED);

  // Read after mount — touching localStorage during render desyncs the
  // server and client HTML and trips hydration.
  useEffect(() => {
    const storedCoins = parseInt(localStorage.getItem(COINS_KEY) || '0', 10);
    setCoins(Number.isNaN(storedCoins) ? 0 : storedCoins);
    setOwnedItems(readOwned());
    setEquipped(readEquipped());
  }, []);

  const addCoins = useCallback((amount: number) => {
    setCoins((prev) => {
      const next = prev + amount;
      localStorage.setItem(COINS_KEY, String(next));
      return next;
    });
  }, []);

  const equip = useCallback((itemId: string) => {
    const item = SHOP_ITEMS.find((i) => i.id === itemId);
    if (!item || !readOwned().includes(itemId)) return;

    const next = { ...readEquipped(), [item.category]: itemId };
    localStorage.setItem(EQUIPPED_KEY, JSON.stringify(next));
    setEquipped(next);
  }, []);

  const unequip = useCallback((category: CosmeticCategory) => {
    const next = { ...readEquipped(), [category]: null };
    localStorage.setItem(EQUIPPED_KEY, JSON.stringify(next));
    setEquipped(next);
  }, []);

  const buy = useCallback((itemId: string): boolean => {
    const item = SHOP_ITEMS.find((i) => i.id === itemId);
    if (!item) return false;

    // Re-read rather than trusting state: another tab may have spent first.
    const currentOwned = readOwned();
    if (currentOwned.includes(itemId)) return false;

    const currentCoins = parseInt(localStorage.getItem(COINS_KEY) || '0', 10) || 0;
    if (currentCoins < item.price) return false;

    const newOwned = [...currentOwned, itemId];
    localStorage.setItem(COINS_KEY, String(currentCoins - item.price));
    localStorage.setItem(OWNED_KEY, JSON.stringify(newOwned));
    setCoins(currentCoins - item.price);
    setOwnedItems(newOwned);

    // A fresh purchase goes straight into its slot — nothing else to pick.
    const nextEquipped = { ...readEquipped(), [item.category]: itemId };
    localStorage.setItem(EQUIPPED_KEY, JSON.stringify(nextEquipped));
    setEquipped(nextEquipped);
    return true;
  }, []);

  const ownsItem = useCallback((itemId: string) => ownedItems.includes(itemId), [ownedItems]);

  return { coins, ownedItems, equipped, addCoins, buy, equip, unequip, ownsItem, SHOP_ITEMS };
}
