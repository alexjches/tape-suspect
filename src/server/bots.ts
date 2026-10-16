// src/server/bots.ts
// Simulated players, for testing a round without four more browsers.
//
// This module is deliberately only *what a bot is and says* — its name, its
// face, its vocabulary, how long it waits before doing things. **When** a bot
// acts lives in socketHandlers.ts, in `runBotTick`, because acting means
// calling the same gameState mutators and broadcast helpers a real player's
// socket event calls. Driving them through a parallel path is how a test
// harness ends up passing against behaviour the real game does not have.
//
// A bot has no socket. `Player.socketId` is '' and every `io.to(socketId)`
// emit therefore addresses nothing and fails silently — which is fine for
// `game:assigned` (a bot needs no video URL) but is the reason a bot can
// never be driven by "pretend it sent this event".

import type { Player } from './gameState';
import { REACTION_EMOJI, type ReactionEmoji } from '../types';
import { CHARACTERS } from '../lib/avatars';
import {
  FINGERPRINT_BANDS,
  FINGERPRINT_FRAMES,
  FINGERPRINT_LENGTH,
  normaliseFrames,
} from '../lib/audioFingerprint';

/**
 * Master switch. Bots let one person fill and start a lobby, so on a public
 * deployment they are a way to stuff every open room with fake players —
 * hence off unless explicitly enabled, and never on by default in production.
 *
 * Default-on in development is the whole point of the feature; the env var is
 * there so a staging box can turn it off, or a production one can turn it on
 * deliberately for a smoke test.
 */
export const BOTS_ENABLED =
  process.env.ALLOW_BOT_PLAYERS === 'true' ||
  (process.env.ALLOW_BOT_PLAYERS !== 'false' && process.env.NODE_ENV !== 'production');

/** Marks a bot's id, so nothing has to guess from the name. */
export const BOT_ID_PREFIX = 'bot:';

export function isBotId(id: string): boolean {
  return id.startsWith(BOT_ID_PREFIX);
}

// Named rather than numbered so the word board and the vote grid read like a
// real lobby. The roster is walked in order, so a 4-bot fill is reproducible.
const BOT_NAMES = [
  'ROXY', 'DIGBY', 'MAVIS', 'OTIS', 'PEARL',
  'HUGO', 'WANDA', 'CLIVE', 'NADIA',
];

/** Faces for the fill, walked in order so a 4-bot lobby is reproducible.
 *
 *  Derived from the roster rather than listed, because a hand-written list of
 *  ids goes stale silently: an id that no longer exists still renders, it just
 *  hashes to some other character. This used to hold a hand-picked subset so a
 *  human was unlikely to collide with a bot's face — with a cast this small
 *  there is no subset to pick, and the SIM badge is what tells them apart. */
const BOT_AVATARS = CHARACTERS.map((c) => c.id);

/**
 * Plausible one-word descriptions. The point is not that a bot plays well —
 * it cannot, it has never seen the video — but that the word board and the
 * deliberation screen have realistic-length content to lay out.
 */
const BOT_WORDS = [
  'LOUD', 'CHAOS', 'FUNNY', 'AWKWARD', 'FAST', 'CROWD', 'MUSIC', 'FALLING',
  'SHOUTING', 'BRIGHT', 'CAR', 'DANCING', 'ANIMAL', 'SPORT', 'CRASH',
  'DRAMATIC', 'SLOW', 'WEIRD', 'GREEN', 'RUNNING',
];

/**
 * Per-bot scheduling state. Lives on the Player object so it dies with the
 * room and needs no separate cleanup pass — the same reasoning as
 * `lastReactionAt`. Server-only: `sanitizeRoom()` picks its fields
 * explicitly, so none of this is broadcast.
 */
export interface BotRuntime {
  /** Epoch ms this bot may next react; 0 before the tape rolls. */
  nextReactAt: number;
  /** Epoch ms this bot will click Ready. */
  readyAt: number;
  /** Epoch ms this bot will speak, set when its turn opens. */
  speakAt: number;
  /** Epoch ms this bot will vote, set when deliberation opens. */
  voteAt: number;
}

