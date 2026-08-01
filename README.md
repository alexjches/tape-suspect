# 📼 Tape Suspect — The Video Deception Game

A real-time multiplayer social deduction game. Everyone watches the same video together — except one player, the **Suspect**, who is secretly served a completely different one. Describe what you saw in a single word each, then argue and vote before the tape runs out.

Inspired by Sidemen Reacts: Imposter.

## Where the truth lives

- **[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md)** is the product spec and the authoritative target. Section 20 is a confirmed-decisions log.
- **[`CLAUDE.md`](CLAUDE.md)** is the engineering orientation doc — architecture, invariants, and a table of everything still outstanding against the spec. **Read it before changing game logic.**
- **`vhs-frontend-example/`** is the authoritative visual reference: a standalone static prototype of the VHS/CRT UI. Its `styles.css` is copied verbatim into `src/app/vhs.css`.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), React 18, TypeScript |
| Styling | VHS/CRT design system (`src/app/vhs.css`); Tailwind for layout utilities only |
| Real-time | Socket.io on a custom Node HTTP server (`server.js`, run through `tsx`) |
| Auth | NextAuth.js — email/password (bcrypt) + Google/Apple OAuth |
| Database | Prisma + SQLite (dev) / PostgreSQL (prod) — durable data only |

---

## 🚀 Quick Start

Requires Node.js 18+.

```bash
npm install
npx prisma generate && npx prisma db push   # creates prisma/dev.db
npm run dev
```

Open http://localhost:3000.

> **Never start the app with `next dev`.** Socket.io is attached to the custom HTTP server in `server.js`; the plain Next dev server has no websocket layer, so every room and game feature breaks silently. Always use `npm run dev`.

`npm start` is written with POSIX syntax (`NODE_ENV=production tsx server.js`) and fails in PowerShell. On Windows use Git Bash, or `$env:NODE_ENV='production'; npx tsx server.js`.

To view the design reference: `node vhs-frontend-example/server.js`, then open http://localhost:9000.

---

## 🎮 How a round works

Server-authoritative phase machine: `lobby → playing → words → deliberation → results`.

1. **Lobby** — the host picks public/private, whether in-app text chat is on, and a genre (or supplies two custom video URLs). 4–10 players.
2. **Playing** — one player is secretly assigned the odd video. Everyone's tape starts at the same moment; no controls, no scrubbing, no pausing. **You are never told your own role.**
3. **Ready Check** — Ready is live for the whole video, not just once your tape ends, so a lobby that has all seen enough can cut a long clip short. The phase advances when everyone is ready, or 10s after the Suspect's video finishes.
4. **Words** — 10 seconds each, in turn, to describe the video in a single word. Timing out submits a blank.
5. **Deliberation** — one 90-second window with chat and voting live at the same time. A tie doesn't end the round: it triggers a restricted re-vote between the tied players.
6. **Results** — roles are revealed, both tapes are shown side by side, and coins are paid out (50 for playing, +25 for a crew win, +50 for a Suspect win).
7. **Rejoin** — the round ends the lobby and everyone is out. **Rejoin** puts you back into the same one with the same settings; whoever clicks first re-forms it and takes the host seat, and the others land beside them as they click. Nobody is dragged into another round without asking.

---

## 🔧 Configuration

Copy `.env.example` to `.env`. `.env` and `.env.local` are gitignored.

| Variable | Required | Description |
|---|---|---|
| `NEXTAUTH_SECRET` | ✅ | Random secret for JWT signing |
| `NEXTAUTH_URL` | ✅ | App base URL |
| `DATABASE_URL` | ✅ | SQLite: `file:./dev.db`, or a Postgres URL |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional | Enables Google sign-in |
| `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET` | Optional | Enables Apple sign-in. The secret is a signed ES256 JWT that expires within 6 months, not a static string |

OAuth providers are spliced in only when their env vars are present, so the app runs fine with email/password alone — and `/login` asks NextAuth which ones are live rather than hardcoding the buttons, so an unconfigured provider simply doesn't render.

### Switching to PostgreSQL

1. Point `DATABASE_URL` at your Postgres connection string.
2. In `prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"`.
3. Run `npx prisma db push`.

---

## 📁 Project Structure

```
docs/BUILD-PLAN.md          # product spec — the authoritative target
vhs-frontend-example/       # static VHS/CRT design reference (port 9000)
server.js                   # Next + Socket.io on one HTTP server
src/
├── app/
│   ├── globals.css         # imports vhs.css, plus app-only additions
│   ├── vhs.css             # design system, copied verbatim from the reference
│   ├── page.tsx            # landing ("Access Deck")
│   ├── dashboard/          # lobby router — browse, join by code, host
│   ├── login/ signup/      # auth consoles
│   ├── shop/               # cosmetics shop
│   └── room/[code]/        # phase-aware game room
├── components/
│   ├── vhs/CrtShell.tsx    # the CRT viewport frame every screen renders in
│   ├── home/               # LandingHero
│   ├── lobby/              # LobbyScreen, VideoSetupPanel, PresetLibrary
│   ├── game/               # GameScreen, WordsScreen, DeliberationScreen, VideoPlayer
│   ├── results/            # ResultsScreen
│   └── shop/               # CosmeticPreview
├── hooks/
│   ├── useRoom.ts          # socket listeners + the actions components call
│   └── useShop.ts          # coin wallet and cosmetics (localStorage)
├── lib/                    # socket, prisma, auth, avatars, videoParser, videoCategories
└── server/
    ├── gameState.ts        # in-memory room store, turn order, vote resolution
    ├── videoLibrary.ts     # loads content/videos.json, picks each round's pair
    └── socketHandlers.ts   # every Socket.io event
```

