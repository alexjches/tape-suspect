// src/lib/cosmetics.ts
// The cosmetic catalogue (spec section 10) plus the helpers that turn an
// equipped loadout into styles.
//
// Deliberately a plain module, not part of useShop: the socket server has to
// validate incoming cosmetic ids, and it must not have to import a React hook
// to do it. useShop re-exports the catalogue so existing callers are unchanged.

import type {
  CosmeticCategory,
  CosmeticPalette,
  CosmeticSticker,
  EquippedCosmetics,
  ShopItem,
} from '@/types';

export const COSMETIC_CATEGORIES: { id: CosmeticCategory; icon: string; label: string }[] = [
  { id: 'tape-skin', icon: '📼', label: 'VHS TAPE SKINS' },
  { id: 'vcr-skin', icon: '📟', label: 'VCR PLAYER SKINS' },
  { id: 'tape-label', icon: '🏷️', label: 'TAPE LABELS' },
];

// Catalogue and prices ported from vhs-frontend-example/home.html.
export const SHOP_ITEMS: ShopItem[] = [
  // ── VHS tape skins ────────────────────────────────────────────────
  {
    id: 'tape-neon-noir',
    name: 'Neon Noir',
    category: 'tape-skin',
    price: 150,
    tag: 'NEON NOIR',
    title: 'NEON NOIR',
    subLeft: 'LIMITED',
    subRight: '● SP',
    palette: {
      body: '#0a0a12', border: '#ff0077', tagBg: '#ff0077', tagColor: '#fff',
      labelBg: 'linear-gradient(135deg, #1a0020, #0a0018)', labelBorder: '#ff0077',
      titleColor: '#ff0077', subColor: '#aa0055',
      innerBg: '#05050a', accentDark: '#1a001a', accentBright: '#ff0077',
    },
  },
  {
    id: 'tape-retro-sunset',
    name: 'Retro Sunset',
    category: 'tape-skin',
    price: 200,
    tag: 'RETRO SUNSET',
    title: 'RETRO SUNSET',
    subLeft: 'RARE',
    subRight: '● HQ',
    palette: {
      body: '#2b1800', border: '#ff8800', tagBg: '#ff8800', tagColor: '#000',
      labelBg: 'linear-gradient(135deg, #ff8800, #ff4400)', labelBorder: '#000',
      titleColor: '#fff', subColor: '#ffe0b0',
      innerBg: '#1a0a00', accentDark: '#3d1e00', accentBright: '#ffaa33',
    },
  },
  {
    id: 'tape-glitch-core',
    name: 'Glitch Core',
    category: 'tape-skin',
    price: 175,
    tag: 'GLITCH CORE',
    title: 'GL1TCH_C0RE',
    subLeft: 'ERR0R',
    subRight: '● 404',
    palette: {
      body: '#0d0d1a', border: '#00f0ff', tagBg: '#00f0ff', tagColor: '#000',
      labelBg: 'linear-gradient(135deg, #001a22, #002233)', labelBorder: '#00f0ff',
      titleColor: '#00f0ff', subColor: '#00aabb',
      innerBg: '#000a0d', accentDark: '#001a22', accentBright: '#00f0ff',
    },
  },
  {
    id: 'tape-pastel-wave',
    name: 'Pastel Wave',
    category: 'tape-skin',
    price: 125,
    tag: 'PASTEL WAVE',
    title: 'PASTEL WAVE',
    subLeft: 'DREAMY',
    subRight: '● LP',
    palette: {
      body: '#2a1e3a', border: '#cc88ff', tagBg: '#cc88ff', tagColor: '#1a0033',
      labelBg: 'linear-gradient(135deg, #eeddff, #ffddee)', labelBorder: '#aa66dd',
      titleColor: '#6633aa', subColor: '#9966cc',
      innerBg: '#1a0d2a', accentDark: '#331155', accentBright: '#cc88ff',
    },
  },
  {
    id: 'tape-toxic-waste',
    name: 'Toxic Waste',
    category: 'tape-skin',
    price: 100,
    tag: 'TOXIC WASTE',
    title: 'TOX1C_WASTE',
    subLeft: '☢ HAZARD',
    subRight: '● EP',
    palette: {
      body: '#0a1a0a', border: '#00ff66', tagBg: '#00ff66', tagColor: '#000',
      labelBg: 'linear-gradient(135deg, #001a00, #003300)', labelBorder: '#00ff66',
      titleColor: '#00ff66', subColor: '#00aa44',
      innerBg: '#001100', accentDark: '#002200', accentBright: '#00ff66',
    },
  },
  {
    id: 'tape-gold-standard',
    name: 'Gold Standard',
    category: 'tape-skin',
    price: 200,
    tag: 'GOLD STANDARD',
    title: 'GOLD STANDARD',
    subLeft: '★ PREMIUM',
    subRight: '● HI-FI',
    palette: {
      body: '#1a1500', border: '#ffd700', tagBg: '#ffd700', tagColor: '#000',
      labelBg: 'linear-gradient(135deg, #ffd700, #ffaa00)', labelBorder: '#000',
      titleColor: '#1a1000', subColor: '#8a7000',
      innerBg: '#0d0a00', accentDark: '#332b00', accentBright: '#ffd700',
    },
  },

  // ── VCR player skins ──────────────────────────────────────────────
  {
    id: 'vcr-midnight-chrome',
    name: 'Midnight Chrome',
    category: 'vcr-skin',
    price: 250,
    tag: 'MIDNIGHT',
    title: 'MIDNIGHT CHROME',
    subLeft: 'CH. ∞',
    subRight: '● PREMIUM',
    palette: {
      body: 'linear-gradient(180deg, #1a1a2e 0%, #0a0a16 100%)', border: '#8888ff',
      tagBg: '#8888ff', tagColor: '#000',
      labelBg: '#0b0b10', labelBorder: '#8888ff',
      titleColor: '#8888ff', subColor: '#6666cc',
      innerBg: 'linear-gradient(180deg, #1a1a2e 0%, #0d0d18 100%)',
      accentDark: '#4444aa', accentBright: '#8888ff',
    },
  },
  {
    id: 'vcr-arctic-frost',
    name: 'Arctic Frost',
    category: 'vcr-skin',
    price: 200,
    tag: 'ARCTIC',
    title: 'ARCTIC FROST',
    subLeft: 'CH. ❄',
    subRight: '● COOL',
    palette: {
      body: 'linear-gradient(180deg, #c8d8e8 0%, #8899aa 100%)', border: '#ddeeff',
      tagBg: '#ddeeff', tagColor: '#223344',
      labelBg: '#1a2a3a', labelBorder: '#aabbcc',
      titleColor: '#88ddff', subColor: '#66bbdd',
      innerBg: 'linear-gradient(180deg, #aabbcc 0%, #8899aa 100%)',
      accentDark: '#667788', accentBright: '#88ddff',
    },
  },
  {
    id: 'vcr-magma-deck',
    name: 'Magma Deck',
    category: 'vcr-skin',
    price: 300,
    tag: 'MAGMA',
    title: 'MAGMA DECK',
    subLeft: 'CH. 🔥',
    subRight: '● HOT',
    palette: {
      body: 'linear-gradient(180deg, #3a1010 0%, #1a0505 100%)', border: '#ff3300',
      tagBg: '#ff3300', tagColor: '#fff',
      labelBg: '#1a0505', labelBorder: '#ff3300',
      titleColor: '#ff6633', subColor: '#ff4411',
      innerBg: 'linear-gradient(180deg, #2a0808 0%, #1a0404 100%)',
      accentDark: '#661100', accentBright: '#ff3300',
    },
  },
  {
    id: 'vcr-cyber-punk',
    name: 'Cyber Punk',
    category: 'vcr-skin',
    price: 275,
    tag: 'CYBER',
    title: 'CYBER PUNK',
    subLeft: 'CH. ⚡',
    subRight: '● WIRED',
    palette: {
      body: 'linear-gradient(180deg, #1a0028 0%, #0d0016 100%)', border: '#ff00ff',
      tagBg: 'linear-gradient(90deg, #ff00ff, #00f0ff)', tagColor: '#000',
      labelBg: '#0d0016', labelBorder: '#ff00ff',
      titleColor: '#ff00ff', subColor: '#cc00cc',
      innerBg: 'linear-gradient(180deg, #1a0028 0%, #0d0016 100%)',
      accentDark: '#660066', accentBright: '#ff00ff',
    },
  },
  {
    id: 'vcr-military-ops',
    name: 'Military OPS',
    category: 'vcr-skin',
    price: 150,
    tag: 'MIL-OPS',
    title: 'MILITARY OPS',
    subLeft: 'CH. ★',
    subRight: '● TACTICAL',
    palette: {
      body: 'linear-gradient(180deg, #2a2a1a 0%, #1a1a0d 100%)', border: '#8a8a4a',
      tagBg: '#8a8a4a', tagColor: '#000',
      labelBg: '#0d0d08', labelBorder: '#6a6a3a',
      titleColor: '#aaaa66', subColor: '#888844',
      innerBg: 'linear-gradient(180deg, #22220e 0%, #16160a 100%)',
      accentDark: '#4a4a2a', accentBright: '#aaaa66',
    },
  },
  {
    id: 'vcr-vaporwave',
    name: 'Vaporwave',
    category: 'vcr-skin',
    price: 225,
    tag: 'VAPOR',
    title: 'V A P O R W A V E',
    subLeft: 'CH. 夢',
    subRight: '● AESTHETIC',
    palette: {
      body: 'linear-gradient(180deg, #2a1838 0%, #14081e 100%)', border: '#ee77ff',
      tagBg: 'linear-gradient(90deg, #ee77ff, #77eeff)', tagColor: '#000',
      labelBg: '#14081e', labelBorder: '#cc55dd',
      titleColor: '#ee77ff', subColor: '#cc55dd',
      innerBg: 'linear-gradient(180deg, #1e0e2a 0%, #140820 100%)',
      accentDark: '#882299', accentBright: '#ee77ff',
    },
  },

  // ── Tape labels ───────────────────────────────────────────────────
  {
    id: 'label-classified',
    name: 'Classified',
    category: 'tape-label',
    price: 75,
    tag: 'CLASSIFIED',
    title: 'CLASSIFIED',
    subLeft: '',
    subRight: '',
    sticker: {
      bg: '#ff3333', color: '#fff', border: '#aa0000',
      text: '⛔ CLASSIFIED', sub: 'SECURITY CLEARANCE REQUIRED',
    },
  },
  {
    id: 'label-top-secret',
    name: 'Top Secret',
    category: 'tape-label',
    price: 100,
    tag: 'TOP SECRET',
    title: 'TOP SECRET',
    subLeft: '',
    subRight: '',
    sticker: {
      bg: '#000', color: '#ff0000', border: '#ff0000',
      text: '🔒 TOP SECRET', sub: 'EYES ONLY — DO NOT DUPLICATE',
    },
  },
  {
    id: 'label-home-video',
    name: 'Home Video',
    category: 'tape-label',
    price: 50,
    tag: 'HOME VIDEO',
    title: 'HOME VIDEO',
    subLeft: '',
    subRight: '',
    sticker: {
      bg: '#fff8e0', color: '#5a4a00', border: '#ccaa00',
      text: '🏠 HOME VIDEO', sub: 'FAMILY MEMORIES — DO NOT ERASE',
    },
  },
  {
    id: 'label-directors-cut',
    name: "Director's Cut",
    category: 'tape-label',
    price: 100,
    tag: 'DIRECTORS CUT',
    title: "DIRECTOR'S CUT",
    subLeft: '',
    subRight: '',
    sticker: {
      bg: 'linear-gradient(135deg, #ffd700, #ff8800)', color: '#000', border: '#cc7700',
      text: "🎬 DIRECTOR'S CUT", sub: 'UNRATED — EXTENDED EDITION',
    },
  },
  {
    id: 'label-evidence',
    name: 'Evidence',
    category: 'tape-label',
    price: 75,
    tag: 'EVIDENCE',
    title: 'EVIDENCE',
    subLeft: '',
    subRight: '',
    sticker: {
      bg: '#1a1a2e', color: '#00f0ff', border: '#00f0ff',
      text: '🔍 EVIDENCE', sub: 'CASE FILE #VHS-0042',
    },
  },
  {
    id: 'label-bootleg',
    name: 'Bootleg',
    category: 'tape-label',
    price: 50,
    tag: 'BOOTLEG',
    title: 'BOOTLEG',
    subLeft: '',
    subRight: '',
    sticker: {
      bg: '#222', color: '#00ff66', border: '#00ff66',
      text: '💀 BOOTLEG', sub: 'UNOFFICIAL COPY — NOT FOR RESALE',
    },
  },
];

