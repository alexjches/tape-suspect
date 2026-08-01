# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two things that must not be confused:

- **The spec** — `docs/BUILD-PLAN.md` ("Video Imposter — Build Plan", 21 sections). This is the **authoritative target**. Its Section 20 is a confirmed-decisions log; treat those values as binding, not suggestions.
- **The code in `src/`** — an early, partial sketch of the functional plumbing. Per spec Section 21, it is **missing most of the spec** and its **visual design should be ignored entirely**. Do not treat the current feature set as the goal.

**The visual target is `vhs-frontend-example/`**, not `src/`. Spec §21 is explicit: where `vhs-frontend-example` and the general style direction in §18 conflict on a visual detail, `vhs-frontend-example` wins. The current Tailwind theme and `src/app/globals.css` component classes are *not* the design to build toward.

When a request is ambiguous, the spec decides. When the spec and the code disagree, the code is what's wrong — see the divergence table below.

## Commands

```bash
npm install
npx prisma generate && npx prisma db push   # required before first run (creates prisma/dev.db)
npm run dev                                 # tsx server.js — Next.js + Socket.io on :3000
npm run build                               # next build
npm run lint                                # next lint
node vhs-frontend-example/server.js         # visual reference, static, :9000
```

- **Never start the app with `next dev`.** Socket.io is attached to a custom HTTP server in `server.js`; the plain Next dev server has no websocket layer and every room/game feature silently breaks.
- `npm start` is written as `NODE_ENV=production tsx server.js` (POSIX syntax). On this Windows machine that fails in PowerShell — use the Bash tool, or `$env:NODE_ENV='production'; npx tsx server.js`.
- No test framework is configured. Verification is `npx tsc --noEmit`, `npm run lint`, and `npx next build`.
- **Game logic is best verified by scripting socket clients**, not by clicking through four browser windows. Boot the server, then drive `socket.io-client` through a full round (create → join ×3 → start → syncReady → videoEnded → readyToAdvance → word ×N → vote → results) asserting on the payloads. A round takes seconds and catches phase-machine regressions that manual play misses. Run such a script from outside the repo with `NODE_PATH=<repo>/node_modules`.

## Current architecture

Next.js 14 App Router frontend + a Socket.io game server in the same process. `server.js` (CommonJS) boots Next, creates the socket.io `Server`, and calls `registerSocketHandlers(io)` from `src/server/socketHandlers.ts` — `tsx` is what lets a `.js` entrypoint `require` that TS module.

Note the stack already diverges from spec §15, which recommended React+Vite / Supabase / LiveKit. The existing Next.js + Prisma + custom-socket-server choice is what's actually built; don't rewrite it wholesale without asking.

**Two separate stores, deliberately:**
- **Game state is in-memory only** — a `Map<code, RoomState>` in `src/server/gameState.ts`. Restarting the dev server destroys every active room. Player identity *is* `socket.id`, so a refresh or reconnect creates a brand-new player and drops you from the round. (`game:rejoin` is a different thing — it re-forms a *finished* lobby for players whose sockets never went away.) This blocks several spec features (persistent currency, host transfer across reconnects) and will need to change.
- **Prisma/SQLite holds only durable, non-game data** — users, NextAuth accounts/sessions, video presets. The `GameHistory` model exists in the schema but nothing reads or writes it.

**The core secrecy invariant.** The game rests on players not knowing their role. `sanitizeRoom()` in `socketHandlers.ts` strips `normalVideoUrl`/`imposterVideoUrl` from every room broadcast, exposing only `hasNormalVideo`/`hasImposterVideo` booleans. URLs reach clients only through the per-socket `game:assigned` emit. Any new broadcast, event payload, or API response touching room settings must preserve this — leaking a URL breaks the game silently, not loudly.

