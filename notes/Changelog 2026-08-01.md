---
title: Changelog 2026-08-01
date: 2026-08-01
tags:
  - project/imposter
  - changelog
---

# Changelog — 2026-08-01

Ten commits, `b089496` → `8dddeeb`. The [[Phase 2 Scope]] items have their own
table there; this covers the rest, which came in as direct requests rather than
off the plan.

## Game feel

- **Tape insertion + power-on restored** (`91be3c6`). `GameScreen` runs the
  prototype's `startWatchSequence()`: gate drops, cassette rides up, overlay
  clears as `.vhs-starting` blooms the picture on. The prototype uses a fixed
  1.8s timeline; ours hangs off the real sync, so the picture powers on at the
  `playAt` the server picked.
- **Ready is live during playback** (`7e0b4c2`). Not just after your tape ends —
  a unanimous lobby cuts a long clip short. A departure from
  [[BUILD-PLAN#6. Ready Check]], deliberately. The 3-2-1 over the insertion was
  later removed (`266d045`): the insertion *is* the countdown.
- **Rejoin** (`266d045`). A finished round ends the lobby; the first Rejoin
  re-forms it and takes the host seat, the rest land beside them as they click.
  Replaced the host-only REWIND & REPLAY, which dragged everyone in.

## Look

- VHS EFFECT toggle removed; the CRT treatment is always on (`f654ff4`).
- REC moved top-left → bottom-right (`f654ff4`); in-game views reserve that
  strip so tall lobbies don't slide under it (`8dddeeb`).
- Wordmark leaves the lobby — a link in the pre-game lobby only, inert once a
  round is under way (`f654ff4`).
- **Cosmetics actually render** (`f654ff4`). Loadouts are broadcast on the
  roster, so VCR skins repaint everyone's consoles in the lobby and voting
  grid; tape skin and label ride the insertion and results cassettes.
- "Decks" and "VCRs" now read "players" wherever they meant a person
  (`266d045`, `f7e3071`). Still "deck" where it means the machine.

> [!bug]- Two prototype defects were corrected, not copied
> Both the insertion caption and the results eject land an absolutely-positioned
> cassette on top of text. **The prototype at :9000 collides identically** —
> checked side by side — so these are corrections, not drift. Don't "restore"
> them to match. Fixes live in the App additions block of `globals.css`.

> [!bug]- Latent player bugs the animation work exposed
> `.video-screen`'s analog blue behind the player revealed that the YouTube
> iframe was rendering at the API default 640×360 with its title bar showing.
> The API replaces the div it is handed and keeps only the id, so adopting the
> prototype's `#yt-player-container` / `#yt-player` fixed the sizing and brought
> the `scale(1.15)` crop [[BUILD-PLAN#5. Video Playback Lock-Down]] wants.

## Verification

No test framework. Everything above was driven through `socket.io-client`
scripts against a booted server, per [[CLAUDE|CLAUDE.md]] — a full round takes
seconds and catches phase-machine regressions manual play misses. The suite
built this session lives outside the repo in the session scratchpad:

| Script | Covers |
|---|---|
| `round.js` | full 1-imposter round, pool no-repeat, exhaustion recycle |
| `host.js` | host transfer, mid-lobby settings, clamps, mid-round refusal |
| `two.js` / `two2.js` | all four 2-imposter endings + the deadlock rule |
| `rejoin.js` | lobby re-forms, settings survive, non-clickers stay out |
| `skip.js` | ready during playback, original path, grace timer |
| `cosmetics.js` | loadouts broadcast, junk and wrong-slot ids dropped |
| `spectator.js` | Custom author sits out end to end |

> [!tip] Rebuild these before the next tranche
> They are scratchpad-only and will be gone. Worth re-creating — or promoting
> into the repo — because `spectator.js` caught a real bug (`castVote` let the
> sitter vote) that reading the diff did not.
