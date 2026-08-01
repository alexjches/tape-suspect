// src/types/index.ts
// Shared types used across frontend and backend

// Phase flow per docs/BUILD-PLAN.md sections 6-8:
//   playing      video + Ready Check
//   words        turn-based word phase, 10s each
//   deliberation ONE 90s window, chat and voting live simultaneously
export type GamePhase = 'lobby' | 'playing' | 'words' | 'deliberation' | 'results';

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
  /** Who supplied the Custom links, and so sits out a Custom round (§4). */
  customVideoAuthorId: string | null;
  players: PlayerPublic[];
  settings: {
    isPublic: boolean;
    maxPlayers: number;
    hasNormalVideo: boolean;
    hasImposterVideo: boolean;
    wordsPerPlayer: number;
    imposterCount: number;
    chatType: ChatType;
    voteVisibility: VoteVisibility;
    videoCategory: string | null;
  };
  /**
   * Voter -> target. Empty in an anonymous lobby, where individual ballots
   * are never published — check `settings.voteVisibility` before reading it
   * rather than inferring "nobody has voted" from an empty object.
   */
  votes: Record<string, string>;
  createdAt: number;
}

// Spec section 3: role is hidden from the player for the whole round —
// there is deliberately no `isImposter` here. A client that knows its own
// role can read it out of devtools, which defeats the core mechanic. The
// role is only ever revealed in GameResults, after voting closes.
export interface GameAssignment {
  videoUrl: string;
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
  normalVideoUrl: string;
  imposterVideoUrl: string;
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
