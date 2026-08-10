// src/types/index.ts
// Shared types used across frontend and backend

// Phase flow per docs/BUILD-PLAN.md sections 6-8:
//   playing      video + Ready Check
//   words        turn-based word phase, 10s each
//   deliberation ONE 90s window, chat and voting live simultaneously
export type GamePhase =
  | 'lobby'
  | 'playing'
  | 'words'
  | 'drawing'
  | 'clue'
  | 'guessing'
  | 'writing'
  | 'bluffvote'
  | 'deliberation'
  | 'results';

export type ChatType = 'text' | 'voice' | 'video' | 'none';

/**
 * Host setting from spec §4, applied per vote round (§8).
 *
 *   public     everyone sees live who is voting for whom
 *   anonymous  only the final tally is revealed, at results
 *
 * "Only the final tally" is literal: in anonymous lobbies individual ballots
 * are never published, not even once the round is over.
 */
export type VoteVisibility = 'public' | 'anonymous';

export interface PlayerPublic {
  id: string;
  name: string;
  avatar: string;
  isHost: boolean;
  isReady: boolean;
  /**
   * Sitting this round out (section 4) — the player who supplied the Custom
   * genre's links. No video, no turn, no vote, no reward.
   */
  isSpectator: boolean;
  status: 'connected' | 'disconnected';
  /**
   * A simulated player added for testing (`room:addBots`). Broadcast on
   * purpose and rendered as a badge: a lobby has to be honest about which of
   * its players are furniture, otherwise the feature is indistinguishable
   * from quietly padding a room with fake humans.
   */
  isBot?: boolean;
  /** Equipped cosmetics (section 10) — what everyone else sees you wearing. */
  cosmetics: EquippedCosmetics;
}

export interface RoomPublic {
  code: string;
  hostId: string;
  phase: GamePhase;
  /** 1, or 2 during the second half of a 2-imposter game (section 3). */
  gameRound: number;
  /** 2 for a 2-imposter game, 1 otherwise. */
  totalRounds: number;
  /**
   * Players ejected by a completed vote. Safe to broadcast — being accused
   * says nothing about your role, which is exactly why section 3 withholds
   * the reveal until both rounds are done.
   */
  accusedIds: string[];
  /** Who supplied the custom content, and so sits the round out (§4). */
  customContentAuthorId: string | null;
  /**
   * The Wavelength scale, public because everyone is guessing on it. The
   * target and the psychic's identity are NOT here and must not be added —
   * that split is the whole secrecy surface of the mode.
   */
  spectrum: Spectrum | null;
  /** The psychic's clue, public the moment it is submitted. */
  psychicClue: string | null;
  players: PlayerPublic[];
  settings: {
    isPublic: boolean;
    maxPlayers: number;
    /**
     * Is the round running on content the host typed rather than on the mode's
     * pool? Public because it decides whether somebody is sitting out, which
     * the lobby has to be able to say before anyone presses start.
     */
    useCustomContent: boolean;
    hasNormalVideo: boolean;
    hasImposterVideo: boolean;
    /**
     * Whether each half of a custom prompt pair has been filled in. Booleans
     * for the same reason the videos are booleans: the text is the answer.
     */
    hasNormalPrompt: boolean;
    hasImposterPrompt: boolean;
    wordsPerPlayer: number;
    imposterCount: number;
    chatType: ChatType;
    voteVisibility: VoteVisibility;
    videoCategory: string | null;
    /**
     * Fake Artist difficulty: does the fake get a category hint?
     *
     * Safe to broadcast — it says what *kind* of information exists in the
     * round, not who holds it. Everyone needs to know whether the fake is
     * drawing blind, because it changes how suspicious a bad stroke is.
     */
    themeHint: boolean;
  };
  /**
   * Voter -> target. Empty in an anonymous lobby, where individual ballots
   * are never published — check `settings.voteVisibility` before reading it
   * rather than inferring "nobody has voted" from an empty object.
   */
  votes: Record<string, string>;
  /**
   * Whether this server will accept `room:addBots`.
   *
   * A server capability rather than a room setting, echoed onto every room so
   * the client never has to guess. The alternative — a NEXT_PUBLIC_ env var —
   * lets the button and the handler disagree, which shows up as a control
   * that is visible and silently does nothing.
   */
  botsAllowed: boolean;
  createdAt: number;
}

