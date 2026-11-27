import type { HandState, PlayerActionType } from "./handEngine.ts";
import type { LeaderboardSummary } from "./leaderboard.ts";

export type SessionStatus = "ACTIVE" | "SETTLED";

export interface SessionConfig {
  seatCount: number;
  startingStackChips: number;
  smallBlind: number;
  bigBlind: number;
}

export interface CreateSessionInput {
  seatCount: number;
  startingStackChips: number;
  smallBlind: number;
  bigBlind: number;
}

export interface SeatOccupant {
  playerId: string;
  displayName: string;
  chips: number;
  totalBuyInChips: number;
  rebuyCount: number;
  isConnected: boolean;
  isSittingOut: boolean;
}

export interface DepartedPlayerRecord {
  id: string;
  seatNumber: number;
  playerId: string;
  displayName: string;
  totalIssuedChips: number;
  rebuyCount: number;
  endingChips: number;
  departedAt: string;
}

export interface SeatView {
  seatNumber: number;
  occupant: SeatOccupant | null;
}

export interface SessionStats {
  handsPlayed: number;
  biggestPotChips: number;
  biggestHandNumber: number | null;
}

export interface SessionSnapshot {
  code: string;
  status: SessionStatus;
  config: SessionConfig;
  seats: SeatView[];
  departedPlayers: DepartedPlayerRecord[];
  leaderboard: LeaderboardSummary;
  hand: HandState | null;
  handInProgress: boolean;
  canUndo: boolean;
  /** Completed Hands ordered newest-first (`handNumber` descending). */
  handHistory: HandState[];
  sessionStats: SessionStats;
}

export interface ViewerIdentity {
  isHost: boolean;
  seatNumber: number | null;
  playerId: string | null;
}

export interface CreateSessionResponse {
  hostToken: string;
  sharePath: string;
  shareUrl: string;
  qrCodeDataUrl: string;
  session: SessionSnapshot;
}

export interface ClaimSeatInput {
  seatNumber: number;
  displayName: string;
}

export interface ClaimSeatResponse {
  seatToken: string;
  playerId: string;
  seatNumber: number;
  session: SessionSnapshot;
}

export interface GetSessionResponse {
  sharePath: string;
  shareUrl: string;
  qrCodeDataUrl: string;
  session: SessionSnapshot;
  viewer: ViewerIdentity;
}

export function normalizeSessionCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface ReleaseSeatResponse {
  session: SessionSnapshot;
}

export interface RebuySeatResponse {
  session: SessionSnapshot;
}

export interface LeaveSeatResponse {
  session: SessionSnapshot;
}

export interface StartHandResponse {
  hand: HandState;
  session: SessionSnapshot;
}

export interface SubmitHandActionInput {
  seatNumber?: number | undefined;
  action: PlayerActionType;
  amountChips?: number | undefined;
}

export interface SubmitHandActionResponse {
  hand: HandState;
  session: SessionSnapshot;
}

export interface ResolveShowdownInput {
  winnerSeatNumbers: number[];
  potId?: string | undefined;
}

export interface ResolveShowdownResponse {
  hand: HandState;
  session: SessionSnapshot;
}

export interface UndoHandResponse {
  hand: HandState;
  session: SessionSnapshot;
}

export interface GetSessionHandsResponse {
  /** Completed Hands ordered newest-first (`handNumber` descending). */
  hands: HandState[];
  sessionStats: SessionStats;
}

export interface SetSitOutInput {
  isSittingOut: boolean;
}

export interface SetSitOutResponse {
  session: SessionSnapshot;
}

export interface EndGameResponse {
  leaderboard: LeaderboardSummary;
  session: SessionSnapshot;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateClaimSeatInput(
  input: unknown,
  seatCount: number,
): ValidationResult<ClaimSeatInput> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Claim Seat payload must be an object." };
  }
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.seatNumber !== "number" ||
    !Number.isInteger(raw.seatNumber) ||
    raw.seatNumber < 1 ||
    raw.seatNumber > seatCount
  ) {
    return { ok: false, error: `Seat number must be between 1 and ${seatCount}.` };
  }
  if (typeof raw.displayName !== "string") {
    return { ok: false, error: "Display name is required." };
  }
  const displayName = raw.displayName.trim();
  if (displayName.length < 1 || displayName.length > 30) {
    return { ok: false, error: "Display name must be between 1 and 30 characters." };
  }
  return { ok: true, value: { seatNumber: raw.seatNumber, displayName } };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Normalizes persisted SessionConfig records to the simplified play-Chip config shape.
 */
export function normalizeSessionConfig(
  raw: Partial<SessionConfig> & { seatCount: number; smallBlind: number; bigBlind: number },
): SessionConfig {
  return {
    seatCount: raw.seatCount,
    startingStackChips: isPositiveInt(raw.startingStackChips) ? raw.startingStackChips : 1000,
    smallBlind: raw.smallBlind,
    bigBlind: raw.bigBlind,
  };
}

/**
 * Validates and normalizes simplified Session creation configuration.
 * Omitted fields fall back to casual play defaults (8 Seats, 1000 Starting Stack, 10/20 Blinds).
 */
export function validateSessionConfig(input: unknown): ValidationResult<SessionConfig> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Session configuration must be an object." };
  }

  const raw = input as Record<string, unknown>;
  const seatCount = raw.seatCount === undefined ? 8 : raw.seatCount;
  const startingStackChips =
    raw.startingStackChips === undefined ? 1000 : raw.startingStackChips;
  const smallBlind = raw.smallBlind === undefined ? 10 : raw.smallBlind;
  const bigBlind = raw.bigBlind === undefined ? 20 : raw.bigBlind;

  if (
    typeof seatCount !== "number" ||
    !Number.isInteger(seatCount) ||
    seatCount < 2 ||
    seatCount > 10
  ) {
    return { ok: false, error: "Seat count must be an integer between 2 and 10." };
  }

  if (!isPositiveInt(startingStackChips)) {
    return { ok: false, error: "Starting Stack must be an integer of at least 1 Chip." };
  }

  if (!isPositiveInt(smallBlind)) {
    return { ok: false, error: "Small Blind must be an integer of at least 1 Chip." };
  }

  if (!isPositiveInt(bigBlind) || bigBlind < smallBlind) {
    return { ok: false, error: "Big Blind must be an integer at least equal to Small Blind." };
  }

  return {
    ok: true,
    value: {
      seatCount,
      startingStackChips,
      smallBlind,
      bigBlind,
    },
  };
}