Roles are covered by the same rule: `game:assigned` carries **only** `videoUrl`. `GameAssignment` deliberately has no `isImposter` field — a client that knows its role can read it from devtools, which defeats the mechanic. Roles first appear in the `game:results` payload, after voting closes. Don't add a role flag to any earlier payload.

**Phase machine** — `lobby → playing → words → deliberation → results`, and back to `lobby` only when somebody clicks Rejoin (see below). Names match the spec's vocabulary (sections 6–8). The server owns `room.phase`; `src/hooks/useRoom.ts` mirrors it into React state, and `src/app/room/[code]/page.tsx` switches between `LobbyScreen` / `GameScreen` / `WordsScreen` / `DeliberationScreen` / `ResultsScreen`. Transitions:
- `playing → words`: **Ready Check** (section 6). Every player reports their own `game:videoEnded`, and clicks Ready (`game:readyToAdvance`). Advances when all are ready, or 10s after the *imposter's* video ends — the server starts that grace timer because it alone knows who the imposter is. **Ready is deliberately not gated on your own video having finished**, which §6 implies it would be: it is live for the whole `playing` phase, so a lobby that has all seen enough cuts a long clip short. That's a product decision, not an oversight — don't "restore" the gate. One impatient player skips nothing; `allReadyToAdvance` still needs every connected player.
- `words → deliberation`: when the turn order is exhausted. Each turn is 10s; timing out auto-skips with a blank word.
- `deliberation → results`: when every *active* player has voted, or the 90s window expires — whichever comes first.
- `deliberation → words` **again**, in a 2-imposter game only — see below.
- A **tie** does not resolve to results. `resolveVote()` returns a `revote`, and the round loops (see below).

**The 2-imposter game runs the loop twice (section 3).** `imposterCount` is a host setting that unlocks at 7 players; at 2, `totalGameRounds()` returns 2 and the machine becomes `words → deliberation → words → deliberation → results`. `room.gameRound` tracks which pass you're in and `room.accusedIds` collects who has been ejected. **The accused's role is not revealed between rounds** — that withheld reveal is the whole mechanic, so `accusedIds` is safe to broadcast but nothing role-shaped may ride along with it. `activePlayers()` (connected *and* not accused) is what drives turn order, the ballot, and the "everyone voted" check; `connectedPlayers()` still covers the Ready Check, which happens once before round 1. Round 2 re-enters through `beginNextGameRound()` → `emitWordPhaseStart()`, skipping `beginWordPhase`'s caller because the turn order is already set. There is no second video and no second Ready Check.

Two 2-imposter rules cut across the normal ones. `resolveVote()` gains an `allImpostersCaught` outcome: a deadlock with no swing voters *between exactly the imposters* resolves for the crew instead of looping, because the group collectively named precisely the right people. And rewards stop being a win/lose flip — `coinsFor()` pays off the section 3 table by how many of the two were caught (crew 50/100/150, suspects 150/75/50), which is why `GameResults` carries `outcome: 'crew' | 'imposter' | 'split'` rather than just `crewWins`.

**Timers are server-authoritative.** One `setInterval` per room in the module-level `roomTimers` Map, driven through `setRoomTimer()`/`clearRoomTimer()`. Phases are sequential so a single slot suffices. **Every path that ends a phase must clear it** — disconnects, `game:rejoin`, room deletion — or intervals tick against a dead room. Each tick re-reads the room via `getRoom()` and bails if the phase moved on, so a stale timer cannot corrupt a later phase.

**Results ends the lobby; `game:rejoin` re-forms it.** There is deliberately no host-only "replay everyone" button — a finished round puts every player out, and each one opts back in for themselves. The first Rejoin runs `reformLobby()`: the room drops back to `lobby` with its settings and `usedVideoIds` intact, the clicker becomes host (the old one may never come back), and everyone else moves to `room.pastPlayers` and is taken out of the socket.io room so a lobby they haven't opted into stops updating the results screen under them. Later Rejoins restore identity from `pastPlayers` rather than trusting the client to say who it is, and re-`join` the channel. Rejoining twice is a no-op, and a room that emptied out answers with an error instead of resurrecting itself.