export const EMPTY_EQUIPPED: EquippedCosmetics = {
  'tape-skin': null,
  'vcr-skin': null,
  'tape-label': null,
};

export function getShopItem(id: string | null | undefined): ShopItem | null {
  if (!id) return null;
  return SHOP_ITEMS.find((i) => i.id === id) ?? null;
}

/**
 * Trusts nothing from the wire: keeps only ids that exist in the catalogue
 * AND belong in the slot they were sent for. Cosmetics are broadcast to every
 * player, so a junk id would otherwise ride along into everyone's markup.
 */
export function sanitizeCosmetics(input: unknown): EquippedCosmetics {
  const out: EquippedCosmetics = { ...EMPTY_EQUIPPED };
  if (!input || typeof input !== 'object') return out;
  for (const slot of Object.keys(out) as CosmeticCategory[]) {
    const id = (input as Record<string, unknown>)[slot];
    if (typeof id !== 'string') continue;
    const item = getShopItem(id);
    if (item && item.category === slot) out[slot] = id;
  }
  return out;
}

/** The palette for one skin slot, or null for the stock look. */
export function equippedPalette(
  cosmetics: EquippedCosmetics | null | undefined,
  slot: 'tape-skin' | 'vcr-skin'
): CosmeticPalette | null {
  return getShopItem(cosmetics?.[slot])?.palette ?? null;
}