Genre clips live outside `src/` in **`content/videos.json`** — bare YouTube IDs, 10–15
per genre — so links can be added without touching game logic. The server re-reads it
when the file changes; no restart needed.

Two separate stores, deliberately: **game state is in-memory** (a `Map` in `gameState.ts`, lost on restart), while **Prisma holds only durable data** — users, sessions, video presets.

---

## 🔒 The secrecy invariant

The whole game rests on players not knowing their role.

- `sanitizeRoom()` strips both video URLs from every room broadcast, exposing only `hasNormalVideo` / `hasImposterVideo` booleans.
- URLs reach a client **only** through the per-socket `game:assigned` emit.
- `game:assigned` carries **only** `videoUrl`. There is deliberately no `isImposter` field — a client that knows its own role can read it out of devtools.
- Roles first appear in `game:results`, after voting closes.

Any new broadcast, event payload, or API response touching room settings must preserve this. Leaking a URL or a role breaks the game silently, not loudly.

---

## 🎬 Supported Video Sources

| Source | Format |
|---|---|
| YouTube | `https://youtube.com/watch?v=VIDEO_ID` |
| YouTube Shorts | `https://youtube.com/shorts/VIDEO_ID` |
| Vimeo | `https://vimeo.com/VIDEO_ID` |
| Direct file | `https://example.com/video.mp4` — also `.webm`, `.ogg`, `.mov` |

YouTube playback stays on the official IFrame API — no scraping or downloading.

---

## ✅ Verification

There is no test framework configured. Before calling a change done:

```bash
npx tsc --noEmit
npm run lint
npx next build
```

Game logic is best checked by **scripting socket clients**, not by clicking through four browser windows. Boot the server, then drive `socket.io-client` through a full round — create → join ×3 → start → syncReady → videoEnded → readyToAdvance → word ×N → vote → results — asserting on the payloads. A round takes seconds and catches phase-machine regressions that manual play misses.

---

## 🏗️ Deployment

**Vercel cannot host this.** Serverless functions don't hold persistent websockets. Target **Railway** or **Render** running the custom Node server:

1. Connect the repository.
2. Set the environment variables above.
3. Build: `npm run build` · Start: `npm start`

In-memory rooms also mean this can't scale past a single instance without moving room state to a shared store.

---

## 📡 Socket.io Event Reference

### Client → Server

| Event | Description |
|---|---|
| `room:create` | Create a room (visibility, chat mode, genre or custom URLs) |
| `room:join` | Join by code |
| `room:updateSettings` | Host changes video URLs, words per player, chat mode |
| `room:kick` | Host removes a player |
| `rooms:list` | Fetch the public lobby list |
| `room:chat` | Lobby chat message |
| `game:start` | Host starts the round |
| `game:syncReady` | This client's video has buffered |
| `game:videoEnded` | This client's video finished |
| `game:readyToAdvance` | Ready Check confirmation |
| `game:word` | Submit this turn's word |
| `game:chat` | Deliberation-phase message |
| `vote:cast` | Cast or recast a vote |
| `game:rejoin` | Re-form the same lobby after a round; each player opts in |

### Server → Client

| Event | Description |
|---|---|
| `room:updated` | Full sanitized room state |
| `rooms:updated` | Public lobby list changed |
| `room:kicked` | You were removed |
| `room:chatMessage` | Chat message broadcast |
| `game:assigned` | **Per-socket.** Your video URL — and nothing else |
| `game:readyCount` | How many clients have buffered |
| `game:play` | Synchronized start, with a `playAt` timestamp |
| `game:readyState` | Ready Check progress + grace deadline |
| `game:wordPhaseStart` | Turn order for the word phase |
| `game:turnState` | Whose turn it is and time left |
| `game:word` | A submitted word |
| `game:deliberationStart` | The 90s window opened |
| `game:deliberationTick` | Seconds remaining |
| `game:revote` | Tie detected — tied candidates and who must recast |
| `vote:tally` | Live vote counts |
| `game:results` | Roles, both tapes, final tally, coin rewards |
| `game:error` | Rejected action, with a reason |

Adding an event means editing **three** places — the handler in `socketHandlers.ts`, a listener *and* its `socket.off` cleanup in `useRoom.ts`, and a `useCallback` in that hook's `actions` object. Doing two of the three fails silently.
