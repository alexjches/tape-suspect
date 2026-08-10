// src/server/bluffLibrary.ts
// Loads the obscure-word pool from /content/bluff.json.
//
// Server-only like the other pools, and here the reason is unusually literal:
// this file contains the correct answer to every round. The word becomes public
// at the start of the phase; the definition does not leave the server until it
// is sitting anonymously in the ballot alongside the players' fakes.

import fs from 'fs';
import path from 'path';

export interface BluffEntry {
  id: string;
  word: string;
  definition: string;
}

const CONFIG_PATH = path.join(process.cwd(), 'content', 'bluff.json');

let cache: BluffEntry[] | null = null;
let cacheMtimeMs = 0;

function load(): BluffEntry[] {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    if (!cache) console.error(`[Bluff] Missing config at ${CONFIG_PATH}`);
    return cache ?? [];
  }
  if (cache && mtimeMs === cacheMtimeMs) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { words?: unknown };
    const entries = Array.isArray(raw.words) ? (raw.words as BluffEntry[]) : [];
    const parsed = entries.filter(
      (e) =>
        e &&
        typeof e.id === 'string' &&
        typeof e.word === 'string' &&
        e.word.trim() !== '' &&
        typeof e.definition === 'string' &&
        e.definition.trim() !== ''
    );
    if (parsed.length === 0) console.warn('[Bluff] No usable words');
    cache = parsed;
    cacheMtimeMs = mtimeMs;
    console.log(`[Bluff] Loaded ${parsed.length} words`);
  } catch (err) {
    console.error(`[Bluff] Could not parse ${CONFIG_PATH}:`, err);
    return cache ?? [];
  }
  return cache;
}

export interface BluffPick {
  entry: BluffEntry;
  usedIds: string[];
  recycled: boolean;
}

export function pickBluffWord(usedIds: string[]): BluffPick | null {
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

/**
 * The ballot id of the true definition.
 *
 * A sentinel rather than a player id, because the real definition has no
 * author — which is the one structural difference between this ballot and
 * every other one in the game. Prefixed so it can never collide with a
 * `crypto.randomUUID()` player id.
 */
export const REAL_DEFINITION_ID = '__real__';

/** Points for fooling one player into picking your fake. */
export const POINTS_PER_FOOL = 2;
/** Points for picking the true definition. */
export const POINTS_FOR_TRUTH = 3;