**Tie-breaking (section 8)** lives in `resolveVote()` / `beginRevote()` in `gameState.ts`. On a tie, voters who backed *neither* tied candidate are the swing voters: only their ballots are cleared, and they recast restricted to the tied pair. Voters already behind a tied candidate keep their vote. If there are no swing voters at all, the whole ballot re-runs among the tied players and loops until somebody switches — the round cannot conclude on a tie. `revoteCandidates` being non-null is what marks a restricted ballot.

**Adding a socket event requires edits in three places**, and doing two of three fails silently:
1. `src/server/socketHandlers.ts` — the handler, plus any `gameState.ts` mutator it needs.
2. `src/hooks/useRoom.ts` — a listener in the `useEffect`, *and* the matching `socket.off` in the cleanup.
3. `src/hooks/useRoom.ts` — a `useCallback` in the `actions` object, which is what components call.

**Type duplication is intentional.** `src/server/gameState.ts` holds the full server-side `RoomState` (URLs, imposter IDs, votes); `src/types/index.ts` holds the sanitized `RoomPublic` the client sees. Changing a room field means touching both plus `sanitizeRoom()`.

**Video content is split in two, and the split is load-bearing.** `src/lib/videoCategories.ts` is client-safe genre *metadata* only — id, name, icon, blurb — and is what `/dashboard` and the lobby render. The clips live in `content/videos.json` (spec §14: bare YouTube IDs, 10–15 per genre, `label`/`tags` are internal notes never sent to players) and are loaded by `src/server/videoLibrary.ts`, which is **server-only**: the pool is the set the imposter's clip is drawn from, so importing it from a component would ship the answer sheet to the browser. `videoLibrary` re-reads the JSON whenever its mtime changes, so links can be added without restarting the server, and keeps the last good copy if an edit leaves the file unparseable.

`pickVideoPair()` takes the round's genre plus `room.usedVideoIds` and returns two distinct clips, excluding anything the lobby has already seen. `usedVideoIds` lives on `RoomState`, is deliberately **not** in `freshRoundState()` — it must survive a Rejoin — and dies with the room, which is what "resets when the lobby closes" means. When a genre runs dry the helper drops that genre's history and returns `recycled: true`; other genres' history survives, so switching genre mid-lobby doesn't reset the one you were playing. `custom` is the one genre with no pool: those URLs come from the host and stay on the room.

**Video playback** — `src/components/game/VideoPlayer.tsx` handles YouTube (IFrame API, loaded once behind a global `window._ytReady` guard), Vimeo (postMessage), and MP4 (`<video>`) behind one imperative `play()`/`pause()` handle; `src/lib/videoParser.ts` picks the type. Sync works by each client emitting `game:syncReady` on load, then the server broadcasting `game:play` with a `playAt` timestamp ~1s out that clients schedule against. Players render with `pointerEvents: 'none'` and no controls. The lockdown player vars the spec asks for in §5 (`controls=0`, `disablekb=1`, `fs=0`, `modestbranding=1`, `rel=0`) are already set. The YouTube branch names its container `#yt-player-container` and its inner div `#yt-player` **on purpose**: the IFrame API swaps that div for an iframe of its own and keeps only the id, so those two vhs.css rules are what size the frame to 100% and apply the `scale(1.15)` that crops YouTube's title bar and control strip out of shot. Rename either id and the video reverts to a 640×360 box in the corner with its title on display.

**The watch phase is bookended by two tape animations**, both ported from `vhs-frontend-example`. Going in, `GameScreen` runs the prototype's `startWatchSequence()`: the gate drops, a cassette rides up into it, then the overlay fades as `.vhs-starting` blooms the picture on. The prototype drives that off a fixed 1.8s timeline because it has nobody to wait for — here the beats hang off the real sync instead, so the tape "reads" while other decks buffer and the picture powers on at the `playAt` moment. Coming out, `ResultsScreen` toggles `.vcr-deck.ejected` and the cassette flies out of the slot.

