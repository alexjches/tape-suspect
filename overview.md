# Video Imposter — Build Plan

> **How to use this doc:** Everything here is organized so you can edit any section before handing it to Claude Code. Section 20 lists every assumption I made on your behalf so you can quickly confirm or change them — that's the highest-value section to review first. Section 21 explains the existing `imposter` project folder and, importantly, which part of it to actually use as the visual reference — read that before touching any existing code or frontend files.

---

## 1. Concept Summary

A browser-based party game for friends or public lobbies (think **Gartic Phone**'s round structure + **Among Us**'s hidden-role social deduction). Everyone but one or two secret **Imposters** watches the same YouTube clip. Each player then says one word at a time hinting at what they saw. The Imposter(s), who watched a different clip, has to bluff. Discussion and a vote follow to catch them out. Nobody — Crewmate or Imposter — is told which role they have; that's part of the tension. See Section 18 for visual style direction.

**Platform:** Web app, responsive for any device, browser-based (no app store).

---

## 2. Core Gameplay Loop

1. **Lobby creation** — host sets genre, comms mode, imposter count, voting visibility, player cap, public/private
2. **Players join** — friends via link/code, or public matchmaking
3. **Role + video assignment** — 1 or 2 random Imposters (see Section 3); everyone else ("Crewmates") gets Video A, Imposter(s) get Video B (same genre, different clip). **Role is never shown to anyone** — players only ever see "their video"
4. **Video viewing phase** — locked fullscreen player, no scrubbing/skipping/speed controls, with live emoji reactions
5. **Ready Check** — players confirm they're ready once their video ends (handles differing video lengths)
6. **Word phase** — turn order randomized, 10 seconds each, one word per player
7. **Discussion & Vote phase (combined)** — chat and voting are both open at once for up to 90 seconds
8. **Results & rewards** — reveal Imposter(s), award currency
9. **Post-game ad** (free tier only) — interstitial before returning to lobby
10. **Rematch / return to lobby** — host can tweak settings before the next round; replays exclude already-used videos

---

## 3. Roles, Imposter Count & Win Conditions

**Hidden role:** nobody is told whether they're a Crewmate or an Imposter. Players only ever see "your video" — never a "You are the Imposter" or "You are a Crewmate" label, on this screen or any other. Even you don't know for certain whether your word matched the "real" video until the group starts comparing notes — that uncertainty is the core tension of the game.

