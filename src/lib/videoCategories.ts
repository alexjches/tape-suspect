// src/lib/videoCategories.ts
// Genre metadata — the display side of the genre list in docs/BUILD-PLAN.md
// section 4. Client-safe: no filesystem access, no video IDs.
//
// The clips themselves live in /content/videos.json and are loaded server-side
// by src/server/videoLibrary.ts. Keeping the two apart is deliberate: the pool
// is what the imposter is picked out of, so it must never reach a browser
// bundle, and the config file stays editable without touching game logic
// (section 14).

/** Marks the host-supplied-links genre. Has no pool in videos.json. */
export const CUSTOM_CATEGORY = 'custom';

export interface VideoCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** True for the one genre whose links come from the host, not the config. */
  isCustom?: boolean;
}

// Order follows section 4: Sports, Memes, Video Games, Music, Custom.
export const VIDEO_CATEGORIES: Record<string, VideoCategory> = {
  sports: {
    id: 'sports',
    name: 'Sports',
    icon: '🏆',
    description: 'Goals, dunks and iconic sporting moments',
  },
  memes: {
    id: 'memes',
    name: 'Memes',
    icon: '😂',
    description: 'Viral clips and internet classics',
  },
  video_games: {
    id: 'video_games',
    name: 'Video Games',
    icon: '🎮',
    description: 'Trailers and reveals from big-name games',
  },
  music: {
    id: 'music',
    name: 'Music Videos',
    icon: '🎵',
    description: 'Hit songs and music clips',
  },
  [CUSTOM_CATEGORY]: {
    id: CUSTOM_CATEGORY,
    name: 'Custom URL',
    icon: '⚙️',
    description: 'Host pastes their own pair of links for the round',
    isCustom: true,
  },
};

/** The genres backed by a pool in /content/videos.json. */
export const POOL_CATEGORY_IDS = Object.values(VIDEO_CATEGORIES)
  .filter((c) => !c.isCustom)
  .map((c) => c.id);

export function isKnownCategory(id: string | null | undefined): boolean {
  return !!id && id in VIDEO_CATEGORIES;
}
