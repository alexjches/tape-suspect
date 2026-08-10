# Style prompt — Tape Suspect cast

Derived by measuring `gartic-avatars/` (47 files), not by eye:

| | |
|---|---|
| `#012442` | present in **47/47** — the one colour the whole set shares |
| `#E02D5C` | 29/47 — the default background disc |
| Colours per character | 5–19, mean **8.6** |
| Colours across the set | **198** |
| Gradients | **0/47** |
| Opacity effects | 2/47 |
| Background disc | ~93% of canvas width |

The set is colourful; each character is not. Roughly eight flat colours each,
drawn from a wide pool. Prompting for "colourful" gets you eight colours in one
character and a mess — the breadth belongs across the roster, not inside one
avatar.

---

## A. With a custom style (preferred)

When a Recraft style is built from the reference images, **the style carries the
look and the prompt should be almost entirely subject.** Over-describing the
style here fights the reference and washes it out.

```
{SUBJECT}, centred, facing forward
```

That is the whole prompt. Add at most one clause if a subject needs steering:

```
{SUBJECT}, centred, facing forward, cropped at the shoulders
{SUBJECT}, centred, facing forward, whole object, no body
```

## B. Without a custom style (text only)

If you're generating before building a style, or in a tool with no style
reference, this carries the look on its own:

```
flat vector mascot avatar of {SUBJECT}, centred, facing forward,
bold dark navy #012442 outline of even weight around every shape,
flat solid fills, no gradients, no shading, no texture,
limited palette of about eight saturated colours,
large simple eyes with small white highlights, simple friendly expression,
sitting on a solid circular colour disc filling the frame edge to edge,
plain white outside the disc,
chunky sticker illustration, clean hard edges
```

**Negative / avoid:**

```
gradient, drop shadow, soft shading, texture, grain, noise,
3D render, realistic, photorealistic,
thin lines, varying line weight, sketchy, crosshatch, pencil,
multiple characters, busy background, scene, landscape,
text, letters, watermark, signature
```

---

## Subject list

Vary the noun and nothing else. Aim for **about a third objects** rather than
creatures, and consciously vary the silhouette — the failure mode of the
existing twelve was that every one was a round head with shoulders.

> luchador wrestler · slice of watermelon · retro boombox · anglerfish ·
> astronaut helmet · traffic cone · pirate captain · mushroom with a face ·
> disco ball · hot dog · yeti · desk lamp · cactus in a pot · vampire bat ·
> rubber duck · knight helmet · octopus · lava lamp · snowman · pineapple

Generate more than you need — around 30 for a roster of 20. Rejecting is cheaper
than prompting harder.

## Knobs, in the order worth turning

1. **Silhouette.** If everything comes back as an egg, add `wide`, `tall`,
   `asymmetric`, or `spills past the edge of the disc`.
2. **Crop.** `cropped at the shoulders` for creatures, `whole object, no body`
   for props.
3. **Disc colour.** Left free it defaults to crimson. Name one
   (`on a teal disc`) if a roster is coming out monotonous.
4. **Palette.** Only if a character is coming out muddy —
   `limited palette of five flat colours`.

Do not add a colour list to the base prompt. 198 colours across the set is the
whole point, and pinning the palette collapses the roster into one look.

---

## Then

```bash
npm run avatars:ingest -- --in ./downloads --dry-run
```

Name the downloads for the subject (`01-luchador.svg`) — the filename becomes
the roster name and the order becomes `c00`, `c01`, `c02`.
