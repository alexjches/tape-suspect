// src/components/vhs/Avatar.tsx
// Draws a roster character. The one place an avatar becomes pixels.

import { avatarSrc, characterFor } from '@/lib/avatars';

export function Avatar({
  code,
  size = 32,
  className,
  style,
}: {
  /** A roster id, or any legacy value — resolving never throws. */
  code: string | null | undefined;
  /** Rendered height in px. The art is square, so this is both dimensions. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const character = characterFor(code);
  return (
    // A plain <img> rather than next/image: the art is static, identical
    // between players who share a character, and served straight from
    // public/ — letting the browser cache one file per character beats
    // routing three fixed assets through the optimiser.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarSrc(code)}
      alt={character.name}
      width={size}
      height={size}
      className={className}
      style={{
        display: 'block',
        height: size,
        // The art is a 320px square with the background knocked out to alpha,
        // so `auto` and `size` agree — but it stays auto so a future
        // non-square character is letterboxed rather than squashed.
        width: 'auto',
        // Tailwind's preflight puts `max-width: 100%` on every img, which
        // silently overrides `width: auto` whenever the slot is narrower than
        // `size` — the height still obeys the inline style, so the character
        // comes out horizontally squashed rather than merely small. It never
        // fired while the art was 262×299 (at size 46 that is 40px wide, and
        // .player-avatar-circle is 42), and fired on every console the moment
        // the art became square. `size` is the one thing that decides how big
        // an avatar is; nothing in a slot's own box may override it.
        maxWidth: 'none',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
