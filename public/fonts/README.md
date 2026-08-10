# public/fonts

## `emoji-reactions.woff2`

A **five-glyph subset of Noto Color Emoji**, covering exactly the reaction set
in `src/lib/../types/index.ts` → `REACTION_EMOJI`:

| glyph | codepoint |
|---|---|
| 😂 | U+1F602 |
| 😮 | U+1F62E |
| 😢 | U+1F622 |
| 🔥 | U+1F525 |
| 👀 | U+1F440 |

3 KB. The full family is ~2 MB across its `unicode-range` slices, and the
slice our emoji fall in is 100–700 KB on its own — subsetting to the five we
actually use is the difference between a rounding error and a real download
on a phone.

### Why this exists

The reaction UI asks for **Apple Color Emoji first** (see `--font-emoji` in
`globals.css`), so iPhone, iPad and Mac render Apple's own artwork — which is
most of the audience for a phone party game. Apple Color Emoji is proprietary
and licensed for use on Apple hardware only, so it can be *requested* but
never redistributed. This file is what Windows, Android and Linux get instead:
one consistent rounded colour set, rather than falling through to Segoe UI
Emoji's flatter glyphs on one machine and something else on the next.

It is **not** Apple's artwork and does not pretend to be.

### Regenerating it

The subset is keyed to those five codepoints. **If `REACTION_EMOJI` changes,
this file must be regenerated** — a new emoji is not in the subset, so it
silently falls back to the platform font and looks out of place next to the
others. Nothing will error.

```bash
# URL-encode the emoji set into the `text` parameter:
curl -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' \
  'https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&text=%F0%9F%98%82%F0%9F%98%AE%F0%9F%98%A2%F0%9F%94%A5%F0%9F%91%80'
# then download the woff2 the returned @font-face points at, and update the
# unicode-range in globals.css to match.
```

### Licence

Noto Color Emoji is licensed under the **SIL Open Font License 1.1**, which
permits redistribution and modification (subsetting) provided the licence
travels with it — see `OFL.txt` in this directory.

Copyright 2013 Google Inc. All Rights Reserved.
