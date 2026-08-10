// src/lib/avatars.ts
// The character roster.
//
// These are individually illustrated characters, not a composer. An earlier
// version built an avatar from five interchangeable slots (body, eyes, mouth,
// accessory, colour), which cannot express art like this: a cassette, a cactus
// and an eyeball share no parts. Trading procedural combinations for designed
// ones is the whole point — a fixed cast is what Gartic Phone does.
//
// The artwork is authored by scripts/generate-characters.mjs and emitted to
// public/avatars/. Edit the art there, never here — this file only names what
// that script produced, and the ids are positional against its CAST array, so
// reordering the cast silently reassigns everyone's character.
//
// Served statically rather than inlined: the browser caches one small file per
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

// Ids must stay aligned with the emit order in scripts/generate-characters.mjs
// — that script writes public/avatars/c00.svg upward from its CAST array.
export const CHARACTERS: Character[] = [
  { id: 'c00', name: 'Cassette' },
  { id: 'c01', name: 'Television' },
  { id: 'c02', name: 'Ghost' },
  { id: 'c03', name: 'Robot' },
  { id: 'c04', name: 'Alien' },
  { id: 'c05', name: 'Cat' },
  { id: 'c06', name: 'Frog' },
  { id: 'c07', name: 'Slime' },
  { id: 'c08', name: 'Skull' },
  { id: 'c09', name: 'Bat' },
  { id: 'c10', name: 'Cactus' },
  { id: 'c11', name: 'Eyeball' },
];

const BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));

/** True only for a character in the roster — used to vet client input. */
export function isAllowedAvatar(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value);
}

/**
 * Stable 32-bit hash, so anything that isn't a roster id resolves to a
 * *deterministic* character rather than a new one on every render.
 *
 * Two generations of stored avatars go through here: the emoji that accounts
 * and guests held before characters existed, and the `a70312` part-codes from
 * the composer that this file replaced. Deriving rather than migrating keeps
 * both recognisable — the same input always lands on the same character — and
 * means no database backfill was needed.
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
  return `/avatars/${characterFor(value).id}.svg`;
}
