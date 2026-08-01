// src/hooks/useShop.ts
// Coin wallet + cosmetics ownership, for whoever is at the keyboard.
//
// Two backings behind one API (spec §9, §11):
//
//   signed in  the database, via /api/wallet/*. The server is the only thing
//              that can change a balance — rewards are credited by the socket
//              server at results, spends go through the purchase route.
//   guest      localStorage, exactly as before. Nothing persists it, which is
//              the honest state of affairs and what the claim-your-account
//              prompt on the results screen warns about.
//
// Signing in folds the guest wallet into the account once (`claim`), so
// hitting "save my progress" after an evening as a guest doesn't throw it away.

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { CosmeticCategory, EquippedCosmetics, ShopItem } from '@/types';

const COINS_KEY = 'imposter_coins';
const OWNED_KEY = 'imposter_shop_owned';
const EQUIPPED_KEY = 'imposter_shop_equipped';
/** Set once the guest wallet has been handed to an account, so it isn't re-sent. */
const CLAIMED_KEY = 'imposter_shop_claimed';

export {
  SHOP_ITEMS,
  COSMETIC_CATEGORIES,
  EMPTY_EQUIPPED,
} from '@/lib/cosmetics';
import { SHOP_ITEMS, EMPTY_EQUIPPED } from '@/lib/cosmetics';

function readCoins(): number {
  const raw = parseInt(localStorage.getItem(COINS_KEY) || '0', 10);
  return Number.isNaN(raw) ? 0 : raw;
}

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

export type PurchaseOutcome = { ok: true } | { ok: false; error: string };

interface WalletShape {
  coins: number;
  owned: string[];
  equipped: EquippedCosmetics;
}