// Spec section 3: role is hidden from the player for the whole round —
// there is deliberately no `isImposter` here. A client that knows its own
// role can read it out of devtools, which defeats the core mechanic. The
// role is only ever revealed in GameResults, after voting closes.
//
// Exactly one field is set, decided by the mode's style: a video round deals
// `videoUrl`, a Words or Questions round deals `prompt`. Crew and suspect get
// the same shape either way — that is the whole point.
export interface GameAssignment {
  /** Video rounds only. */
  videoUrl?: string;
  /** Word and question rounds only: your card, and only ever yours. */
  prompt?: string;
  /**
   * Fake Artist only, and the one place in the game a player is told their own
   * role.
   *
   * Everywhere else this field would be a bug: a client that knows it is the
   * suspect can read that out of devtools, which is why video/word/question
   * rounds deal a near miss instead and `isFake` is left undefined. Here the
   * fake knowing *is* the mechanic — they have to bluff a stroke with no word.
   * The invariant that still holds without exception is the other half: nobody
   * learns anyone **else's** role, so `imposterIds` never rides a broadcast.
   */
  isFake?: boolean;
  /** The crew's word. Absent for the fake. */
  drawWord?: string;
  /**
   * The fake's category hint, when `settings.themeHint` is on. Absent for the
   * crew — they have the word, and handing them the theme as well would tell
   * them exactly how much the fake knows.
   */
  themeHint?: string;
  /**
   * Wavelength: the hidden target, 0-100 — dealt to the psychic alone. The
   * spectrum itself is public (everyone needs the scale they are guessing on);
   * this number and who holds it are the only secrets in the mode.
   */
  target?: number;
  /** True for the one player who can see the target. */
  isPsychic?: boolean;
}

/** A public scale, both ends visible to everyone. */
export interface Spectrum {
  left: string;
  right: string;
}

/**
 * One entry on the Bluff ballot.
 *
 * `authorId` is deliberately absent: the whole round is not knowing whose
 * definition is whose. Authors are attached only in `game:results`.
 */
export interface BluffOption {
  /** A player id, or REAL_DEFINITION_ID for the true one. */
  id: string;
  text: string;
}

/** One player's line on a scored round's final table. */
export interface ScoreLine {
  playerId: string;
  name: string;
  avatar: string;
  points: number;
  /** Human-readable working, e.g. "guessed 61, target 58 — 3 off". */
  detail: string;
}

/**
 * One stroke on the shared canvas.
 *
 * Points are normalised to 0..1 against the canvas box rather than sent as
 * pixels, because the phone drawing at 390px wide and the laptop watching at
 * 1440px have to see the same picture. Denormalising is the renderer's job.
 */
export interface DrawStroke {
  playerId: string;
  playerName: string;
  /** Flat [x0, y0, x1, y1, …] in 0..1. Flat rather than {x,y} pairs: this goes
   *  over the wire several times a round and halves the JSON. */
  points: number[];
  /** Assigned per player from a fixed palette, so you can read who drew what. */
  colour: string;
  /** Which stroke this is for that player (1-based), mirroring GameWord. */
  strokeIndex: number;
}

export interface VoteTally {
  /**
   * playerId -> vote count. **null in an anonymous lobby** — the running
   * count is exactly what §4 says that setting withholds. The two progress
   * numbers below still go out, because "3 of 5 have voted" says nothing
   * about who anyone voted for and the phase is unreadable without it.
   */
  tally: Record<string, number> | null;
  /**
   * voter -> target, which is §4's "everyone sees live who's voting for
   * whom". Null in an anonymous lobby.
   *
   * Lives here rather than on `RoomPublic.votes` because this is the payload
   * a vote actually pushes — `room:updated` only fires on roster changes, so
   * a screen driven off the room snapshot would show a ballot frozen at the
   * moment deliberation opened.
   */
  ballots: Record<string, string> | null;
  votescast: number;
  totalVoters: number;
}

