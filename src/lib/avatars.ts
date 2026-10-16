// src/lib/avatars.ts
// The character roster.
//
// These are individually illustrated characters, not a composer. An earlier
// version built an avatar from five interchangeable slots (body, eyes, mouth,
// accessory, colour), which cannot express art like this: a cassette, a cactus
// and an eyeball share no parts. Trading procedural combinations for designed
// ones is the whole point — a fixed cast is what Gartic Phone does.
//
// The artwork is illustrated externally and brought in through
// scripts/ingest-avatars.mjs, which knocks the white background out to alpha
// and downscales to 320px. Edit the art at the source and re-run that script,
// never here — this file only names what is on disk.
//
// An id is its filename, which is deliberately not the positional `cNN` scheme
// this replaced. Under that scheme reordering the cast reassigned every stored
// avatar to a different character; under this one a rename orphans its own id
// and nothing else, and an orphan resolves through characterFor() anyway.
//
// Served statically rather than inlined: the browser caches one file per
// character, instead of every player downloading the whole set in the JS
// bundle whether they ever see those characters or not.
//
// This module stays client-safe: the signup page, the lobby and the results
// grid all draw characters, and lib/auth.ts + authAdapter.ts need
// randomAvatar() on the server. No server-only imports.

export interface Character {
  /** Also the avatar code stored in User.avatar and sent over the socket. */
  id: string;
  /** Used as alt text; the only place a character is named to a player. */
  name: string;
}

// Each id must match a file in public/avatars/ exactly. The ingest script
// prints this array so the two cannot be hand-synced apart.
export const CHARACTERS: Character[] = [
  { id: 'cactus', name: 'Cactus' },
  { id: 'dragon', name: 'Dragon' },
  { id: 'lion-king', name: 'Lion King' },
  { id: 'ninja', name: 'Ninja' },
  { id: 'penguin-pilot', name: 'Penguin Pilot' },
  { id: 'penguin', name: 'Penguin' },
  { id: 'pirate', name: 'Pirate' },
  { id: 'robot', name: 'Robot' },
];

/**
 * The character rendered before an effect has dealt a real one.
 *
 * Five screens need this and every one of them is prerendered, so it has to be
 * a fixed value: Math.random() in a useState initialiser bakes one character
 * into the static HTML and picks another at hydration. It lives here rather
 * than as a literal in each of those files because it has to be a *valid*
 * roster id, and a stale copy fails silently — characterFor() hashes it to
 * some other character instead of throwing.
 */
export const FIRST_FRAME_AVATAR = CHARACTERS[0].id;

const BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));

/** True only for a character in the roster — used to vet client input. */
export function isAllowedAvatar(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value);
}

/**
 * Stable 32-bit hash, so anything that isn't a roster id resolves to a
 * *deterministic* character rather than a new one on every render.
 *
 * Three generations of stored avatars go through here: the emoji that accounts
 * and guests held before characters existed, the `a70312` part-codes from the
 * composer that replaced those, and the `cNN` ids of the illustrated cast that
 * replaced *those*. Deriving rather than migrating keeps every one of them
 * recognisable — the same input always lands on the same character — and means
 * no database backfill has ever been needed.
 */
function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Never throws. Anything unrecognised maps to a stable roster character. */
export function characterFor(value: string | null | undefined): Character {
  if (isAllowedAvatar(value)) return BY_ID.get(value)!;
  return CHARACTERS[hashString(value || 'anonymous') % CHARACTERS.length];
}

/** A roster id for anything at all — pass-through if it already is one. */
export function toAvatarCode(value: string | null | undefined): string {
  return characterFor(value).id;
}

export function randomAvatar(): string {
  return CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id;
}

/** The next character in the roster — what the reroll button steps through. */
export function nextAvatar(value: string | null | undefined): string {
  const i = CHARACTERS.findIndex((c) => c.id === characterFor(value).id);
  return CHARACTERS[(i + 1) % CHARACTERS.length].id;
}

/** Static path to a character's artwork. */
export function avatarSrc(value: string | null | undefined): string {
  return `/avatars/${characterFor(value).id}.png`;
}
