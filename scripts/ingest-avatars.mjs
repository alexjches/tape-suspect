#!/usr/bin/env node
// scripts/ingest-avatars.mjs
//
// Takes SVGs from an image generator (Recraft, Illustrator, a vectorizer) and
// turns them into roster artwork public/avatars/ can serve.
//
// Generated SVGs do not drop in as they are. Three things are always wrong:
//
//   1. The canvas. Ours is 262.2 x 299 (portrait). A generator hands you a
//      square. This is not cosmetic — Avatar.tsx sets an inline `height` and
//      leaves `width: auto`, so a square file renders visibly wider than the
//      rest of the cast, and .character-slot's positioning was tuned against
//      the portrait canvas.
//
//   2. Fills declared as CSS classes. Illustrator and most vector exporters
//      emit `<style>.st0{fill:#E02D5C}</style>` and `class="st0"` on the art.
//      Those class names are global to the *document*, so the moment two such
//      files are inlined into one page they overwrite each other's colours.
//      Our own avatars use inline fills and no <style> for exactly this reason.
//      Flattening also drops a few hundred bytes per file.
//
//   3. Ink drift. A style-matched generation lands on #012B48 where the cast
//      is #012442. Close enough to look like a mistake rather than a variant.
//
// It also emits the CHARACTERS array for src/lib/avatars.ts, because the ids
// are positional against the files on disk and hand-syncing the two is exactly
// the mistake that silently reassigns every stored avatar to a new character.
//
// Zero dependencies, on purpose: this is a build-time art tool and should not
// drag svgo or a headless browser into the repo to run once a month.
//
// Usage:
//   node scripts/ingest-avatars.mjs --in <dir> [--dry-run]
//   node scripts/ingest-avatars.mjs --in ./raw --force
//   node scripts/ingest-avatars.mjs --in ./raw --start 12      # append to the cast
//
// Order matters. Files are taken in natural filename order and that order
// becomes c00, c01, c02… Prefix them numerically (`01-luchador.svg`) if you
// care which is which; the mapping is printed before anything is written.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── The house canvas, copied from the existing cast ──────────────────────────
const TARGET_W = 262.2;
const TARGET_H = 299;
const DEFAULT_INK = '#012442';
// RGB distance under which a colour is treated as "meant to be the ink".
//
// Deliberately tight. The job is to absorb *drift* — a generator landing on
// #012B48 (distance ~8) instead of #012442 — not to collapse a designed navy
// ramp. Measured against the reference set, a threshold of 60 also swallowed
// #144060 (44) and #074966 (51), which are shading on the darker characters:
// snapping those flattens the art and looks like a rendering fault. Raise it
// with --ink-threshold if a batch genuinely drifts further; every colour that
// moves is listed in the report, so this is checkable rather than a guess.
const DEFAULT_INK_THRESHOLD = 20;

// ── Args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    in: null,
    out: 'public/avatars',
    ink: DEFAULT_INK,
    inkThreshold: DEFAULT_INK_THRESHOLD,
    scale: 1,
    start: 0,
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--in') opts.in = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--ink') opts.ink = next();
    else if (a === '--ink-threshold') opts.inkThreshold = Number(next());
    else if (a === '--scale') opts.scale = Number(next());
    else if (a === '--start') opts.start = Number(next());
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

// ── Colour ───────────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgbDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Snaps near-ink colours onto the house ink, and reports what moved.
 *
 * Deliberately only touches colours *close to* the target. An earlier instinct
 * was to snap the whole palette to a fixed list, which is wrong for this cast:
 * the reference set's fills range across purples, pinks, browns and teals, and
 * flattening that would make every character look like the same character. The
 * outline is the only colour the set genuinely shares.
 */