export function freshBotRuntime(): BotRuntime {
  return { nextReactAt: 0, readyAt: 0, speakAt: 0, voteAt: 0 };
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Builds a bot Player. `index` positions it in the name/face rosters. */
export function makeBot(index: number): Player {
  const name = BOT_NAMES[index % BOT_NAMES.length];
  return {
    id: `${BOT_ID_PREFIX}${index}-${Math.random().toString(36).slice(2, 8)}`,
    // No transport. Everything that emits to one player must tolerate this,
    // which it does — the `!player.socketId` guard in game:start is the
    // pattern to copy for anything new.
    socketId: '',
    // Never a real account, which is also what keeps `bankRewards` from
    // paying them: it skips every player with a null userId.
    userId: null,
    name: `${name} (BOT)`,
    avatar: BOT_AVATARS[index % BOT_AVATARS.length],
    cosmetics: { 'tape-skin': null, 'vcr-skin': null, 'tape-label': null },
    isHost: false,
    isReady: false,
    isSpectator: false,
    status: 'connected',
    isBot: true,
    bot: freshBotRuntime(),
  };
}

// ── Timings ──────────────────────────────────────────────────────────────
// All jittered, so a lobby of bots does not act in lockstep — which would
// both look wrong and hide ordering bugs that a real lobby would expose.

/** How long a bot "buffers" before reporting its video loaded. */
export const botLoadDelay = () => rand(250, 1400);

/**
 * How long before a bot clicks Ready.
 *
 * Bots deliberately never report `game:videoEnded`. That event is what arms
 * the 10s post-imposter grace timer, and a bot drawn as the imposter would
 * therefore yank a human out of the video seconds after it started. Clicking
 * Ready is enough: it stops bots ever *blocking* the phase, while leaving
 * when the round actually advances up to the human watching.
 */
export const botReadyDelay = () => rand(1500, 4000);

/** Gap between one bot's reactions while the tape is rolling. */
export const botReactGap = () => rand(2500, 7000);

/** How long a bot takes to type its word once its turn opens. */
export const botSpeakDelay = () => rand(1200, 3500);

/** How long a bot deliberates before voting. */
export const botVoteDelay = () => rand(3000, 9000);

/**
 * A simulated take, for Choicer Voicer.
 *
 * A bot has no microphone, so what it cannot do is *record*. What it can do is
 * hand over a fingerprint of the right shape — and that matters, because it
 * means the bot's score is **computed by the same `similarity()` the player's
 * is** rather than fabricated as a percentage. That is the difference between a
 * bot filling the round being tested and a bot filling a different one.
 *
 * The first version returned a random 30–80% instead, and it failed the case
 * bots exist for. On a line with no reference recording, every take is scored
 * against the average of the *others'* fingerprints — so a lone human among
 * bots with no fingerprints had nothing to be compared with and scored 0%,
 * which reads as the mode being broken rather than as the tester being alone.
 *
 * Two shapes, because a bot has to be plausible against whichever it is up
 * against:
 *
 *   with a reference  the reference itself, roughened. `spread` decides how
 *                     badly — the caller varies it, so a table of bots is not
 *                     six identical scores.
 *   without           a smooth random contour: a few low-frequency waves per
 *                     band, which is what a voice actually looks like here
 *                     (see the per-band mean subtraction in fingerprint()).
 *                     White noise would be wrong — it scores ~0 against
 *                     everything, which is the bug this replaces.
 */
export function botFingerprint(reference: number[] | null): number[] {
  const grid = new Array<number>(FINGERPRINT_LENGTH).fill(0);

  if (reference && reference.length === FINGERPRINT_LENGTH) {
    // 0.25–0.9 puts the resulting match roughly between 40% and 85% — inside
    // what a real take reaches, and short of the near-perfect scores a good
    // impression earns, so bots never crowd the human off their own board.
    const spread = 0.25 + Math.random() * 0.65;
    for (let i = 0; i < FINGERPRINT_LENGTH; i++) {
      grid[i] = reference[i] + (Math.random() * 2 - 1) * spread;
    }
    return normaliseFrames(grid);
  }

  // Three slow waves per band, at a phase and rate drawn per band. Slow is the
  // point: a fingerprint's frames are a contour over time, so neighbouring
  // frames in a real take are strongly related and the average of several bots
  // is something a human take can genuinely be close to or far from.
  for (let b = 0; b < FINGERPRINT_BANDS; b++) {
    const waves = [0, 1, 2].map(() => ({
      rate: 0.4 + Math.random() * 1.6,
      phase: Math.random() * Math.PI * 2,
      gain: Math.random(),
    }));
    for (let f = 0; f < FINGERPRINT_FRAMES; f++) {
      const p = f / FINGERPRINT_FRAMES;
      let v = 0;
      for (const w of waves) v += w.gain * Math.sin(2 * Math.PI * w.rate * p + w.phase);
      grid[f * FINGERPRINT_BANDS + b] = v;
    }
  }
  return normaliseFrames(grid);
}

export function botWord(): string {
  return BOT_WORDS[Math.floor(Math.random() * BOT_WORDS.length)];
}

export function botEmoji(): ReactionEmoji {
  return REACTION_EMOJI[Math.floor(Math.random() * REACTION_EMOJI.length)];
}

/**
 * Picks a vote target from the ids a bot is actually allowed to name.
 *
 * **Bots bandwagon onto the current leader**, and that is not laziness — a
 * bot choosing uniformly at random is markedly *more* tie-prone than a real
 * lobby, where players talk and converge on a suspect. Uniform bots in a
 * 4-player room tie constantly, and since §8 says a tie must re-vote rather
 * than resolve, the tester ends up watching round 2, round 3, round 4 and
 * never reaching the results screen they were trying to look at. Observed:
 * three consecutive three-way ties in one sitting.
 *
 * Following the leader converges, mimics how a real deliberation actually
 * goes, and makes the human's own vote the thing that decides the round —
 * which for a testing aid is the useful behaviour. Randomness is kept for
 * the opening ballot, so it is not the same story every time.
 */
export function botVoteTarget(
  candidates: string[],
  selfId: string,
  votesSoFar: Record<string, string>
): string | null {
  const pool = candidates.filter((id) => id !== selfId);
  if (pool.length === 0) return null;

  // Tally the ballots already cast, restricted to who is actually on offer.
  const counts = new Map<string, number>();
  for (const target of Object.values(votesSoFar)) {
    if (pool.includes(target)) counts.set(target, (counts.get(target) ?? 0) + 1);
  }

  let leader: string | null = null;
  let best = 0;
  let tied = false;
  for (const [id, n] of counts) {
    if (n > best) {
      leader = id;
      best = n;
      tied = false;
    } else if (n === best) {
      tied = true;
    }
  }

  // A clear leader gets backed. A tie among leaders is exactly the situation
  // that must not be reinforced, so fall through to a random pick and let
  // somebody move.
  if (leader && !tied) return leader;
  return pool[Math.floor(Math.random() * pool.length)];
}
