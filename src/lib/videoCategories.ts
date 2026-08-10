// src/lib/videoCategories.ts
// Game-mode metadata — the display side of the mode list in
// docs/BUILD-PLAN.md section 4, plus the two non-video styles added since.
// Client-safe: no filesystem access, no video IDs, no prompt text.
//
// The clips live in /content/videos.json and the word/question pairs in
// /content/prompts.json; both are loaded server-side (src/server/videoLibrary
// .ts, src/server/promptLibrary.ts). Keeping those apart from this file is
// deliberate: a pool is the set the imposter's odd one out is drawn from, so
// it must never reach a browser bundle, and the config files stay editable
// without touching game logic (section 14).
//
// The wire field is still called `videoCategory` — it dates from when every
// mode was a video, and renaming it would ripple through RoomState,
// RoomPublic, room:updateSettings and both screens for no behavioural gain.
// Read it as "mode id" and use modeStyle() to find out what kind it is.

/**
 * The mode id Custom used to be.
 *
 * Custom is no longer a mode — it is `settings.useCustomContent`, a switch on
 * whatever mode the lobby has picked, so that a host can supply their own pair
 * for a *prompt* round as well as for a video one. Nothing produces this id any
 * more; it survives so a stale client tab that still has the old card can be
 * translated at the socket boundary (see room:updateSettings) instead of
 * silently landing on a mode that no longer exists.
 */
export const CUSTOM_CATEGORY = 'custom';

/**
 * What shape of round a mode produces — the "style of odd man out".
 *
 *   video     two tapes, watched in sync, then words
 *   word      everyone gets a word, the suspect gets a different one
 *   question  everyone gets a question, the suspect gets a different one
 *   draw      everyone draws one word, one stroke each in turn — and the fake
 *             is *told* they are the fake
 *   spectrum  no hidden role and no accusation: one player sees a target on a
 *             scale and clues the rest towards it, and everyone scores by how
 *             close they land
 *   bluff     an obscure word, everyone writes a fake definition, then the
 *             room votes on which one is real. Also scored, not accused
 *
 * Only `video` needs the sync, the player lockdown and the tape animations.
 * `word` and `question` are read off a card and the round moves straight on.
 *
 * `draw` is the one style where a player learns their own role, which is why
 * it is a style of its own rather than another prompt mode. Everything else in
 * the game rests on nobody knowing; here the fake knowing is the mechanic, and
 * the invariant narrows to "nobody learns anyone *else's* role" — imposterIds
 * still never leaves the server in a broadcast.
 */
export type ModeStyle = 'video' | 'word' | 'question' | 'draw' | 'spectrum' | 'bluff';

export interface VideoCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
  style: ModeStyle;
}

// Video order follows section 4: Sports, Memes, Video Games, Music, Custom.
export const VIDEO_CATEGORIES: Record<string, VideoCategory> = {
  sports: {
    id: 'sports',
    name: 'Sports',
    icon: '🏆',
    description: 'Goals, dunks and iconic sporting moments',
    style: 'video',
  },
  memes: {
    id: 'memes',
    name: 'Memes',
    icon: '😂',
    description: 'Viral clips and internet classics',
    style: 'video',
  },
  video_games: {
    id: 'video_games',
    name: 'Video Games',
    icon: '🎮',
    description: 'Trailers and reveals from big-name games',
    style: 'video',
  },
  music: {
    id: 'music',
    name: 'Music Videos',
    icon: '🎵',
    description: 'Hit songs and music clips',
    style: 'video',
  },
  words: {
    id: 'words',
    name: 'Words',
    icon: '🔤',
    description: 'Everyone gets a word — the suspect gets a near miss',
    style: 'word',
  },
  questions: {
    id: 'questions',
    name: 'Questions',
    icon: '❓',
    description: 'Everyone answers a question — the suspect answers a different one',
    style: 'question',
  },
  fake_artist: {
    id: 'fake_artist',
    name: 'Fake Artist',
    icon: '🖌️',
    description: 'Draw one word together, a stroke each — one of you is faking it',
    style: 'draw',
  },
  wavelength: {
    id: 'wavelength',
    name: 'Wavelength',
    icon: '🎯',
    description: 'One player clues a hidden point on a scale — everyone dials in',
    style: 'spectrum',
  },
  bluff: {
    id: 'bluff',
    name: 'Bluff',
    icon: '📖',
    description: 'An obscure word — write a fake meaning, then spot the real one',
    style: 'bluff',
  },
};

/**
 * The mode grid, in two sections: the games, then the videos.
 *
 * The split that matters to a lobby is whether there is a tape to watch at all
 * — that decides whether the next five minutes need everyone's attention on
 * one screen. Everything else (a word, a question, a canvas, a scale, a
 * dictionary) is a card on your own screen and belongs together under one
 * heading; sectioning those four apart said they were four different kinds of
 * thing when the only choice being made is which one.
 *
 * Videos sit at the bottom, after them: the four video genres are five of the
 * ten cards and were pushing everything else below the fold of a panel that
 * scrolls.
 */