export function useShop() {
  const { data: session, status } = useSession();
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  const signedIn = !!userId;

  const [coins, setCoins] = useState(0);
  const [ownedItems, setOwnedItems] = useState<string[]>([]);
  const [equipped, setEquipped] = useState<EquippedCosmetics>(EMPTY_EQUIPPED);
  /** False until the backing store has been read, so the shop can wait. */
  const [loaded, setLoaded] = useState(false);
  /** Guards the one-shot guest claim against a double-mounted effect. */
  const claiming = useRef(false);

  const applyWallet = useCallback((w: WalletShape) => {
    setCoins(w.coins);
    setOwnedItems(w.owned);
    setEquipped({ ...EMPTY_EQUIPPED, ...w.equipped });
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/wallet');
    if (!res.ok) return;
    applyWallet(await res.json());
  }, [applyWallet]);

  // Read after mount — touching localStorage during render desyncs the
  // server and client HTML and trips hydration.
  useEffect(() => {
    if (status === 'loading') return;
    let cancelled = false;

    if (!signedIn) {
      applyWallet({ coins: readCoins(), owned: readOwned(), equipped: readEquipped() });
      setLoaded(true);
      return;
    }

    (async () => {
      // First sign-in after playing as a guest: hand the account whatever the
      // browser was holding, then keep the server's answer. The route ignores
      // a second claim, and CLAIMED_KEY stops us asking again from this
      // browser at all.
      const unclaimed =
        !localStorage.getItem(CLAIMED_KEY) &&
        (readCoins() > 0 || readOwned().length > 0);

      if (unclaimed && !claiming.current) {
        claiming.current = true;
        try {
          const res = await fetch('/api/wallet/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              coins: readCoins(),
              owned: readOwned(),
              equipped: readEquipped(),
            }),
          });
          if (res.ok) {
            localStorage.setItem(CLAIMED_KEY, new Date().toISOString());
            // The guest wallet has been banked; leaving it behind would show
            // the old balance again the moment they signed out.
            localStorage.removeItem(COINS_KEY);
            localStorage.removeItem(OWNED_KEY);
            const wallet = await res.json();
            if (!cancelled) {
              applyWallet(wallet);
              setLoaded(true);
            }
            return;
          }
        } catch {
          // Offline or a server error — fall through to a plain read.
        }
      }

      try {
        const res = await fetch('/api/wallet');
        if (res.ok && !cancelled) applyWallet(await res.json());
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedIn, status, applyWallet]);

  /**
   * A round's reward has landed.
   *
   * For a guest that means writing it down here, because nothing else will.
   * For a signed-in player the socket server has *already* credited it against
   * their account — re-adding it client-side would double-pay, so this just
   * pulls the authoritative balance back.
   */
  const addCoins = useCallback(
    (amount: number) => {
      if (signedIn) {
        void refresh();
        return;
      }
      setCoins((prev) => {
        const next = prev + amount;
        localStorage.setItem(COINS_KEY, String(next));
        return next;
      });
    },
    [signedIn, refresh]
  );

  const equip = useCallback(
    async (itemId: string) => {
      const item = SHOP_ITEMS.find((i) => i.id === itemId);
      if (!item) return;

      if (signedIn) {
        const res = await fetch('/api/wallet/equip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: item.category, itemId }),
        });
        if (res.ok) applyWallet(await res.json());
        return;
      }

      if (!readOwned().includes(itemId)) return;
      const next = { ...readEquipped(), [item.category]: itemId };
      localStorage.setItem(EQUIPPED_KEY, JSON.stringify(next));
      setEquipped(next);
    },
    [signedIn, applyWallet]
  );

  const unequip = useCallback(
    async (category: CosmeticCategory) => {
      if (signedIn) {
        const res = await fetch('/api/wallet/equip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category, itemId: null }),
        });
        if (res.ok) applyWallet(await res.json());
        return;
      }

      const next = { ...readEquipped(), [category]: null };
      localStorage.setItem(EQUIPPED_KEY, JSON.stringify(next));
      setEquipped(next);
    },
    [signedIn, applyWallet]
  );

  /**
   * Buy and equip. Async now that a signed-in purchase is a round trip — the
   * price and the balance are both checked on the server, so a doctored
   * localStorage buys nothing.
   */
  const buy = useCallback(
    async (itemId: string): Promise<PurchaseOutcome> => {
      const item = SHOP_ITEMS.find((i) => i.id === itemId);
      if (!item) return { ok: false, error: 'That item is not in the shop' };

      if (signedIn) {
        try {
          const res = await fetch('/api/wallet/purchase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            return { ok: false, error: body?.error || 'Purchase failed' };
          }
          applyWallet(await res.json());
          return { ok: true };
        } catch {
          return { ok: false, error: 'Could not reach the shop' };
        }
      }

      // Re-read rather than trusting state: another tab may have spent first.
      const currentOwned = readOwned();
      if (currentOwned.includes(itemId)) return { ok: false, error: 'You already own that' };

      const currentCoins = readCoins();
      if (currentCoins < item.price) return { ok: false, error: 'Not enough Rewind Coins' };

      const newOwned = [...currentOwned, itemId];
      localStorage.setItem(COINS_KEY, String(currentCoins - item.price));
      localStorage.setItem(OWNED_KEY, JSON.stringify(newOwned));
      setCoins(currentCoins - item.price);
      setOwnedItems(newOwned);

      // A fresh purchase goes straight into its slot — nothing else to pick.
      const nextEquipped = { ...readEquipped(), [item.category]: itemId };
      localStorage.setItem(EQUIPPED_KEY, JSON.stringify(nextEquipped));
      setEquipped(nextEquipped);
      return { ok: true };
    },
    [signedIn, applyWallet]
  );

  const ownsItem = useCallback((itemId: string) => ownedItems.includes(itemId), [ownedItems]);

  return {
    coins,
    ownedItems,
    equipped,
    /** True once coins/owned reflect the real backing store. */
    loaded,
    /** True when this wallet is account-bound rather than localStorage. */
    persistent: signedIn,
    addCoins,
    buy,
    equip,
    unequip,
    ownsItem,
    refresh,
    SHOP_ITEMS,
  };
}