Both needed a clearance fix, and **the prototype has the same collision** — verified against it running on :9000, so don't "restore" these to match it. In each case an absolutely-positioned cassette lands on text that was laid out without it: the insertion caption gets `position: absolute` (growing its margin barely helps, since the flex column recentres and takes half of it back), and the results deck gets top margin so the eject's throw has somewhere to go. Both overrides live in the App additions block in `globals.css` with the reasoning inline.

**Coins are still client-side; cosmetics now render in game.** `src/hooks/useShop.ts` reads/writes `localStorage` (`imposter_coins`, `imposter_shop_owned`, `imposter_shop_equipped`). The server computes a `coinReward` in `game:results` but nothing persists it, so clearing site data wipes the wallet — the Phase 3 currency move is still outstanding. Guest identity is likewise localStorage (`imposter_guest_name`, `imposter_guest_avatar`).

**The cosmetic catalogue lives in `src/lib/cosmetics.ts`, not in the hook.** It has to be importable by the socket server — which validates incoming ids — and a server that has to import a React hook to check a string is the wrong shape. `useShop` re-exports `SHOP_ITEMS`/`COSMETIC_CATEGORIES` so existing callers didn't change.

**A loadout is broadcast, because a skin only you can see isn't a cosmetic (§10).** The client sends `equipped` on `room:create`/`room:join`; the server runs it through `sanitizeCosmetics()` — which drops unknown ids *and* ids sent for the wrong slot — and puts the result on `Player.cosmetics`, which `sanitizeRoom()` includes and `game:results` repeats. Cosmetics carry no role information, so this sits fine beside the secrecy invariant; keep it that way. `vcrSkinStyles()` / `tapeSkinStyles()` produce the same styles the shop previews use, so what you bought is what you get: VCR skins repaint the lobby consoles and the voting grid, the tape skin and label ride the insertion cassette (your own, straight from localStorage) and the results cassette (the accused's, from the payload). Because it's sent at join time, changing your loadout means leaving and coming back.

**Auth** — NextAuth, JWT sessions, credentials (bcrypt) plus Google/Apple providers conditionally spliced in only when their env vars exist — §11 lists Discord as a later addition, not a launch provider. `/login` calls `getProviders()` and renders a button only for what is actually live, so an unconfigured provider is invisible rather than broken. `APPLE_CLIENT_SECRET` is a signed ES256 JWT that expires within 6 months, not a static string. The `jwt`/`session` callbacks thread the DB user id onto `session.user.id`, passed as the optional `userId` on `room:create`/`room:join`.

## Where the code contradicts the spec

Verified against `src/` as of this file's writing. These are bugs-against-spec, not design choices — fix toward the spec column, and don't "preserve existing behavior" here.

Phase 1 (spec §16) closed most of the original gaps. **Fixed and verified:** role secrecy, single imposter, lobby size 4–10, reward values, combined 90s deliberation window, server-authoritative vote timer, split-vote re-vote and tie-break loops, per-player Ready Check, and the `none` comms mode.

Phase 2 so far: the full genre list (§4), the `/content/videos.json` config with per-lobby no-repeat (§14), the host controls from §4 — manual host transfer (`room:transferHost`) plus mid-lobby settings changes — the Apple provider swap (§11), and the 2-imposter two-round flow (§3). `room:updateSettings` is now guarded to the `lobby` phase, because §4 scopes those changes to *between* rounds; changing genre clears both loaded URLs so a Custom lobby cannot start on the previous round's pool clips.

`ChatType` is `'text' | 'voice' | 'video' | 'none'`, but the host form on `/dashboard` deliberately offers only a text on/off toggle (`'text'` or `'none'`) — §16 scopes Phase 1 to "text chat only (+ 'None' comms option)". The other two values stay in the union and in the lobby-list pill lookup so Phase 2 only has to add the buttons back; don't delete them.

