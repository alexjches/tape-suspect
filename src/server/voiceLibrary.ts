// src/server/voiceLibrary.ts
// Loads the Choicer Voicer pool from /content/voicelines.json.
//
// Server-only, and for a sharper reason than the other libraries. Their pools
// are secret because the pool is the set the odd one out is drawn from. Here
// the *line* is public — everyone has to know what they are performing — and
// what must not leave the server is the `fingerprint`: it is the answer key the
// takes are scored against, and a client holding it could submit it back
// verbatim for a perfect score. So the split inside this module mirrors
// Wavelength's: `VoiceLinePublic` is the half that rides sanitizeRoom, and the
// reference vector stays here.
//
// Mirrors videoLibrary's mtime cache so lines can be added without a restart,
// and keeps the last good copy if an edit leaves the file unparseable.

import fs from 'fs';
import path from 'path';
import { FINGERPRINT_LENGTH } from '../lib/audioFingerprint';
import { WAVEFORM_COLUMNS } from '../lib/waveform';

/** The half of a line every player sees. */
export interface VoiceLinePublic {
  id: string;
  quote: string;
  source: string;
  /**
   * Same-origin path to the original recording, e.g. `/audio/voicelines/x.mp3`.
   *
   * **Same-origin is a requirement, not a convention.** The client does three
   * things with this file — plays it, draws its waveform, and lets a player
   * replay it — and the last two need `decodeAudioData`, which needs the bytes.
   * A cross-origin URL without CORS headers plays but cannot be decoded, so the
   * waveform silently comes out empty. Drop files in `public/audio/voicelines/`.
   *
   * Null on a line with no audio: the round still runs off the quote alone,
   * with no listen beat and no replay control.
   */
  audio: string | null;
  /**
   * The moment on YouTube, through the ordinary IFrame API (§5).
   *
   * Playback only. An embed is a cross-origin iframe, so nothing on the page can
   * read its samples — a YouTube-only line draws its ORIGINAL bar from `peaks`
   * and needs a separate local copy of the audio to be fingerprinted at all.
   */
  youtubeId: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
  /** WAVEFORM_COLUMNS numbers, 0..1, or null to decode `audio` client-side. */
  peaks: number[] | null;
  /**
   * Whether this round is scored against the original recording or against the
   * room's own average take. Public on purpose: it changes what a score means,
   * and a leaderboard that does not say what it measured is worse than no
   * leaderboard. Never carries the vector itself.
   */
  hasReference: boolean;
}

export interface VoiceLineEntry extends VoiceLinePublic {
  /** 384 numbers, or null when nobody has fingerprinted the original yet. */
  fingerprint: number[] | null;
}

const CONFIG_PATH = path.join(process.cwd(), 'content', 'voicelines.json');

let cache: VoiceLineEntry[] | null = null;
let cacheMtimeMs = 0;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A reference vector is accepted only at exactly the right length.
 *
 * A short or long array is a fingerprint generated against a different band or
 * frame count — almost certainly an older version of scripts/fingerprint-
 * voiceline.mjs — and comparing against it would not error, it would just score
 * every take at zero. Dropping to the consensus path is the honest failure.
 */
/**
 * Accepts only a rooted, same-origin path.
 *
 * An absolute URL is rejected rather than passed through, and the reason is the
 * one on `VoiceLinePublic.audio`: a cross-origin file plays but will not decode,
 * so the waveform and the replay button come out silently broken. Failing here
 * — where the line simply runs without audio — is the visible failure. `..` is
 * refused too: this string is handed to the browser as a URL, and a content
 * file should not be able to point it at an arbitrary path.
 */
function audioPathOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path) return null;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) {
    console.warn(`[Voicer] Ignoring audio path "${path}" — must be a rooted same-origin path`);
    return null;
  }
  return path;
}

function referenceOrNull(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== FINGERPRINT_LENGTH) return null;
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return value as number[];
}

/**
 * The precomputed envelope, clamped to 0..1 at exactly the column count.
 *
 * Length is exact for the reason a fingerprint's is: a 64-column array is one
 * generated against a different WAVEFORM_COLUMNS, and padding it would draw a
 * waveform that is subtly wrong at every column rather than reporting anything.
 */
function peaksOrNull(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== WAVEFORM_COLUMNS) return null;
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return value.map((n) => Math.max(0, Math.min(1, n as number)));
}

/**
 * A YouTube id out of either `youtubeId` (a bare id) or `youtube` (a pasted
 * URL). Two fields because an author pastes the address bar and a script writes
 * the id, and asking either of them to do the other's job is how you get an id
 * with a `&t=` still stuck on the end.
 *
 * Deliberately not shared with src/lib/youtubeApi.ts's parser: that one runs in
 * the browser and this file is server-only, and the URL forms are a handful of
 * lines. The one rule both keep is the 11-character shape — anything else is a
 * typo, and a typo here plays somebody else's video with nothing reported.
 */
