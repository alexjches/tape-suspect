---
title: Phase 3 Scope
date: 2026-08-01
tags:
  - project/imposter
  - planning
aliases:
  - Video Imposter Phase 3
status: done
---

# Phase 3 Scope

**Closed 2026-08-01.** Came from the divergence table in [[CLAUDE|CLAUDE.md]]
plus the reconnect row, which was not a spec item but gated the rest of the
tranche. All three items delivered — see the table below.

> [!warning] The secrecy invariant survives every change
> `sanitizeRoom()` strips `normalVideoUrl` and `imposterVideoUrl` from ==every==
> room broadcast. A new event that leaks a URL breaks the game *silently*.
> Cosmetics were safe to add to the roster because they carry no role
> information — hold any new player field to that same test.

## Work items

- [x] **Reconnect** — key room state on something more durable than `socket.id`
  - Done first. A refresh used to make a brand-new player and drop you from the
    round, and everything below inherited the problem. ^reconnect-first
- [x] Persistent, account-bound currency ([[BUILD-PLAN#9. Currency & Rewards]],
  [[BUILD-PLAN#11. Accounts]]) — the server computed `coinReward` in
  `game:results` and threw it away; `useShop` was localStorage
- [x] Voting visibility: host picks Public or Anonymous
  ([[BUILD-PLAN#4. Lobby & Host Settings]]) — `vote:tally` used to always
  broadcast a live tally

## Delivered

| Commit | What |
|---|---|
| `5ed582e` | Reconnect: durable player id, 60s grace window, phase catch-up |
| `fc0ffa7` | Currency: DB-backed wallet, verified socket identity, guest claim |
| `19b03b1` | Voting visibility: Public/Anonymous ballot, enforced in three places |

### What reconnect actually changed

`Player.id` is now the browser's `imposter_player_id` ([[playerId]]) and
`Player.socketId` is the transport. Everything keyed by player id — votes, turn
order, roles, the accused list — survives a reconnect untouched.

A dropped socket marks the player `disconnected` and starts a **60s** window
instead of removing them. They keep their seat, their vote, their turn slot,
their role and the host seat. No phase waits on them, because `activePlayers()`
already excluded the disconnected. On return, `room:join` with the same id
reattaches and replays the phase to that one socket.

> [!warning] Emitting to one player now needs `player.socketId`
> `io.to(player.id)` addresses nothing and fails **silently** — which is how a
> role assignment would go missing without an error anywhere. Handlers read the
> actor from `socket.data.playerId` via `actorId(socket)`, never `socket.id`.

> [!bug]- An unbreakable tie used to hang the room forever
> Found while testing a lobby that shrinks mid-ballot. With exactly two active
> players tied, neither can switch without voting for themselves, so every
> re-vote reproduced the same 1–1 and re-armed the 90s timer — a room that
> could never finish. `resolveVote()` now ends that case with no accusation.
> Pre-existing, but reconnect made it easy to reach: two people losing signal
> is enough. Bigger deadlocks still loop, correctly.

> [!note]- Deliberately not kept across a reconnect
> Chat history. The words are evidence and come back via `game:wordHistory`;
> chat is chatter, and buffering it is a moderation surface nobody has asked
> for. `room.words` and `room.lastResults` exist *only* for catch-up.

### What currency actually changed

`User.coins`, `CosmeticOwnership` and `User.equipped` are the wallet for
signed-in players; guests stay on localStorage. `useShop` presents one API over
both and reports which via `persistent`. `src/server/wallet.ts` is the only
writer, and `/api/wallet/*` derives the user from the session — a request body
never names whose wallet to touch.

> [!danger] `userId` on `room:join` was a coin printer waiting to happen
> It came from the client. Harmless while it only labelled a player; the moment
> `finalizeResults` credited coins against it, anyone could farm rewards into
> any account by typing an id. The socket now decodes the NextAuth session
> cookie off the handshake instead ([[socketAuth]]) and **ignores the field**.
> Tested: a client sending someone else's `userId` with no cookie earns nothing
> for anybody.

> [!important] The guest claim is unverifiable, so it is capped and single-use
> The payload is whatever was in the browser. `User.claimedGuestAt` makes it
> once-per-account and `MAX_CLAIMABLE_COINS` (5000) caps the amount. Coins are
> added and ownership merged, never overwritten, so a claim can't wipe a
> balance the account already had.

Also landed: §11's **claim-your-account prompt** on the results screen after
every round, plus the same warning in the shop. It is the user-visible half of
"your currency is at risk" and it would be odd to persist currency without it.

> [!todo] Left open, deliberately
> `Player.cosmetics` is validated for *shape* at join but not for **ownership**
> — a doctored client can wear something it never bought. The wallet API does
> check; the socket join would need an async DB hit in the join path. Cosmetic
> only, no coins involved. Worth doing, not worth widening this item for.

### What voting visibility actually changed

`settings.voteVisibility` is a host setting on both the setup form and the
lobby OSD, lobby-phase only — flipping it mid-ballot would retroactively
publish votes cast in confidence.

Public turned out to be **not implemented either**: §4 says "everyone sees live
who's voting for whom" and the screen only ever showed a running count. It now
shows the arrows.

> [!danger] Three leaks, and the third is the quiet one
> 1. `sanitizeRoom().votes` — the voter→target map.
> 2. `vote:tally` — the running count.
> 3. `game:revote` — **being on `eligibleVoters` means you backed neither tied
>    candidate**, so the roster is a statement about your ballot. Anonymous
>    lobbies get this per-socket, each player told only their own `canRecast`.
>
> `sendCatchUp()` repeats all three, or a reconnect would be the way around it.

> [!bug]- The public arrows had to move off `room.votes`
> Casting a vote does not emit `room:updated`, so a screen reading
> `RoomPublic.votes` shows a ballot frozen at the moment deliberation opened.
> Caught by the test, not by reading the diff. `VoteTally.ballots` is the live
> channel now; `room.votes` is only a snapshot.

Anonymous still keeps `votescast` / `totalVoters` — "3 of 5 have voted" says
nothing about targets, and the phase is unreadable without a sense of how close
it is to closing. And the **final** tally is revealed at results in both modes,
which is what §4 promises; individual ballots never are.

### Verification

Socket scripts against a booted server, per [[CLAUDE|CLAUDE.md]], plus one
browser pass because the client half (re-entering the room on every `connect`)
can't be driven from a socket client.

| Script | Covers |
|---|---|
| `reconnect.js` | refresh in each phase: host seat, same tape, word board, ballot, reveal |
| `reconnect2.js` | secrecy survives a resume; an absent player never stalls a phase |
| `grace.js` | the 60s window — held, then reaped, then an ordinary join (~80s run) |
| `regress.js` | the Phase 2 flows this cut across: Rejoin, sit-out, host transfer, 2-imposter |
| `wallet.js` | rewards credited to a verified account, forged `userId` worth nothing, purchase/equip/claim rules |
| `voting.js` | public vs anonymous across the ballot, the re-vote, a reconnect and the final reveal |

`wallet.js` mints a real NextAuth JWT with `encode()` and passes it as a
handshake cookie, which is how a socket test can be signed in at all.

Browser passes, for the halves a socket client can't reach:

- host a lobby → hard refresh → still one player, still host, same
  `imposter_player_id`. Before, that showed a ghost second player and lost the
  host seat.
- guest buys a skin off localStorage (900 → 750) → signs up → 750 coins, the
  item and the equipped slot all arrive in the account, localStorage is
  cleared, guest warning gone. Then a signed-in purchase: 750 → 550 in the
  database, both items owned.
- host an anonymous lobby from the setup form → the OSD reads `BALLOT:
  ANONYMOUS` with the matching hint → toggling it flips both live.

> [!tip] Same caveat as last time
> Scratchpad-only, so they'll be gone next session. `regress.js` earns its keep
> — the reconnect work touched every Phase 2 flow.

## What is left, for whoever picks this up next

No Phase 4 note exists yet — there is no obvious next tranche, so the ordering
is a decision rather than a continuation. Candidates, roughly by size:

- **Voice/video lobbies** (§4, §5) — the last row still in the divergence
  table. `ChatType` and [[DeliberationScreen]] already handle both values; the
  host form only offers text on/off, which was correct for Phase 1's scope.
  Needs real WebRTC plumbing, so it is much bigger than the row suggests.
- **Cosmetic ownership at socket join** — small, and the one integrity hole
  knowingly left open (see the callout above).
- **Profanity filter** (§17) — also a host setting in §4, so it slots
  naturally beside voting visibility.
- Never built at all: emoji reactions during video (§5), premium (§12), ads
  (§13), loot boxes (§10), report/block (§17), friends (§11), matchmaking
  (§16), and `GameHistory`, which has a Prisma model and no reader or writer.

> [!note]- Why reconnect led
> Currency has to survive a refresh to be worth persisting, and cosmetics are
> already account-shaped but were sent at join time keyed on a socket. Both
> become straightforward once identity outlives the connection, and both
> stayed half-broken until it did. Now unblocked. ^why-reconnect-leads

## Open questions

Raised during Phase 2, never answered — worth settling before the work starts:

- [ ] Should a host shortcut sit alongside per-player **Rejoin**, or is
  everyone-opts-in the whole story? (Current behaviour: no shortcut.)
- [ ] Should changing your cosmetics take effect without leaving and rejoining
  the lobby? They are sent on `room:create`/`room:join` only.
- [ ] "Skip to the voting phase" — the in-video Ready currently advances to the
  **word** phase, not deliberation. Confirm that was the intent.

## Carried over from Phase 2

> [!caution] Pool clips are third-party uploads
> Every ID in `content/videos.json` was checked live against YouTube's oembed
> endpoint on 2026-08-01, but uploads get pulled and set private. A dead ID
> surfaces as a blank player mid-round, so re-check the pools before launch.

> [!important] A Custom lobby needs five people
> The tape supplier doesn't play, so `MIN_PLAYERS` is measured against
> non-spectators. See [[Phase 2 Scope#^custom-needs-five]].