function snapInk(svg, ink, threshold) {
  const target = hexToRgb(ink);
  if (!target) throw new Error(`--ink is not a hex colour: ${ink}`);
  const moved = new Map();

  const out = svg.replace(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi, (match) => {
    const rgb = hexToRgb(match);
    if (!rgb) return match;
    const d = rgbDistance(rgb, target);
    if (d === 0 || d > threshold) return match;
    moved.set(match.toLowerCase(), (moved.get(match.toLowerCase()) || 0) + 1);
    return ink;
  });

  return { svg: out, moved };
}

// ── <style> flattening ───────────────────────────────────────────────────────
/**
 * Turns `<style>.st0{fill:#E02D5C}</style>` + `class="st0"` into inline
 * presentation attributes, then removes both.
 *
 * Only handles flat class selectors, which is all a vector exporter emits. A
 * descendant or attribute selector is left alone and its <style> block kept —
 * better a file that still renders than one silently stripped of its colour.
 */
function flattenStyleBlocks(svg) {
  const styleBlocks = [...svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  if (styleBlocks.length === 0) return { svg, flattened: 0, kept: 0 };

  const rules = new Map(); // class name -> { prop: value }
  let unsupported = 0;

  for (const block of styleBlocks) {
    const css = block[1];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].split(',').map((s) => s.trim()).filter(Boolean);
      const body = rule[2];
      const decls = {};
      for (const decl of body.split(';')) {
        const idx = decl.indexOf(':');
        if (idx === -1) continue;
        const prop = decl.slice(0, idx).trim();
        const value = decl.slice(idx + 1).trim();
        if (prop && value) decls[prop] = value;
      }
      for (const sel of selectors) {
        if (!/^\.[A-Za-z_][\w-]*$/.test(sel)) {
          unsupported += 1;
          continue;
        }
        const name = sel.slice(1);
        rules.set(name, { ...(rules.get(name) || {}), ...decls });
      }
    }
  }

  if (unsupported > 0) return { svg, flattened: 0, kept: unsupported };

  // Apply. A CSS class beats a presentation attribute in SVG, so where both
  // exist the class value is the one that was rendering — it wins here too.
  let flattened = 0;
  let out = svg.replace(/<([a-zA-Z][\w:-]*)((?:\s+[^>]*?)?)(\/?)>/g, (tag, name, attrs, selfClose) => {
    const classMatch = attrs.match(/\sclass\s*=\s*"([^"]*)"/i);
    if (!classMatch) return tag;
    const applied = {};
    for (const cls of classMatch[1].split(/\s+/).filter(Boolean)) {
      Object.assign(applied, rules.get(cls) || {});
    }
    let rest = attrs.replace(/\sclass\s*=\s*"[^"]*"/i, '');
    for (const [prop, value] of Object.entries(applied)) {
      rest = rest.replace(new RegExp(`\\s${prop}\\s*=\\s*"[^"]*"`, 'i'), '');
      rest += ` ${prop}="${value}"`;
    }
    if (Object.keys(applied).length > 0) flattened += 1;
    return `<${name}${rest}${selfClose}>`;
  });

  out = out.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  return { svg: out, flattened, kept: 0 };
}

