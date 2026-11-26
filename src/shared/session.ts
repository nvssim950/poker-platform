export interface SessionConfig {
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  smallestChipStep: number;
  currencySymbol: string;
  exchangeRateChips: number;
  exchangeRateCashMinor: number;
  minBuyInChips: number | null;
  maxBuyInChips: number | null;
}

export interface CreateSessionInput {
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  smallestChipStep: number;
  currencySymbol: string;
  exchangeRateChips: number;
  exchangeRateCashMinor: number;
  minBuyInChips?: number | null | undefined;
  maxBuyInChips?: number | null | undefined;
}

export interface SeatOccupant {
  playerId: string;
  displayName: string;
  chips: number;
  isConnected: boolean;
  hasPendingRelink: boolean;
}

export interface SeatView {
  seatNumber: number;
  occupant: SeatOccupant | null;
}

export interface SessionSnapshot {
  code: string;
  config: SessionConfig;
  seats: SeatView[];
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

export interface RelinkSeatResponse {
  relinkCode: string;
  relinkPath: string;
  relinkUrl: string;
  qrCodeDataUrl: string;
  session: SessionSnapshot;
}

export interface ReleaseSeatResponse {
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

function isStepMultiple(value: number, step: number): boolean {
  return value % step === 0;
}

/**
 * Validates and normalizes Session creation configuration against tabletop domain invariants.
 */
export function validateSessionConfig(input: unknown): ValidationResult<SessionConfig> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Session configuration must be an object." };
  }

  const raw = input as Record<string, unknown>;

  if (typeof raw.seatCount !== "number" || !Number.isInteger(raw.seatCount) || raw.seatCount < 2 || raw.seatCount > 10) {
    return { ok: false, error: "Seat count must be an integer between 2 and 10." };
  }

  if (!isPositiveInt(raw.smallestChipStep)) {
    return { ok: false, error: "Smallest Chip step must be an integer of at least 1." };
  }

  const step = raw.smallestChipStep;

  if (!isPositiveInt(raw.smallBlind) || !isStepMultiple(raw.smallBlind, step)) {
    return { ok: false, error: "Small Blind must be a positive multiple of the smallest Chip step." };
  }

  if (!isPositiveInt(raw.bigBlind) || raw.bigBlind < raw.smallBlind || !isStepMultiple(raw.bigBlind, step)) {
    return { ok: false, error: "Big Blind must be at least Small Blind and a multiple of the smallest Chip step." };
  }

  if (typeof raw.currencySymbol !== "string") {
    return { ok: false, error: "Currency symbol is required." };
  }
  const currencySymbol = raw.currencySymbol.trim();
  if (currencySymbol.length < 1 || currencySymbol.length > 8) {
    return { ok: false, error: "Currency symbol must be 1 to 8 characters." };
  }

  if (!isPositiveInt(raw.exchangeRateChips) || !isPositiveInt(raw.exchangeRateCashMinor)) {
    return { ok: false, error: "Exchange rate Chips and Cash minor units must be positive integers." };
  }

  const minRaw = raw.minBuyInChips ?? null;
  const maxRaw = raw.maxBuyInChips ?? null;

  if (minRaw !== null && (!isPositiveInt(minRaw) || !isStepMultiple(minRaw, step))) {
    return { ok: false, error: "Min Buy-In must be a positive multiple of the smallest Chip step." };
  }

  if (maxRaw !== null && (!isPositiveInt(maxRaw) || !isStepMultiple(maxRaw, step))) {
    return { ok: false, error: "Max Buy-In must be a positive multiple of the smallest Chip step." };
  }

  if (minRaw !== null && maxRaw !== null && minRaw > maxRaw) {
    return { ok: false, error: "Min Buy-In cannot exceed Max Buy-In." };
  }

  return {
    ok: true,
    value: {
      seatCount: raw.seatCount,
      smallBlind: raw.smallBlind,
      bigBlind: raw.bigBlind,
      smallestChipStep: step,
      currencySymbol,
      exchangeRateChips: raw.exchangeRateChips,
      exchangeRateCashMinor: raw.exchangeRateCashMinor,
      minBuyInChips: minRaw,
      maxBuyInChips: maxRaw,
    },
  };
}
