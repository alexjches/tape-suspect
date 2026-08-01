// src/lib/playerId.ts
// The durable identity a player is known by, browser-side.
//
// Room state used to be keyed on `socket.id`, which dies with the connection:
// a refresh or a dropped wifi frame made a brand-new player and left the old
// one holding a vote, a turn and possibly the imposter role. This id is stored
// in localStorage and sent on `room:create` / `room:join`, so the server can
// recognise a returning socket as somebody it already knows.
//
// It is deliberately *not* the account id. A signed-in player may be in a
// lobby from two browsers, and a guest has no account at all — what a room
// needs is "this tab's owner", which is exactly one localStorage slot.

const KEY = 'imposter_player_id';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * This browser's player id, minting one on first use.
 *
 * Returns '' during SSR — callers render nothing identity-dependent until an
 * effect has run, so a server pass never disagrees with the first client pass.
 */
export function getPlayerId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = randomId();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Private mode with storage blocked: fall back to a per-tab id. Reconnect
    // stops working, which is no worse than the behaviour this replaced.
    return randomId();
  }
}