export interface GameResults {
  /**
   * Which shape of round this was, and therefore which half of the results
   * screen means anything.
   *
   *   accusation  a hidden role was ejected — every imposter/vote field below
   *               is populated, `scores` is null
   *   score       nobody was hiding; `scores` is the result and the imposter
   *               and ballot fields are empty placeholders
   *
   * A discriminant rather than a union type: GameResults is threaded through
   * the socket layer, the wallet, `room.lastResults` and a large results
   * screen, and splitting the type would touch all of them to express a
   * difference that one field and one branch cover.
   */
  kind: 'accusation' | 'score';
  /** Non-null only when kind is 'score'. Highest first. */
  scores: ScoreLine[] | null;
  /** The scale that was played, on a spectrum round. */
  spectrum: Spectrum | null;
  /** The hidden target and the psychic, revealed now. */
  spectrumTarget: number | null;
  psychicId: string | null;
  psychicClue: string | null;
  imposterId: string;       // primary imposter (backwards compat)
  imposterIds: string[];    // all imposters
  imposterName: string;
  imposterAvatar: string;
  /** The final accusation — the one the results screen ejects on camera. */
  mostVotedId: string | null;
  mostVotedName: string;
  /** Everyone ejected, in vote order: one round normally, two with 2 suspects. */
  accusedIds: string[];
  accusedNames: string[];
  imposterCount: number;
  impostersCaught: number;
  /**
   * 'split' only happens in a 2-imposter game where exactly one of the two was
   * caught — neither side swept it, and section 3 pays both a middle amount.
   */
  outcome: 'crew' | 'imposter' | 'split';
  /** True only when every imposter was caught. */
  crewWins: boolean;
  tally: Record<string, number>;
  // Safe to send only now that voting has closed — compare the two tapes.
  // Empty strings on a word/question round, where the pair below is the reveal.
  normalVideoUrl: string;
  imposterVideoUrl: string;
  /** The two cards on a Words or Questions round; null on a video round. */
  normalPrompt: string | null;
  imposterPrompt: string | null;
  /** What the crew were drawing, and the hint the fake had. Null elsewhere. */
  drawWord: string | null;
  drawTheme: string | null;
  /** Bluff: the word, the true definition, and who wrote what. */
  bluffWord: string | null;
  bluffTruth: string | null;
  bluffReveal:
    | { id: string; text: string; authorName: string; isReal: boolean; votes: number }[]
    | null;
  players: {
    id: string;
    name: string;
    avatar: string;
    votes: number;
    cosmetics: EquippedCosmetics;
    isImposter: boolean;
    wasAccused: boolean;
    isSpectator: boolean;
    coinReward: CoinReward;
  }[];
}

export interface CoinReward {
  baseCoins: number;
  bonusCoins: number;
  total: number;
  reasons: string[];
}

export interface ChatMessage {
  playerId: string;
  playerName: string;
  avatar: string;
  message: string;
  timestamp: number;
  isWord?: boolean;  // true if this is a restricted single-word message
}

/** A word submitted during the turn-based word phase (section 7). */
export interface GameWord {
  playerId: string;
  playerName: string;
  avatar: string;
  word: string;
  wordIndex: number;   // which word this is for that player (1-based)
  timestamp: number;
}

// ─── Live reactions during the video (spec §5) ───────────────────────
/**
 * The five reactions §5 names. A closed set on purpose, and shared by both
 * sides: the client renders these buttons, the server rejects anything that
 * is not one of them. An open emoji field would be a 300-char chat channel
 * during the one phase that has no chat.
 */
// CHANGING THIS LIST MEANS REGENERATING A FONT. The bundled emoji subset
// (public/fonts/emoji-reactions.woff2) covers exactly these five codepoints,
// and the @font-face `unicode-range` in globals.css lists them out. A sixth
// emoji added here renders in the platform font instead — no error, it just
// looks wrong next to the others. See public/fonts/README.md.
export const REACTION_EMOJI = ['😂', '😮', '😢', '🔥', '👀'] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return (REACTION_EMOJI as readonly unknown[]).includes(value);
}