function youtubeIdOrNull(entry: Record<string, unknown>): { id: string; start: number | null } {
  const bare = typeof entry.youtubeId === 'string' ? entry.youtubeId.trim() : '';
  if (/^[\w-]{11}$/.test(bare)) return { id: bare, start: null };
  if (bare) console.warn(`[Voicer] Ignoring youtubeId "${bare}" — not an 11-character video id`);

  const pasted = typeof entry.youtube === 'string' ? entry.youtube.trim() : '';
  if (!pasted) return { id: '', start: null };

  let url: URL;
  try {
    url = new URL(pasted);
  } catch {
    console.warn(`[Voicer] Ignoring youtube "${pasted}" — not a URL`);
    return { id: '', start: null };
  }
  let id: string | null = null;
  if (url.hostname.endsWith('youtu.be')) {
    id = url.pathname.slice(1).split('/')[0] || null;
  } else if (url.hostname.endsWith('youtube.com')) {
    id = url.searchParams.get('v');
    if (!id) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1];
    }
  }
  if (!id || !/^[\w-]{11}$/.test(id)) {
    console.warn(`[Voicer] Ignoring youtube "${pasted}" — no video id in it`);
    return { id: '', start: null };
  }

  // `t=90`, `t=90s` and `t=1m30s` are all forms YouTube itself writes.
  const t = url.searchParams.get('t') ?? url.searchParams.get('start');
  let start: number | null = null;
  if (t) {
    const plain = Number(t.replace(/s$/, ''));
    if (Number.isFinite(plain)) start = plain;
    else {
      const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
      if (m) start = +(m[1] ?? 0) * 3600 + +(m[2] ?? 0) * 60 + +(m[3] ?? 0);
    }
  }
  return { id, start };
}

function load(): VoiceLineEntry[] {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    if (!cache) console.error(`[Voicer] Missing config at ${CONFIG_PATH}`);
    return cache ?? [];
  }
  if (cache && mtimeMs === cacheMtimeMs) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { lines?: unknown };
    const entries = Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]) : [];
    const parsed: VoiceLineEntry[] = entries
      .filter(
        (e) =>
          e &&
          typeof e.id === 'string' &&
          e.id.trim() !== '' &&
          typeof e.quote === 'string' &&
          e.quote.trim() !== ''
      )
      .map((e) => {
        const yt = youtubeIdOrNull(e);
        return {
          id: (e.id as string).trim(),
          quote: (e.quote as string).trim(),
          source: typeof e.source === 'string' ? e.source.trim() : '',
          audio: audioPathOrNull(e.audio),
          youtubeId: yt.id || null,
          // An explicit `start` wins over one carried on the pasted URL, since
          // the field is the deliberate answer and the `t=` is whatever the tab
          // happened to be at.
          startSeconds: numberOrNull(e.start) ?? yt.start,
          endSeconds: numberOrNull(e.end),
          peaks: peaksOrNull(e.peaks),
          fingerprint: referenceOrNull(e.fingerprint),
          hasReference: referenceOrNull(e.fingerprint) !== null,
        };
      });

    if (parsed.length === 0) console.warn('[Voicer] No usable lines');
    cache = parsed;
    cacheMtimeMs = mtimeMs;
    const withRef = parsed.filter((p) => p.hasReference).length;
    const withAudio = parsed.filter((p) => p.audio).length;
    const withYouTube = parsed.filter((p) => p.youtubeId).length;
    console.log(
      `[Voicer] Loaded ${parsed.length} lines (${withRef} with a reference fingerprint, ` +
        `${parsed.length - withRef} scored against the room; ${withAudio} with local audio, ` +
        `${withYouTube} with a YouTube clip)`
    );
    const playable = parsed.filter((p) => p.audio || p.youtubeId).length;
    if (playable === 0) {
      console.warn(
        '[Voicer] No line can be played — every round will be quote-only. ' +
          'Paste YouTube links into content/voicelines.json (see its _comment).'
      );
    }
  } catch (err) {
    console.error(`[Voicer] Could not parse ${CONFIG_PATH}:`, err);
    return cache ?? [];
  }
  return cache;
}

export interface VoiceLinePick {
  entry: VoiceLineEntry;
  usedIds: string[];
  recycled: boolean;
}

/**
 * Picks a line this lobby has not performed yet.
 *
 * Same no-repeat contract as every other pool (§14) and on the same shared
 * `room.usedVideoIds`, which the `vo-` prefix keeps clear of YouTube ids.
 */
export function pickVoiceLine(usedIds: string[]): VoiceLinePick | null {
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

/** Strips the reference off a line. The one shape allowed out of the server. */
export function publicLine(entry: VoiceLineEntry): VoiceLinePublic {
  return {
    id: entry.id,
    quote: entry.quote,
    source: entry.source,
    audio: entry.audio,
    youtubeId: entry.youtubeId,
    startSeconds: entry.startSeconds,
    endSeconds: entry.endSeconds,
    peaks: entry.peaks,
    hasReference: entry.hasReference,
  };
}
