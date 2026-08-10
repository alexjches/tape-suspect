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
  /** Rendered height in px. The art is 262×299, so width follows from it. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const character = characterFor(code);
  return (
    // A plain <img> rather than inline SVG: the art is static, identical
    // between players who share a character, and ~11KB each — letting the
    // browser cache one file per character beats re-serialising it into
    // every room payload and every render.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarSrc(code)}
      alt={character.name}
      height={size}
      className={className}
      style={{
        display: 'block',
        height: size,
        // 262 × 299 — never stretch it to a square.
        width: 'auto',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