**Imposter count:**
- Default: 1 Imposter, for any lobby size — see "1-Imposter Win Conditions" below
- 7+ players: host can optionally select 2 Imposters (mirrors Among Us's player-count-based imposter limits) — see "2-Imposter Win Conditions" below, which works differently and is confirmed by you
- When there are 2 Imposters, they both watch the **same** secret video together (aligned, not two separate lies)

### 1-Imposter Win Conditions

| | Crewmates | Imposter |
|---|---|---|
| Votes per player | 1 | 1 |
| Watches | Video A (shared) | Video B (different, same genre) |
| Knows their own role? | No — never shown | No — never shown |
| Win condition | The most-voted player is the Imposter | The most-voted player is a Crewmate (or the tie-break never resolves — see Section 8) |
| Reward | Base reward + win bonus | Base reward + **larger** win bonus |

### 2-Imposter Game Structure

2-Imposter lobbies run **two full word-and-vote rounds** instead of one, with a single vote per player per round (not 2 simultaneous votes). The structure is:

1. **Word Round 1** — all players say one word (same 10-second-per-player mechanic as normal)
2. **Discussion + Vote 1** — 90-second combined window; each player casts 1 vote; the most-voted player is "accused" and removed from active play *(their role is NOT revealed yet — the tension holds)*
3. **Word Round 2** — the remaining active players (everyone except the Vote 1 accused) each say one more word, same mechanic
4. **Discussion + Vote 2** — another 90-second window among the remaining players; each casts 1 vote; the most-voted remaining player is the second "accused"
5. **Results** — both accused players' roles are revealed simultaneously

**Outcomes and rewards (confirmed):**

| Result | Crewmates each receive | Each Imposter receives |
|---|---|---|
| 0 of 2 Imposters caught | 50 coins | 150 coins |
| 1 of 2 Imposters caught | 100 coins | 75 coins *(both Imposters receive 75 regardless of which one was individually caught)* |
| Both Imposters caught | 150 coins | 50 coins |

**2-Imposter-specific tie-break rules (confirmed):**
- **Tie strictly between the 2 Imposters, no swing voters** → Crewmates automatically win; both Imposters count as caught (150 / 50 outcome). This rewards the group for collectively zeroing in on exactly the right two.
- **Tie between an Imposter and a Crewmate, no swing voters** → no automatic resolution; the game forces a re-vote loop, restricting the choice to just those two tied players, and keeps repeating until at least one voter switches sides and breaks the tie. The round cannot conclude until someone moves.

---

## 4. Lobby & Host Settings

- **Communication mode** (host picks one for the whole lobby):
  - Text chat
  - Voice chat
  - Video chat
  - **None** — for groups already talking via Discord/FaceTime/etc. The site shows no in-built chat/voice UI at all beyond simple visual status indicators (e.g. "Player X's turn") — players coordinate entirely outside the app
- **Imposter count**: 1 (default) or 2 (unlockable once lobby has 7+ players) — see Section 3
- **Genre**: Sports, Memes, Video Games, Music, Custom, + room to add more
  - Free tier: limited genre selection
  - Premium: full genre list unlocked
- **Custom genre**: host pastes their own YouTube links for that round. A host who selects Custom cannot play that round (they already know the answers)
- **Player count**: min/max — *default 4–10, see Section 20*
- **Lobby visibility**: Private (invite link/code) or Public (matchmaking)
- **Voting visibility**: host chooses Public (everyone sees live who's voting for whom) or Anonymous (only the final tally is revealed)
- **Profanity filter**: host can toggle text/voice chat filtering on or off
  - *Suggested refinement, flagged in Section 20:* consider only allowing the filter to be turned off in private (friends-only) lobbies, and keeping it mandatory in public lobbies with strangers, for moderation/safety reasons
- **Mid-lobby settings changes**: host can adjust any of the above settings in between rounds without needing to close and recreate the lobby
- **Host transfer**: host can hand the host role to any other player in the lobby at any time (useful if the original host needs to leave but the group wants to keep playing, or just wants to pass control)

---

## 5. Video Playback Lock-Down (Technical Notes)

Use the official **YouTube IFrame Player API** (not scraping/downloading — keeps you ToS-compliant):

- `controls=0` — hides YouTube's native control bar (including fullscreen/speed buttons)
- `disablekb=1` — disables keyboard shortcuts (spacebar pause, arrow seek, `f` for fullscreen, etc.)
- `fs=0` — disables the fullscreen button specifically
- `modestbranding=1`, `rel=0` — minimizes YouTube branding/related-video links
- Wrap the iframe in a container `div` with a transparent overlay to block stray clicks
- For **your own** fullscreen experience: call the browser's native **Fullscreen API** on the wrapper `div` yourself (not YouTube's button) — this way players get a fullscreen video without ever touching YouTube's own UI

**Caveat to flag honestly:** this is best-effort lockdown, not unbeatable (a determined user with dev tools could still interfere). That's true of basically any browser-based "locked" video and is fine for a casual party game.

### Live Reactions During Video

- A small emoji button sits in the corner of the video player. Hovering or tapping it expands into a row of selectable emoji (e.g. 😂 😮 😢 🔥 👀)
- Tapping an emoji broadcasts a small floating reaction animation into the corner of **everyone's** video in the lobby in real time (a lightweight WebSocket event — no need to sync video playback itself, just the reaction event + timestamp)
- Side benefit for gameplay: since the Imposter is watching a different video, sharp players might notice their reactions land at different "moments" than everyone else's — a subtle extra tell, in the same spirit as the word-phase mismatch

---

## 6. Ready Check (Video → Word Phase Transition)

Crewmate and Imposter videos may run different lengths, so the game shouldn't auto-advance the instant a video ends — that would either rush some players or strand others on a blank screen.

- Once a player's individual video finishes, a **Ready** button appears at the bottom of their screen
- The game moves on once **either**:
  - all players have clicked Ready, **or**
  - 10 seconds have passed since the **Imposter's** video finished (whichever comes first) — preventing one straggler from holding up the whole lobby
- *Interpretation flagged in Section 20:* I've assumed this leads into the Word Phase next, since that's the next step structurally — confirm if you actually meant something else

---

## 7. Word Phase

- Turn order randomized each round, visible to all players ("Now speaking: Player X")
- **10-second timer** per player
- Auto-skip / blank word if timer runs out
- Medium follows the lobby's chosen comm mode:
  - **Text lobby**: typed word, submitted or timed out
  - **Voice/video lobby**: visual "your turn" + countdown overlay; player says it aloud (no text verification — see Section 17 on moderation)
  - **None (external call) lobby**: same visual "your turn" indicator; players speak on their own call

---

## 8. Discussion & Vote Phase

### 1-Imposter Lobbies

- Once all words from the Word Phase are revealed, a single **90-second window** opens where chat and voting are both live at the same time
- Each player casts **1 vote**; the round concludes as soon as every player has voted or the timer expires
- The most-voted player is the "accused"; if they're the Imposter → Crewmates win; if not → Imposter wins
- **Imposter can vote too** (helps them blend in)
- **Split vote / tie handling**: if two or more players tie for most-voted:
  - Players whose vote went to **neither** tied candidate get to recast — restricted to the tied candidates only
  - Players who already voted for a tied candidate keep their vote
  - **If no swing voters exist** (everyone already voted for one of the tied players and the split is exact): the game forces a re-vote loop restricted to the tied players, repeating until someone switches and the tie breaks. The round cannot conclude until resolved

### 2-Imposter Lobbies

The vote phase runs **twice**, sandwiching a second Word Round. See Section 3 for the full sequence. Rules that apply to each individual vote:

- **1 vote per player per round** — since each vote is a fully separate round, a player may vote for the same person in Vote 2 as they did in Vote 1, provided that person was not eliminated in Vote 1
- A 90-second discussion + vote window per round
- The Vote 1 accused player is **removed from active play** immediately after Vote 1 — they do not speak in Word Round 2 and do not vote in Vote 2. Their role is still not revealed until both votes are done
- **Voting visibility** per round follows the host's Public/Anonymous setting (Section 4)
- **Standard tie-break**: same split-vote re-vote process as 1-Imposter lobbies applies within each individual round
- **Deadlock tie-break rules**: see Section 3 — Imposter-vs-Imposter with no swing voters auto-resolves as a Crewmate win; Imposter-vs-Crewmate with no swing voters loops until someone switches

### Applies to all lobby types

- **Voting visibility** follows the host's setting from Section 4 — Public (live tally visible) or Anonymous (only final result shown)
- **Voice/video chat controls**: mic-mute and camera-off toggle buttons available throughout any phase where voice/video chat is active

---

## 9. Currency & Rewards

### 1-Imposter Lobbies

| Outcome | Crewmates each receive | Imposter receives |
|---|---|---|
| Crewmates win (Imposter caught) | 50 + 25 bonus = **75 coins** | 50 coins (base only) |
| Imposter wins (Imposter evades) | 50 coins (base only) | 50 + 50 bonus = **100 coins** |

### 2-Imposter Lobbies (confirmed coin values, not placeholders)

| Result | Crewmates each receive | Each Imposter receives |
|---|---|---|
| 0 of 2 caught | **50 coins** | **150 coins** |
| 1 of 2 caught | **100 coins** | **75 coins** *(see note below)* |
| Both caught | **150 coins** | **50 coins** |

*Both Imposters receive the same 75 coins in the 1-of-2-caught outcome, regardless of which one was individually caught. If you ever want to split this (e.g. surviving Imposter 100 / caught Imposter 50) that's a one-line config change before build.*

---

## 10. Shop & Cosmetics

Suggested categories:
- Avatar icons / skins
- Profile borders / frames
- Name colors
- Chat emotes / reactions
- Victory animations (shown on the results screen)

**Premium-exclusive cosmetic line:**
- Subscribing to Premium automatically grants the player a starter set of exclusive cosmetics right away
- Premium also unlocks additional purchasable cosmetics in the shop that free-tier players can't buy at all (separate from items everyone can buy with coins)

**Loot box mechanic:** a subset of cosmetics are obtained via randomized crates (earned through play, or purchasable directly) rather than direct purchase.
- *Practical build note:* Apple App Store and Google Play both require disclosed drop-rate odds for any loot-box-style mechanic, and a handful of countries (e.g. Belgium, Netherlands) restrict or ban monetized loot boxes outright — worth designing the odds-disclosure UI from day one, and keeping the rest of the shop (direct-purchase items) as a fallback for regions where crates aren't allowed

---

## 11. Accounts

- **Guest play**: temporary session, no email required
  - **Claim-your-account prompt**: shown to guests **after every round/game ends**, encouraging them to save their currency/cosmetics progress before it's lost
- **Registered account**:
  - Email/password
  - Google sign-in
  - Apple sign-in
  - *Future addition (not MVP):* Discord login — natural fit given the friend-group use case, planned for a later phase
- Profile picture (upload or pick from unlocked cosmetics)
- Friends list (add via username or friend code), invite friends directly into a lobby

---

## 12. Premium Tier

| Feature | Free | Premium |
|---|---|---|
| Ads | Interstitial ad after each game | None |
| Genres | Limited selection | Full selection |
| Games per day | 5 | Unlimited |
| Cosmetics | Coin-purchasable items only | Starter cosmetic set granted automatically + access to premium-exclusive purchasable items |
| Price | — | See suggestion below |

### Premium Pricing Suggestion (Competitor Comparison)

Your most direct competitors — Gartic Phone, skribbl.io, jklm.fun — are fully free and ad-supported with **no** premium subscription at all, so there's no benchmark from your closest rivals.

Looking at adjacent mobile/web party games that do sell an ad-free or premium experience:
- **Psych!** (Warner Bros' party/trivia app): removes ads via a one-time **$2.99** purchase
- **Buddies** (party challenge app): removes ads for **$1.99**
- **Spaceteam**: unlocks all upgrades for **$2.99**
- **PartyUp**: premium content pack starts at **$4.99**

These are mostly one-time purchases, because those apps don't have persistent accounts, currency, or an evolving cosmetic shop worth paying for repeatedly — yours does, so a small recurring subscription fits better than a one-off fee.

**Suggested pricing:** **$3.99–$4.99/month**, or **$24.99–$29.99/year** (roughly a 40–50% discount for paying annually, standard practice). This sits a little above the one-time ad-removal price points above (since you're offering ongoing value — unlimited play, a growing genre library, evolving cosmetics) while staying low enough to be an easy impulse purchase for a casual party-game audience.

---

## 13. Free Tier Ads

- Interstitial ad shown **after each round/game**
- **Rewarded ads**: free players can watch a short ad for bonus currency, or to unlock one extra game beyond the daily 5-game cap

---

## 14. Video Content Management (Editable Config)

A dedicated, easy-to-edit file so you can drop in links without touching game logic.

**Suggested location:** `/content/videos.json`

```json
{
  "sports": [
    { "id": "sports_001", "youtubeId": "dQw4w9WgXcQ", "label": "internal note for you, not shown to players", "tags": ["football", "highlight"] },
    { "id": "sports_002", "youtubeId": "dQw4w9WgXcQ", "label": "...", "tags": ["basketball"] }
  ],
  "memes": [],
  "video_games": [],
  "music": []
}
```

- Store just the **YouTube video ID** (the part after `v=` in the URL) — simplest for the IFrame API. A small helper function can auto-extract the ID if you paste a full link.
- **Pairing logic:** each round, randomly pick **two distinct videos from the same genre pool** — one for Crewmates, one for the Imposter(s).
- **Minimum pool size:** recommend at least 10–15 videos per genre so repeat pairings stay rare across many games.
- Custom genre videos (host-supplied) live in a separate per-lobby array, not the permanent config file.
- **No-repeat on Replay:** when players in the same lobby hit "Replay," the system excludes videos already used earlier in that lobby session from the random pool, so the same clips don't resurface until the genre's pool is exhausted. Track used-video IDs per lobby session (resets when the lobby closes).

---

## 15. Tech Stack Recommendation (Web App)

| Layer | Recommendation | Why |
|---|---|---|
| Frontend | React + TypeScript + Vite | Fast dev loop, huge ecosystem |
| Realtime (lobby/game state, turns, votes, reactions) | WebSockets (Socket.io) | Simple, well-supported real-time sync |
| Voice/video chat | Third-party SFU (e.g. LiveKit, Daily, or Agora) for the MVP | Building WebRTC mesh yourself is a big lift; these have generous free tiers and you can swap later if cost becomes an issue at scale |
| Backend | Node.js + Supabase (Postgres + Auth + Realtime) | Speeds up MVP a lot — built-in auth (incl. OAuth + guest/anonymous sessions), database, and realtime subscriptions out of the box. Can migrate to custom Node/Postgres later if you outgrow it |
| Payments | **Stripe** *(confirmed)* | Standard for web subscriptions + one-off currency purchases. Going web-first also avoids the 15–30% Apple/Google IAP cut you'd face on mobile |
| Ads | **Google Ad Manager** *(confirmed)* | Official Google ad stack — works well for web games, supports interstitial and rewarded ad formats needed for free tier |
| Video playback | YouTube IFrame Player API | Free, official, ToS-compliant |
| Hosting | Vercel/Netlify (frontend) + Supabase or Railway (backend) | Low-ops, scales fine for MVP-to-early-growth stage |

---

## 16. Suggested Build Roadmap (Phased MVP)

**Phase 1 — Core Loop (MVP)**
- 1 genre, text chat only (+ "None" comms option)
- 1 Imposter only (multi-imposter comes in Phase 2)
- Guest accounts only, hidden-role mechanic, Ready Check, combined discussion+vote phase with split-vote re-vote
- Basic currency reward (no shop spend yet)

**Phase 2 — Social Layer**
- Voice & video chat options + mic/cam toggles
- 2-Imposter mode for 7+ player lobbies
- Registered accounts (email/Google/Apple), profile pictures, friends list
- Additional genres + custom genre mode
- Host transfer, mid-lobby settings changes
- Live emoji reactions during video

**Phase 3 — Economy**
- Cosmetics shop incl. premium-exclusive line + loot box crates
- Premium tier (ads removed, more genres, daily cap removed, auto-granted cosmetics)
- Free-tier end-of-round + rewarded ads
- Public/Anonymous voting toggle, profanity filter toggle

**Phase 4 — Growth & Polish**
- Public matchmaking
- Discord login
- Additional monetization features (Section 19)
- Moderation tooling (discreet report button), polish, balancing

---

## 17. Safety & Moderation

- **Report functionality**: available on any player, designed as a **discreet button** (small, tucked away — not a flashy prominent element that disrupts the game flow or invites misuse)
- Block / mute functionality for any player
- Profanity filter: host-togglable per Section 4, recommend keeping mandatory in public lobbies (see suggested refinement there)
- Clear minimum age requirement in your Terms of Service (commonly 13+ for this style of app — worth confirming what's appropriate for your jurisdiction)
- Easy opt-out of webcam (audio-only fallback) even in "video chat" lobbies, for players uncomfortable going on camera with strangers
- A basic moderation/report review process before public launch

---

## 18. Visual & Brand Style Direction

You explicitly don't want this to look like a generic AI-generated website — here's concrete direction in the spirit of Make It Meme and Gartic Phone.

**What those games get right:**
- **Make It Meme**: vibrant, colorful UI built around bold typography and clean card-based layouts; the interface stays out of the way so the content is the star — bright accent colors, rounded shapes, playful icon work, fast round-to-round pacing with minimal loading friction
- **Gartic Phone**: cartoonish, candy-bright color palette; chunky rounded sans-serif fonts; big friendly buttons; loose hand-drawn/sketch-style accents; deliberately silly tone in copywriting (button labels, error messages, loading screens) rather than corporate/neutral language

**Recommended direction for your app:**
- **Color palette**: high-saturation, high-contrast colors (not muted pastels or grayscale corporate blue) — a punchy primary palette (hot pink, electric purple, lime, golden yellow) against a dark or near-black background, so the YouTube video itself stays the visual focus
- **Typography**: a chunky, rounded, slightly playful display font for headers/buttons (avoid generic system sans-serif or anything that reads "default template") — pair with a clean, highly legible body font for chat text
- **Tone of voice**: irreverent and a little chaotic in microcopy — lobby names, loading messages, role reveal screens, error states ("Searching for a sneaky imposter..." instead of "Loading...")
- **Motion**: snappy, bouncy transitions between phases (round reveals, vote results, currency rewards) — avoid plain fades; party games live and die by how satisfying the "reveal" moments feel
- **Imposter reveal moment**: this is your single most important screen — treat it like a game-show moment (dramatic pause, sound cue, animated reveal), not a quiet text update
- **Avoid**: centered hero sections with a single muted gradient, generic rounded-corner cards with soft shadows and no personality, stock illustration packs, corporate SaaS color schemes (navy/white/light blue) — these read instantly as "made by a generic tool" rather than "made for a party"

This is direction for whoever builds the UI (or to feed directly to Claude Code as a style brief) — happy to mock up an actual visual style if useful.

---

## 19. Additional Monetization Ideas

**Confirmed for inclusion, per your notes:**
- **Rewarded ads** — see Section 13
- **Genre packs**: one-time purchase for a single themed genre pack, for players who don't want a full subscription
- **Sponsored video packs**: brands pay to have a curated, clearly-labeled genre included (e.g. a gaming studio's own clips) — worth waiting on this until the app has real traction, since brand deals need an audience to pitch
- **Gifting**: buy a cosmetic or currency pack for a friend
- **Referral rewards**: invite a friend who plays a few games → both get bonus currency (growth lever more than direct revenue)
- **Loot box crates** — see Section 10

**Still just ideas to consider later** (not yet confirmed by you, low-effort to add if interested):
- Season pass / battle pass: rotating themed cosmetic track over a 4–6 week season
- Private lobby boosts: pay a small fee for extra-large lobbies or extra private games beyond a free cap
- Tournament/event mode: limited-time competitive lobbies with a currency "entry ticket," exclusive cosmetic prize for winners

---

## 20. Confirmed Decisions Log

Everything below is fully confirmed. There are no remaining open questions — this document is ready to hand to Claude Code as-is.

**Gameplay & Structure**
- ✅ Vote mechanic: most-voted player must be an Imposter for Crewmates to win (1-Imposter lobbies)
- ✅ Discussion + voting are merged into a single simultaneous 90-second phase (applies per-round in 2-Imposter lobbies too)
- ✅ 2-Imposter lobbies run 2 sequential word-and-vote rounds, 1 vote per player per round
- ✅ In 2-Imposter lobbies, a player may vote for the same person in Vote 2 as Vote 1, as long as that person was not eliminated in Vote 1
- ✅ Both-Imposters-caught outcome: Crewmates win 150 coins, each Imposter receives 50 coins
- ✅ Tie strictly between 2 Imposters with no swing voters → Crewmates auto-win (counts as both caught, 150 / 50 outcome)
- ✅ Tie between an Imposter and a Crewmate with no swing voters → forced re-vote loop until someone switches; the round cannot conclude until resolved
- ✅ Ready Check leads into the Word Phase
- ✅ Multi-imposter shared video: both Imposters watch the same secret video

**Accounts & Access**
- ✅ Guest "claim your account" prompt appears after every round
- ✅ Lobby size: 4–10 players
- ✅ Rounds per game: 1 round = 1 complete game; rematch starts fresh

**Rewards (all values are tunable before build)**
- ✅ 1-Imposter rewards: 75 coins Crewmates win / 50 coins Crewmates lose / 100 coins Imposter wins / 50 coins Imposter loses
- ✅ 2-Imposter rewards: 0 caught → 50 / 150; 1 caught → 100 / 75 (both Imposters flat); both caught → 150 / 50

**Moderation & Settings**
- ✅ Profanity filter is mandatory in public lobbies, toggleable only in private ones

**Infrastructure (all confirmed)**
- ✅ Ad network: **Google Ad Manager** — interstitial + rewarded ad formats for free tier
- ✅ Payment processor: **Stripe** — subscriptions (Premium tier) + one-off purchases (currency packs, genre packs, gifting)
- ✅ Free-tier daily reset: midnight UTC
- ✅ Custom genre minimum: host must supply at least 2 valid YouTube links to start a round

---

## 21. Existing Project Folder — What to Use, What to Ignore

There's already an `imposter` folder with some work-in-progress code in it. It contains two very different things, and it's important Claude Code (or whoever builds this) doesn't confuse the two:

- **`imposter/vhs-frontend-example/`** — this is the **frontend design to actually build towards**. The look, feel, layout, and UI style of the real app should match what's in this folder — treat it as the concrete visual reference, more authoritative than the general direction in Section 18 (Visual & Brand Style Direction). Section 18 is still useful as supporting rationale/tone-of-voice guidance, but if the two ever conflict on a visual detail, `vhs-frontend-example` wins.
- **The rest of the `imposter` folder (everything outside `vhs-frontend-example`)** — this is only a **rough, early sketch of how the app should *function***, not a finished reference. Two important caveats about it:
  1. It is **very basic and incomplete** — it's missing a lot of the key features described throughout this plan (e.g. the full roles/win-condition logic in Section 3, lobby/host settings in Section 4, the Ready Check flow in Section 6, currency/rewards in Section 9, accounts/premium/moderation, etc.). Don't treat its current feature set as the target — this document is the actual spec.
  2. Its **frontend/visual design should be ignored entirely** — it does not reflect how the finished app should look. Do not carry over its styling, components, or layout. Only `vhs-frontend-example` should inform the final visual design.

In short: use the rest of the `imposter` folder only as a loose, partial reference for rough functional plumbing already in place (and expect to heavily extend/rebuild it against this spec), and use `vhs-frontend-example` as the actual frontend design target.

---

*End of plan — ready to hand to Claude Code. Edit any section above, then point it at this file as your spec.*
