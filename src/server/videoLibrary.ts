// src/server/videoLibrary.ts
// Loads the genre pools from /content/videos.json and picks each round's pair
// (docs/BUILD-PLAN.md section 14).
//
// Server-only. The pool is the set the imposter's clip is drawn from, so it
// must never be bundled into the client — import this from socket handlers and
// API routes, never from a component. Genre *names and icons* are the
// client-safe half and live in src/lib/videoCategories.ts.

import fs from 'fs';
import path from 'path';
import { POOL_CATEGORY_IDS } from '../lib/videoCategories';

export interface VideoEntry {
  id: string;
  /** Bare YouTube ID — the part after v= (section 14). */
  youtubeId: string;
  /** Internal note for whoever edits the file; never sent to players. */
  label?: string;
  tags?: string[];
}

type VideoLibrary = Record<string, VideoEntry[]>;

const CONFIG_PATH = path.join(process.cwd(), 'content', 'videos.json');

let cache: VideoLibrary | null = null;
let cacheMtimeMs = 0;

/**
 * Reads the config, re-reading whenever the file changes on disk so links can
 * be added without restarting the server. Falls back to the last good copy if
 * an edit leaves the file temporarily unparseable.
 */
function load(): VideoLibrary {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    if (!cache) console.error(`[Videos] Missing config at ${CONFIG_PATH}`);
    return cache ?? {};
  }

  if (cache && mtimeMs === cacheMtimeMs) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    const parsed: VideoLibrary = {};
    for (const genre of POOL_CATEGORY_IDS) {
      const entries = raw[genre];
      parsed[genre] = Array.isArray(entries)
        ? (entries as VideoEntry[]).filter((e) => e && typeof e.youtubeId === 'string')
        : [];
      if (parsed[genre].length < 2) {
        console.warn(`[Videos] Genre "${genre}" has fewer than 2 clips — it cannot be played`);
      }
    }
    cache = parsed;
    cacheMtimeMs = mtimeMs;
    console.log(
      `[Videos] Loaded ${Object.entries(parsed)
        .map(([g, e]) => `${g}:${e.length}`)
        .join(' ')}`
    );
  } catch (err) {
    console.error(`[Videos] Could not parse ${CONFIG_PATH}:`, err);
    return cache ?? {};
  }

  return cache;
}

export function getGenrePool(genreId: string): VideoEntry[] {
  return load()[genreId] ?? [];
}

export function watchUrl(youtubeId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

export interface VideoPair {
  normal: VideoEntry;
  imposter: VideoEntry;
  /** The caller's used-id list with this round's picks folded in. */
  usedIds: string[];
  /** True when the pool ran dry and the no-repeat history was recycled. */
  recycled: boolean;
}

/**
 * Picks two distinct clips from one genre pool (section 14).
 *
 * `usedIds` is the lobby session's no-repeat history: clips already shown in
 * this lobby are excluded until the genre's pool is exhausted, at which point
 * that genre's history is dropped and the full pool becomes available again.
 * Other genres' history survives, so switching genre mid-lobby doesn't reset
 * the one you were playing.
 */
export function pickVideoPair(genreId: string, usedIds: string[]): VideoPair | null {
  const pool = getGenrePool(genreId);
  if (pool.length < 2) return null;

  const poolIds = new Set(pool.map((v) => v.youtubeId));
  let history = usedIds;
  let available = pool.filter((v) => !history.includes(v.youtubeId));
  let recycled = false;

  if (available.length < 2) {
    history = history.filter((id) => !poolIds.has(id));
    available = pool;
    recycled = true;
  }

  const first = Math.floor(Math.random() * available.length);
  // Offset instead of re-rolling so the second pick can never equal the first.
  const second = (first + 1 + Math.floor(Math.random() * (available.length - 1))) % available.length;

  const normal = available[first];
  const imposter = available[second];

  return {
    normal,
    imposter,
    usedIds: [...history, normal.youtubeId, imposter.youtubeId],
    recycled,
  };
}
