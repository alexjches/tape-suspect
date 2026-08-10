// src/server/drawLibrary.ts
// Loads the Fake Artist word list from /content/fakeartist.json.
//
// Server-only, same rule as videoLibrary.ts and promptLibrary.ts: this is the
// answer sheet. Import it from socket handlers, never from a component.
//
// Structurally simpler than promptLibrary, and the difference is the whole
// point of the mode. A Words round deals an authored *pair* because nobody may
// learn they are the odd one out. Fake Artist deals one word to everybody else
// and tells the fake they are the fake — so there is nothing to pair, and the
// second field is a `theme` hint rather than a near-miss word.

import fs from 'fs';
import path from 'path';

export interface DrawEntry {
  id: string;
  /** Dealt to the crew. Public at results, and not one moment before. */
  word: string;
  /** Dealt to the fake, and only when settings.themeHint is on. */
  theme: string;
}

const CONFIG_PATH = path.join(process.cwd(), 'content', 'fakeartist.json');

let cache: DrawEntry[] | null = null;
let cacheMtimeMs = 0;

/**
 * Reads the config, re-reading whenever it changes on disk so words can be
 * added without a restart. Keeps the last good copy if an edit leaves the file
 * unparseable, so a stray comma doesn't take every lobby down.
 */
function load(): DrawEntry[] {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    if (!cache) console.error(`[FakeArtist] Missing config at ${CONFIG_PATH}`);
    return cache ?? [];
  }

  if (cache && mtimeMs === cacheMtimeMs) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { words?: unknown };
    const entries = Array.isArray(raw.words) ? (raw.words as DrawEntry[]) : [];
    const parsed = entries.filter(
      (e) =>
        e &&
        typeof e.id === 'string' &&
        typeof e.word === 'string' &&
        e.word.trim() !== '' &&
        typeof e.theme === 'string' &&
        e.theme.trim() !== ''
    );
    if (parsed.length === 0) {
      console.warn('[FakeArtist] No usable words — the mode cannot be played');
    }
    cache = parsed;
    cacheMtimeMs = mtimeMs;
    console.log(`[FakeArtist] Loaded ${parsed.length} words`);
  } catch (err) {
    console.error(`[FakeArtist] Could not parse ${CONFIG_PATH}:`, err);
    return cache ?? [];
  }

  return cache;
}

export interface DrawPick {
  entry: DrawEntry;
  /** The caller's used-id list with this round's pick folded in. */
  usedIds: string[];
  /** True when the pool ran dry and the no-repeat history was recycled. */
  recycled: boolean;
}

/**
 * Picks one word, skipping anything this lobby has already drawn.
 *
 * Shares `room.usedVideoIds` with the other pickers — it is just "ids this
 * lobby has been served", and `fa-…` cannot collide with a YouTube id or a
 * prompt pair id, so one history covers all three modes.
 */
export function pickDrawWord(usedIds: string[]): DrawPick | null {
  const pool = load();
  if (pool.length === 0) return null;

  const poolIds = new Set(pool.map((p) => p.id));
  let history = usedIds;
  let available = pool.filter((p) => !history.includes(p.id));
  let recycled = false;

  if (available.length === 0) {
    history = history.filter((id) => !poolIds.has(id));
    available = pool;
    recycled = true;
  }

  const entry = available[Math.floor(Math.random() * available.length)];
  return { entry, usedIds: [...history, entry.id], recycled };
}