Still outstanding:

| Area | Spec (`docs/BUILD-PLAN.md`) | Code today | Phase |
|---|---|---|---|
| Custom genre | A host who picks Custom cannot play that round — they already know the answers (§4) | Custom is selectable but the host still plays | 2 |
| Voting visibility | Host picks Public or Anonymous (§4) | Always broadcasts a live tally | 3 |
| Currency | Persistent, account-bound (§9, §11) | localStorage only (`useShop.ts`) | 3 |
| Reconnect | — | Identity is `socket.id`, so a refresh makes a new player and drops you from the round | — |
| Voice/video lobbies | Host can pick voice or video chat, with mic/cam toggles (§4, §5) | `ChatType` and `DeliberationScreen` handle both, but the host form only offers text on/off — correct for Phase 1, which §16 scopes to "text chat only (+ 'None')" | 2 |
| Not built | Emoji reactions during video (§5), premium (§12), ads (§13), loot boxes (§10), profanity filter (§17), report/block (§17), friends (§11), matchmaking (§16) | — | 2–4 |

The reconnect row is not in the spec but blocks several things that are (persistent currency, host transfer surviving a refresh). It needs room state keyed on something more durable than `socket.id`.

## Conventions

- Import via `@/*` → `src/*`.
- **Styling is the VHS/CRT system in `src/app/vhs.css`** — a verbatim copy of `vhs-frontend-example/styles.css`, imported first by `globals.css`. Build with its classes (`btn-brutal`, `brutal-card`, `vhs-player`, `osd-menu`, `osd-text`, `modal-card`, `brutal-input`, `view-panel`, `gartic-*`, `lobby-item-*`). Don't edit `vhs.css` — it tracks the reference; app-only additions go in the "App additions" block in `globals.css`.
  - **Every route is ported** — `page.tsx` (landing), `/dashboard` (lobby router), `/login`, `/signup`, `/shop`, and all five room phases. The old violet/glass system is gone: no `glass`, `card`, `btn-primary`, `input-field`, `grid-bg`, or `neon-*` classes remain, and `tailwind.config.js` no longer carries a colour scale. Tailwind survives for layout utilities only (`flex`, `inset-0`, `w-full`); colours come from the `--neon-*` custom props.
  - `<CrtShell>` supplies the viewport frame. Pass `home` for the scrollable marketing/console layout (landing, dashboard, auth, shop); omit it for the in-game `.view-panel` stack. It sets no body classes — `.crt-viewport` is `position: fixed` and vhs.css already locks body scroll, so a page rendered *outside* CrtShell inherits that lock and must scroll an inner container.
- Server-side sanitize all user input at the handler: words stripped of whitespace and capped at 30 chars, chat at 300, `wordsPerPlayer` clamped 1–10, `imposterCount` clamped. Keep this up for new events.
- Env: `.env.example` is the template; `.env` and `.env.local` exist locally and are gitignored. `DATABASE_URL` points at SQLite (`file:./dev.db`); switching to Postgres also means editing `provider` in `prisma/schema.prisma`.
- YouTube access stays on the official IFrame API — no scraping or downloading (spec §5, ToS).

## Deployment note

Vercel cannot host this — serverless functions don't hold persistent websockets. Target Railway/Render running the custom Node server. In-memory rooms also mean this can't scale past one instance without moving room state to a shared store.

## `vhs-frontend-example/`

Standalone static prototype of the VHS/CRT UI ("Tape Suspect") — plain HTML/CSS/JS on its own file server at port 9000. Committed as of `197389f`. Shares no code with `src/` and isn't part of the Next build, but it *is* the visual source of truth: `index.html` covers the in-game views, `home.html` the landing + cosmetics shop, `join-host.html` the lobby router. Read the matching section there before designing a new screen.