/**
 * One reaction, broadcast to the whole room as it happens.
 *
 * Carries no role information, which is what keeps it clear of the secrecy
 * invariant: the imposter and the crew emit the identical payload shape, and
 * nothing here says which tape is playing.
 *
 * `playerId`/`playerName` identify the sender, but **the watch screen
 * deliberately renders only the emoji** — see ReactionBar.tsx. They stay on
 * the payload because this is the room's reaction feed rather than one
 * component's props. The consequence for §5's stated side benefit (the
 * imposter reacting at the wrong moments, since they are watching a
 * different tape) is that the tell now rests on timing alone: you see a
 * reaction land out of step with everyone else's, not whose it was.
 */
export interface GameReaction {
  playerId: string;
  playerName: string;
  emoji: ReactionEmoji;
  /** Server clock, not the client's — used only to key the animation. */
  timestamp: number;
  /** Distinguishes two reactions sent in the same millisecond. */
  id: string;
}

/** Ready Check progress while the video phase winds down (section 6). */
export interface ReadyState {
  videoEnded: Record<string, boolean>;
  readyToAdvance: Record<string, boolean>;
  ready: number;
  total: number;
  /** Epoch ms the 10s post-imposter grace expires, or null before it starts. */
  graceEndsAt: number | null;
}

/** Live turn state during the word phase (section 7). */
export interface TurnState {
  activePlayerId: string | null;
  turnTimeLeft: number;
  turnIndex: number;
  wordsUsed: Record<string, number>;
}

/** The single 90s chat+vote window (section 8). */
export interface DeliberationState {
  endsAt: number;
  durationSeconds: number;
  voteRound: number;
  /** Non-null while a tie is being re-voted; ballot is restricted to these. */
  revoteCandidates: string[] | null;
  /**
   * Who must recast. **null in an anonymous lobby**: being on this list means
   * you backed neither tied candidate, which is a fact about your ballot, so
   * publishing the roster would leak exactly what anonymity protects. Use
   * `canRecast` for your own eligibility — it is per-socket and always right.
   */
  eligibleVoters: string[] | null;
  /** Whether *this* player may recast. Null outside a re-vote. */
  canRecast: boolean | null;
}

export interface Preset {
  id: string;
  name: string;
  normalVideoUrl: string;
  imposterVideoUrl: string;
  userId: string;
  createdAt: string;
}

export type VideoType = 'youtube' | 'vimeo' | 'mp4' | 'unknown';

export interface ParsedVideo {
  type: VideoType;
  id: string | null;
  originalUrl: string;
  embedUrl: string | null;
}

// ─── Shop / cosmetics (spec section 10) ──────────────────────────────
// The three cosmetic slots the VHS shop sells, per
// vhs-frontend-example/home.html.
export type CosmeticCategory = 'tape-skin' | 'vcr-skin' | 'tape-label';

/**
 * Colours a skin repaints its preview with. A tape and a VCR share the shape
 * because their parts line up: the tape's spool window is the VCR's door
 * flap, the tape's spool gears are the VCR's status LED.
 */
export interface CosmeticPalette {
  /** Outer shell — may be a gradient. */
  body: string;
  border: string;
  tagBg: string;
  tagColor: string;
  /** Tape's paper label / VCR's LCD. */
  labelBg: string;
  labelBorder: string;
  titleColor: string;
  subColor: string;
  /** Tape's spool window / VCR's door flap. */
  innerBg: string;
  /** Spool bodies / VCR slot trim and buttons. */
  accentDark: string;
  /** Spool gears / VCR status LED. */
  accentBright: string;
}

/** A tape-label sticker: styling plus the two lines printed on it. */
export interface CosmeticSticker {
  bg: string;
  color: string;
  border: string;
  text: string;
  sub: string;
}

export interface ShopItem {
  id: string;
  name: string;
  category: CosmeticCategory;
  price: number;
  /** Short badge printed on the preview. */
  tag: string;
  /** Two-line readout on the preview's LCD. */
  title: string;
  subLeft: string;
  subRight: string;
  /** Set on tape-skin / vcr-skin items. */
  palette?: CosmeticPalette;
  /** Set on tape-label items. */
  sticker?: CosmeticSticker;
}

/** Which item is equipped in each slot; null means the stock look. */
export type EquippedCosmetics = Record<CosmeticCategory, string | null>;