// ── Canvas normalisation ─────────────────────────────────────────────────────
function parseLength(value) {
  if (!value) return null;
  const n = parseFloat(String(value).replace(/(px|pt|mm|cm|in)$/, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Rewrites the root to the house canvas, scaling and centring the source art
 * inside it.
 *
 * Fits by the source *viewBox* rather than by measuring real geometry. Computing
 * a true bounding box means resolving every path, transform and stroke, which
 * needs a browser — and a generator's output is consistent with itself, so any
 * padding it leaves is the same on every file. `--scale` is the knob for that.
 */
function normaliseCanvas(svg, scaleOpt) {
  const rootMatch = svg.match(/<svg\b([^>]*)>/i);
  if (!rootMatch) throw new Error('no <svg> root element');
  const rootAttrs = rootMatch[1];

  let vb = rootAttrs.match(/\sviewBox\s*=\s*"([^"]+)"/i);
  let minX = 0;
  let minY = 0;
  let srcW;
  let srcH;

  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`unreadable viewBox: ${vb[1]}`);
    }
    [minX, minY, srcW, srcH] = parts;
  } else {
    srcW = parseLength(rootAttrs.match(/\swidth\s*=\s*"([^"]+)"/i)?.[1]);
    srcH = parseLength(rootAttrs.match(/\sheight\s*=\s*"([^"]+)"/i)?.[1]);
    if (!srcW || !srcH) throw new Error('no viewBox and no usable width/height');
  }

  const open = svg.indexOf(rootMatch[0]) + rootMatch[0].length;
  const close = svg.lastIndexOf('</svg>');
  if (close === -1) throw new Error('unclosed <svg>');
  const body = svg.slice(open, close).trim();

  const s = Math.min(TARGET_W / srcW, TARGET_H / srcH) * scaleOpt;
  const tx = (TARGET_W - srcW * s) / 2 - minX * s;
  const ty = (TARGET_H - srcH * s) / 2 - minY * s;

  const round = (n) => Number(n.toFixed(4));
  const already =
    Math.abs(s - 1) < 1e-9 && Math.abs(tx) < 1e-9 && Math.abs(ty) < 1e-9;

  const inner = already
    ? body
    : `<g transform="translate(${round(tx)} ${round(ty)}) scale(${round(s)})">${body}</g>`;

  // The root is rebuilt from scratch to drop the exporter's width/height/version
  // /x/y noise — which means any namespace the body still relies on has to be
  // put back. Illustrator wires clip paths up as <use xlink:href="#…">, and an
  // undeclared xlink: prefix makes the <use> resolve to nothing: the clipPath
  // ends up empty, everything it clips becomes invisible, and the file renders
  // blank with no error. Two of the reference avatars did exactly that.
  const needsXlink = /\sxlink:[a-z]+\s*=/i.test(inner);
  const ns =
    'xmlns="http://www.w3.org/2000/svg"' +
    (needsXlink ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '');

  return {
    svg: `<svg ${ns} viewBox="0 0 ${TARGET_W} ${TARGET_H}">${inner}</svg>`,
    source: `${round(srcW)}x${round(srcH)}`,
    scaled: !already,
  };
}

// ── Cruft ────────────────────────────────────────────────────────────────────
/**
 * Removes exporter noise without touching anything load-bearing.
 *
 * The `id` handling is the subtle part. Illustrator emits ids on everything and
 * most are dead weight — but clip paths, masks, gradients and <use> are wired
 * together *by* id (`clip-path="url(#SVGID_2_)"`, `xlink:href="#SVGID_1_"`).
 * Stripping those breaks the reference and the art renders unclipped, with no
 * error anywhere. So collect every id the document actually points at first and
 * strip only the rest. This was a real bug caught by diffing a render.
 */
function stripCruft(svg) {
  const referenced = new Set();
  for (const m of svg.matchAll(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/gi)) {
    referenced.add(m[1]);
  }
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*"#([^"]+)"/gi)) {
    referenced.add(m[1]);
  }
  // begin="a.end", attributeName targets and other SMIL/anim references would
  // also matter, but a vector exporter emits none of them.

  return svg
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(/<desc[\s\S]*?<\/desc>/gi, '')
    .replace(/\sid\s*=\s*"([^"]*)"/gi, (match, id) => (referenced.has(id) ? match : ''))
    .replace(/\s(?:data-name|xml:space|enable-background)\s*=\s*"[^"]*"/gi, '')
    .replace(/>\s+</g, '><')
    .trim();
}

/**
 * Prefixes every surviving id (and every reference to it) with the output id,
 * so `SVGID_2_` becomes `c07-SVGID_2_`.
 *
 * Exporters number ids per *file*, so every one of them calls its first clip
 * path SVGID_1_. Inline two such files into one page and `url(#SVGID_2_)`
 * resolves to whichever came first — the second character gets the first one's
 * clip and loses most of its art. Same failure mode as the class names above,
 * one level down.
 *
 * Avatar.tsx renders an <img>, which makes each file its own document and
 * immune to this. Doing it anyway costs nothing and means the files stay safe
 * to inline — for a sprite sheet, an OG image, or anything else later.
 */