/** The tape-label sticker, or null if none is equipped. */
export function equippedSticker(
  cosmetics: EquippedCosmetics | null | undefined
): CosmeticSticker | null {
  return getShopItem(cosmetics?.['tape-label'])?.sticker ?? null;
}

// ─── In-game rendering ───────────────────────────────────────────────────────
// The shop previews (components/shop/CosmeticPreview.tsx) paint a `.vhs-player`
// and a `.vhs-tape` from a palette; these produce the same styles for the real
// consoles and cassettes, so what you bought is what you get.

/**
 * Repaints a `.vhs-player` console. `fallbackAccent` is the seat's channel
 * colour, used for the border when no skin is equipped so an unskinned player
 * keeps the colour they have everywhere else.
 */
export function vcrSkinStyles(
  cosmetics: EquippedCosmetics | null | undefined,
  fallbackAccent: string
) {
  const p = equippedPalette(cosmetics, 'vcr-skin');
  if (!p) {
    return {
      shell: { borderColor: fallbackAccent, boxShadow: `4px 4px 0px ${fallbackAccent}` },
      tag: { backgroundColor: fallbackAccent, color: '#000' },
      display: undefined,
      displayText: undefined,
      status: undefined,
      slot: undefined,
      flap: undefined,
      led: undefined,
      button: undefined,
    };
  }
  return {
    shell: {
      backgroundImage: p.body,
      borderColor: p.border,
      boxShadow: `4px 4px 0px ${p.border}`,
    },
    tag: { backgroundColor: p.tagBg, color: p.tagColor },
    display: { background: p.labelBg, borderColor: p.labelBorder },
    displayText: { color: p.titleColor, textShadow: `0 0 4px ${p.titleColor}` },
    status: { color: p.subColor },
    slot: { borderColor: p.accentDark },
    flap: { background: p.innerBg, borderColor: p.accentDark },
    led: { backgroundColor: p.accentBright, boxShadow: `0 0 6px ${p.accentBright}` },
    button: { background: p.accentDark },
  };
}

/** Repaints a `.vhs-tape` cassette. Returns null for the stock look. */
export function tapeSkinStyles(cosmetics: EquippedCosmetics | null | undefined) {
  const p = equippedPalette(cosmetics, 'tape-skin');
  if (!p) return null;
  return {
    shell: { background: p.body, borderColor: p.border, boxShadow: `4px 4px 0px ${p.border}` },
    tag: { background: p.tagBg, color: p.tagColor },
    label: { background: p.labelBg, borderColor: p.labelBorder },
    title: { color: p.titleColor },
    sub: { color: p.subColor },
    window: { background: p.innerBg, borderColor: p.border },
    spool: { background: p.accentDark, borderColor: p.border },
    gear: { background: p.accentBright },
  };
}
