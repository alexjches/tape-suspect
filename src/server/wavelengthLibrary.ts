// src/server/wavelengthLibrary.ts
// Loads the spectrum pool from /content/wavelength.json.
//
// Unlike the other three libraries this one is only *half* secret. The spectrum
// is public — everyone has to see the scale they are guessing on — and what is
// held back is the target position and who the psychic is. So this module is
// still server-only, but for the target it generates rather than for the pool
// it loads. Keeping it beside the others avoids a component ever reaching for
// the pool directly and shipping the whole list to the browser for no reason.

import fs from 'fs';
import path from 'path';

export interface SpectrumEntry {
  id: string;
  left: string;
  right: string;
}

const CONFIG_PATH = path.join(process.cwd(), 'content', 'wavelength.json');

let cache: SpectrumEntry[] | null = null;
let cacheMtimeMs = 0;

function load(): SpectrumEntry[] {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    if (!cache) console.error(`[Wavelength] Missing config at ${CONFIG_PATH}`);
    return cache ?? [];
  }
  if (cache && mtimeMs === cacheMtimeMs) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { spectrums?: unknown };
    const entries = Array.isArray(raw.spectrums) ? (raw.spectrums as SpectrumEntry[]) : [];
    const parsed = entries.filter(
      (e) =>
        e &&
        typeof e.id === 'string' &&
        typeof e.left === 'string' &&
        e.left.trim() !== '' &&
        typeof e.right === 'string' &&
        e.right.trim() !== ''
    );
    if (parsed.length === 0) console.warn('[Wavelength] No usable spectrums');
    cache = parsed;
    cacheMtimeMs = mtimeMs;
    console.log(`[Wavelength] Loaded ${parsed.length} spectrums`);
  } catch (err) {
    console.error(`[Wavelength] Could not parse ${CONFIG_PATH}:`, err);
    return cache ?? [];
  }
  return cache;
}

export interface SpectrumPick {
  entry: SpectrumEntry;
  /** 0-100, server-only until the reveal. */
  target: number;
  usedIds: string[];
  recycled: boolean;
}

/**
 * Picks a spectrum and rolls the round's hidden target.
 *
 * The target is clamped to 8..92 rather than the full 0..100. A target at the
 * very end is a bad round twice over: the psychic's only honest clue is the
 * end label itself, and the scoring band is clipped by the edge so a guess that
 * overshoots cannot be punished symmetrically.
 */
export function pickSpectrum(usedIds: string[]): SpectrumPick | null {
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
  const target = 8 + Math.floor(Math.random() * 85);
  return { entry, target, usedIds: [...history, entry.id], recycled };
}

/** Points for one guess (the real game's bands, on a 0-100 scale). */
export function scoreGuess(guess: number, target: number): number {
  const d = Math.abs(guess - target);
  if (d <= 5) return 4;
  if (d <= 10) return 3;
  if (d <= 20) return 2;
  return 0;
}
