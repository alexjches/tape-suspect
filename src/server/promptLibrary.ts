// src/server/promptLibrary.ts
// Loads the word and question pools from /content/prompts.json and picks each
// round's pair, for the two non-video modes.
//
// Server-only, for the same reason as videoLibrary.ts: the pool is the set the
// suspect's odd one out is drawn from, so it must never be bundled into the
// client. Import this from socket handlers, never from a component. Mode
// *names and icons* are the client-safe half and live in
// src/lib/videoCategories.ts.
//
// The one structural difference from videoLibrary: a pair here is authored,
// not assembled. A video round picks two independent clips from one genre and
// they are comparable because the genre made them comparable. Two independent
// *words* are not a game — the suspect is caught on the first clue unless the
// honest answers overlap, so `normal` and `imposter` are written together and
// travel together. Nothing in here may pick one half of one pair and one half
// of another.

import fs from 'fs';
import path from 'path';
import { PROMPT_MODE_IDS } from '../lib/videoCategories';

export interface PromptEntry {
  id: string;
  /** What the crew is shown. */
  normal: string;
  /** What the suspect is shown instead — a near miss, never a random other. */
  imposter: string;
  /** Internal note for whoever edits the file; never sent to players. */
  note?: string;
}

type PromptLibrary = Record<string, PromptEntry[]>;

const CONFIG_PATH = path.join(process.cwd(), 'content', 'prompts.json');

let cache: PromptLibrary | null = null;
let cacheMtimeMs = 0;

/**
 * Reads the config, re-reading whenever the file changes on disk so pairs can
 * be added without restarting the server. Falls back to the last good copy if
 * an edit leaves the file temporarily unparseable.
 */
function load(): PromptLibrary {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    if (!cache) console.error(`[Prompts] Missing config at ${CONFIG_PATH}`);
    return cache ?? {};
  }

  if (cache && mtimeMs === cacheMtimeMs) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    const parsed: PromptLibrary = {};
    for (const mode of PROMPT_MODE_IDS) {
      const entries = raw[mode];
      parsed[mode] = Array.isArray(entries)
        ? (entries as PromptEntry[]).filter(
            (e) =>
              e &&
              typeof e.id === 'string' &&
              typeof e.normal === 'string' &&
              e.normal.trim() !== '' &&
              typeof e.imposter === 'string' &&
              e.imposter.trim() !== ''
          )
        : [];
      if (parsed[mode].length === 0) {
        console.warn(`[Prompts] Mode "${mode}" has no usable pairs — it cannot be played`);
      }
    }
    cache = parsed;
    cacheMtimeMs = mtimeMs;
    console.log(
      `[Prompts] Loaded ${Object.entries(parsed)
        .map(([m, e]) => `${m}:${e.length}`)
        .join(' ')}`
    );
  } catch (err) {
    console.error(`[Prompts] Could not parse ${CONFIG_PATH}:`, err);
    return cache ?? {};
  }

  return cache;
}

export function getPromptPool(modeId: string): PromptEntry[] {
  return load()[modeId] ?? [];
}

export interface PromptPick {
  pair: PromptEntry;
  /** The caller's used-id list with this round's pick folded in. */
  usedIds: string[];
  /** True when the pool ran dry and the no-repeat history was recycled. */
  recycled: boolean;
}

/**
 * Picks one authored pair from a mode's pool.
 *
 * `usedIds` is the lobby session's no-repeat history — shared with the video
 * picker, since it is just "ids this lobby has already been served" and pair
 * ids (`w-…`, `q-…`) cannot collide with YouTube ids. A pair already used in
 * this lobby is excluded until the pool is exhausted, at which point this
 * mode's history is dropped and the full pool comes back. Other modes' history
 * survives, so switching mode mid-lobby doesn't reset the one you were on.
 */
export function pickPromptPair(modeId: string, usedIds: string[]): PromptPick | null {
  const pool = getPromptPool(modeId);
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

  const pair = available[Math.floor(Math.random() * available.length)];
  return { pair, usedIds: [...history, pair.id], recycled };
}
