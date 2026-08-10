---
title: Phase 2 Scope
date: 2026-07-31
tags:
  - project/imposter
  - planning
aliases:
  - Video Imposter Phase 2
status: done
---

# Phase 2 Scope

Phase 1 is closed — role secrecy, the per-player [[Ready Check]], and the tie-break
loop all match [[BUILD-PLAN#8. Voting]]. What follows is the next tranche, drawn from
the divergence table in [[CLAUDE|CLAUDE.md]].

> [!warning] The secrecy invariant survives every change
> `sanitizeRoom()` strips `normalVideoUrl` and `imposterVideoUrl` from ==every==
> room broadcast. A new event that leaks a URL breaks the game *silently*.
> See [[Socket Events#Adding an event]] before touching a payload.

## Work items

- [x] Genres — add Video Games and Custom to [[videoCategories]]
- [x] Move video config to `/content/videos.json`, bare YouTube IDs, 10–15 per genre
  - [x] No-repeat tracking per lobby session
- [x] Two-imposter flow: two word+vote rounds, accused removed between them
- [x] Host controls — manual transfer, mid-lobby settings changes
- [x] Swap Discord for Apple as the third auth provider
- [x] Custom genre: the host who picked it sits the round out ([[BUILD-PLAN#4. Lobby & Host Settings]])
  — needed a spectator flag threaded through imposter pick, turn order, voting
  and min-players, as expected.

> [!note]- Why the 2-imposter flow was last
> It reshapes the phase machine (`words → deliberation` runs twice), so it wanted the
> [[Reconnect]] work settled first — identity is still `socket.id` today. ^two-imposter-order
>
> Built anyway, without reconnect. It turned out not to depend on it: the accused
> are tracked as `RoomState.accusedIds`, which is the same socket-id-keyed state
> everything else already uses, so reconnect will fix all of it at once or none of
> it. A refresh mid-game still drops you — unchanged, not made worse.

> [!important] A Custom lobby needs five people
> The tape supplier doesn't play, so `MIN_PLAYERS` is measured against
> non-spectators. Four people who pick Custom cannot start — the lobby says so
> up front rather than failing at roll time. ^custom-needs-five

## Delivered

| Commit | What |
|---|---|
| `b089496` | Genre list completed; pools moved to `content/videos.json` with per-lobby no-repeat |
| `9d3b6cf` | `room:transferHost` + live mid-lobby settings (lobby-phase guarded) |
| `bf80946` | Apple replaces Discord; `/login` renders only live providers |
| `5e34e47` | 2-imposter two-round flow, §3 reward table, `allImpostersCaught` deadlock rule |
| `8dddeeb` | Custom-genre author sits the round out |

Next tranche: [[Phase 3 Scope]].

## Blocked on

Persistent currency and cosmetics are Phase 3, but both sit behind reconnect:
room state keyed on something more durable than a socket ID.[^1]

[^1]: Not a spec item — see the last row of the divergence table in [[CLAUDE|CLAUDE.md]].

%% Settled: the no-repeat set lives on `RoomState.usedVideoIds`, server-side, outside
`freshRoundState()` so Replay keeps it. Pools are loaded by `src/server/videoLibrary.ts`,
never imported client-side. %%

> [!caution] Pool clips are third-party uploads
> Every ID in `content/videos.json` was checked live against YouTube's oembed
> endpoint on 2026-08-01, but uploads get pulled and set private. A dead ID
> surfaces as a blank player mid-round, so re-check the pools before any launch.