export interface ModeGroup {
  id: string;
  label: string;
  blurb: string;
  modeIds: string[];
}

export const MODE_GROUPS: ModeGroup[] = [
  {
    id: 'games',
    label: 'GAMES',
    blurb: 'No tape to watch — read your card and talk your way out of it',
    modeIds: ['words', 'questions', 'fake_artist', 'wavelength', 'bluff'],
  },
  {
    id: 'video',
    label: 'VIDEOS',
    blurb: 'Watch a clip together — one of you is watching a different one',
    modeIds: ['sports', 'memes', 'video_games', 'music'],
  },
];

/** The video genres backed by a pool in /content/videos.json. */
export const POOL_CATEGORY_IDS = Object.values(VIDEO_CATEGORIES)
  .filter((c) => c.style === 'video')
  .map((c) => c.id);

/**
 * The prompt modes backed by a pool in /content/prompts.json.
 *
 * Matched on the two prompt styles by name rather than on `!== 'video'`, which
 * is what it used to say: the moment a fourth style existed that test quietly
 * pulled Fake Artist into the prompt pool, where it has no pairs and would have
 * failed at deal time with a confusing "needs at least one pair configured".
 */
export const PROMPT_MODE_IDS = Object.values(VIDEO_CATEGORIES)
  .filter((c) => c.style === 'word' || c.style === 'question')
  .map((c) => c.id);

/** The one mode backed by /content/bluff.json. */
export const BLUFF_MODE_IDS = Object.values(VIDEO_CATEGORIES)
  .filter((c) => c.style === 'bluff')
  .map((c) => c.id);

/** The one mode backed by /content/wavelength.json. */
export const SPECTRUM_MODE_IDS = Object.values(VIDEO_CATEGORIES)
  .filter((c) => c.style === 'spectrum')
  .map((c) => c.id);

/** The one mode backed by /content/fakeartist.json. */
export const DRAW_MODE_IDS = Object.values(VIDEO_CATEGORIES)
  .filter((c) => c.style === 'draw')
  .map((c) => c.id);

export function isKnownCategory(id: string | null | undefined): boolean {
  return !!id && id in VIDEO_CATEGORIES;
}

/**
 * What kind of round this mode id produces.
 *
 * Falls back to 'video' for null or anything unrecognised, because null has
 * always meant "host supplies the links" — see the Custom mode.
 */
export function modeStyle(id: string | null | undefined): ModeStyle {
  return (id && VIDEO_CATEGORIES[id]?.style) || 'video';
}

/**
 * True when the round is read off a card rather than watched.
 *
 * Names the two card styles rather than saying `!== 'video'`. The loose test
 * shipped first and was correct only while video/word/question were the whole
 * union — adding `draw` made it claim Fake Artist was a prompt round, which
 * would have sent it down the authored-pair deal it has no pairs for.
 */
export function isPromptStyle(id: string | null | undefined): boolean {
  const style = modeStyle(id);
  return style === 'word' || style === 'question';
}

/** True for the shared-canvas mode. */
export function isDrawStyle(id: string | null | undefined): boolean {
  return modeStyle(id) === 'draw';
}

/** True for the clue-and-dial mode. */
export function isSpectrumStyle(id: string | null | undefined): boolean {
  return modeStyle(id) === 'spectrum';
}

/** True for the fake-definitions mode. */
export function isBluffStyle(id: string | null | undefined): boolean {
  return modeStyle(id) === 'bluff';
}

/**
 * True when the round ends in a score rather than an accusation.
 *
 * This is the distinction the results screen branches on, and it is a property
 * of the *style*, not a list of mode ids — a second scoring mode must not have
 * to be added anywhere except here.
 */
export function isScoredStyle(id: string | null | undefined): boolean {
  const style = modeStyle(id);
  return style === 'spectrum' || style === 'bluff';
}

/** True when there is no tape to buffer, sync, play or wait for the end of. */
export function isVideoStyle(id: string | null | undefined): boolean {
  return modeStyle(id) === 'video';
}

/**
 * Can this mode run on content the host supplied instead of the pool?
 *
 * The two styles whose round is built from an authored *pair* — two clips, or
 * two cards — because that is the shape a host can type. Fake Artist, Wavelength
 * and Bluff are deliberately out: each needs something structurally different
 * (a word plus a category, a labelled scale plus a hidden point, a word plus its
 * real dictionary definition), and a half-built custom form for them would be a
 * worse answer than saying the mode does not take one yet.
 *
 * Branch on this, never on a mode id — that is what kept Fake Artist out of the
 * prompt pool it has no pairs for.
 */
export function supportsCustomContent(id: string | null | undefined): boolean {
  return isVideoStyle(id) || isPromptStyle(id);
}