function namespaceIds(svg, prefix) {
  const defined = new Set();
  for (const m of svg.matchAll(/\sid\s*=\s*"([^"]+)"/gi)) defined.add(m[1]);
  if (defined.size === 0) return svg;

  let out = svg.replace(/(\sid\s*=\s*")([^"]+)(")/gi, (_, a, id, b) => `${a}${prefix}-${id}${b}`);
  out = out.replace(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/gi, (match, id) =>
    defined.has(id) ? `url(#${prefix}-${id})` : match
  );
  out = out.replace(/((?:xlink:)?href\s*=\s*")#([^"]+)(")/gi, (match, a, id, b) =>
    defined.has(id) ? `${a}#${prefix}-${id}${b}` : match
  );
  return out;
}

// ── Naming ───────────────────────────────────────────────────────────────────
/** `03-luchador-mask.svg` -> `Luchador Mask`. The name is alt text, nothing more. */
function displayName(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/^[\d._-]+/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ') || 'Character';
}

/** Natural order, so `avatar-2` sorts before `avatar-10`. */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

const pad2 = (n) => String(n).padStart(2, '0');

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.in) {
    console.log(`
Ingest generated SVGs into the avatar roster.

  --in <dir>            source SVGs                              (required)
  --out <dir>           destination                              (public/avatars)
  --ink <hex>           outline colour to snap towards           (${DEFAULT_INK})
  --ink-threshold <n>   RGB distance counted as "near ink"       (${DEFAULT_INK_THRESHOLD})
  --scale <n>           uniform scale inside the canvas          (1)
  --start <n>           first index, for appending to the cast   (0)
  --dry-run             report, write nothing
  --force               allow overwriting existing files

Files are taken in natural filename order, and that order becomes c00, c01, …
`);
    process.exit(opts.in ? 0 : 1);
  }

  if (!Number.isFinite(opts.scale) || opts.scale <= 0) {
    console.error('--scale must be a positive number');
    process.exit(1);
  }
  if (!Number.isInteger(opts.start) || opts.start < 0) {
    console.error('--start must be a non-negative integer');
    process.exit(1);
  }
  if (!fs.existsSync(opts.in)) {
    console.error(`Input directory not found: ${opts.in}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(opts.in)
    .filter((f) => f.toLowerCase().endsWith('.svg'))
    .sort(naturalCompare);

  if (files.length === 0) {
    console.error(`No .svg files in ${opts.in}`);
    process.exit(1);
  }

  console.log(`\nReading ${files.length} SVG${files.length === 1 ? '' : 's'} from ${opts.in}\n`);

  const results = [];
  const failures = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const id = `c${pad2(opts.start + i)}`;
    try {
      let svg = fs.readFileSync(path.join(opts.in, file), 'utf8');
      const beforeBytes = Buffer.byteLength(svg);

      svg = stripCruft(svg);
      svg = namespaceIds(svg, id);
      const flat = flattenStyleBlocks(svg);
      svg = flat.svg;
      const inked = snapInk(svg, opts.ink, opts.inkThreshold);
      svg = inked.svg;
      const canvas = normaliseCanvas(svg, opts.scale);
      svg = canvas.svg;

      results.push({
        id,
        file,
        name: displayName(file),
        svg,
        beforeBytes,
        afterBytes: Buffer.byteLength(svg),
        flattened: flat.flattened,
        keptStyle: flat.kept,
        inkMoved: [...inked.moved.keys()],
        source: canvas.source,
        scaled: canvas.scaled,
      });
    } catch (err) {
      failures.push({ file, message: err.message });
    }
  }

  // ── Report ──
  const fw = Math.max(...results.map((r) => r.file.length), 4) + 2;
  const sw = Math.max(...results.map((r) => r.source.length), 6) + 2;
  console.log(`  ${'id'.padEnd(5)}${'source'.padEnd(sw)}${'file'.padEnd(fw)}name`);
  console.log(`  ${'─'.repeat(5 + sw + fw + 12)}`);
  for (const r of results) {
    console.log(`  ${r.id.padEnd(5)}${r.source.padEnd(sw)}${r.file.padEnd(fw)}${r.name}`);
  }

  const totalFlat = results.reduce((n, r) => n + r.flattened, 0);
  const inkFiles = results.filter((r) => r.inkMoved.length > 0);
  const allInk = [...new Set(inkFiles.flatMap((r) => r.inkMoved))];
  const scaledCount = results.filter((r) => r.scaled).length;
  const before = results.reduce((n, r) => n + r.beforeBytes, 0);
  const after = results.reduce((n, r) => n + r.afterBytes, 0);

  console.log('');
  console.log(`  canvas    ${scaledCount}/${results.length} rescaled onto ${TARGET_W}x${TARGET_H}`);
  console.log(`  styles    ${totalFlat} element${totalFlat === 1 ? '' : 's'} had class fills inlined`);
  console.log(
    `  ink       ${inkFiles.length} file${inkFiles.length === 1 ? '' : 's'} snapped to ${opts.ink}` +
      (allInk.length ? ` (from ${allInk.join(', ')})` : '')
  );
  console.log(`  size      ${(before / 1024).toFixed(1)}KB -> ${(after / 1024).toFixed(1)}KB`);

  const keptStyle = results.filter((r) => r.keptStyle > 0);
  if (keptStyle.length > 0) {
    console.log('');
    console.log(`  ! ${keptStyle.length} file(s) use CSS selectors too complex to flatten;`);
    console.log('    their <style> blocks were left intact. Inlining several of these');
    console.log('    into one document will make their class names collide.');
    for (const r of keptStyle) console.log(`      ${r.file}`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log(`  ! ${failures.length} file(s) could not be processed:`);
    for (const f of failures) console.log(`      ${f.file}: ${f.message}`);
  }

  // ── Write ──
  const outDir = path.resolve(opts.out);
  const clashes = results.filter((r) => fs.existsSync(path.join(outDir, `${r.id}.svg`)));

  if (opts.dryRun) {
    console.log(`\n  dry run — nothing written. ${clashes.length} file(s) would be overwritten.\n`);
  } else {
    if (clashes.length > 0 && !opts.force) {
      console.error(
        `\n  ${clashes.length} file(s) already exist in ${opts.out} ` +
          `(${clashes.map((c) => c.id).join(', ')}).\n` +
          '  Re-run with --force to overwrite, or --start to append instead.\n'
      );
      process.exit(1);
    }
    fs.mkdirSync(outDir, { recursive: true });
    for (const r of results) {
      fs.writeFileSync(path.join(outDir, `${r.id}.svg`), r.svg, 'utf8');
    }
    console.log(`\n  wrote ${results.length} file(s) to ${opts.out}\n`);
  }

  // ── The roster ──
  // Printed rather than written: src/lib/avatars.ts carries documentation and
  // helpers around this array, and rewriting the module from a script is how
  // that gets lost.
  console.log('  Paste into src/lib/avatars.ts (ids are positional — see the note there):\n');
  console.log('export const CHARACTERS: Character[] = [');
  for (const r of results) {
    console.log(`  { id: '${r.id}', name: '${r.name.replace(/'/g, "\\'")}' },`);
  }
  console.log('];\n');

  if (opts.start > 0) {
    console.log(
      `  Appending from ${results[0].id} — keep the existing entries above these,\n` +
        '  in their current order.\n'
    );
  } else if (!opts.dryRun) {
    console.log(
      '  Roster length changed? characterFor() resolves legacy avatar codes with\n' +
        '  hash % CHARACTERS.length, so pre-existing emoji/part-code accounts will\n' +
        '  land on a different character than before. Nothing breaks; those players\n' +
        '  see their face change once.\n'
    );
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main();
