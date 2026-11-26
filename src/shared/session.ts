import type { HandState, PlayerActionType } from "./handEngine.ts";
import type { SettlementSummary } from "./settlement.ts";

export type SessionStatus = "ACTIVE" | "SETTLED";

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

export type FundingKind = "BUY_IN" | "REBUY" | "TOP_UP";
export type BuyInRequestStatus = "PENDING" | "APPROVED" | "REJECTED";
export type LedgerEntrySource = "REQUEST_APPROVAL" | "HOST_DIRECT";

export interface BuyInRequestView {
  id: string;
  seatNumber: number;
  playerId: string;
  displayName: string;
  kind: FundingKind;
  amountChips: number;
  status: BuyInRequestStatus;
  createdAt: string;
}

export interface LedgerEntryView {
  id: string;
  seatNumber: number;
  playerId: string;
  displayName: string;
  kind: FundingKind;
  amountChips: number;
  source: LedgerEntrySource;
  requestId: string | null;
  createdAt: string;
}

export type CashOutRequestStatus = "PENDING" | "APPROVED" | "REJECTED";
export type CashOutSource = "REQUEST_APPROVAL" | "HOST_DIRECT";

export interface CashOutRequestView {
  id: string;
  seatNumber: number;
  playerId: string;
  displayName: string;
  chips: number;
  totalBuyInChips: number;
  status: CashOutRequestStatus;
  createdAt: string;
}

export interface CashOutRecordView {
  id: string;
  seatNumber: number;
  playerId: string;
  displayName: string;
  totalBuyInChips: number;
  endingChips: number;
  source: CashOutSource;
  requestId: string | null;
  cashedOutAt: string;
}

export interface SeatOccupant {
  playerId: string;
  displayName: string;
  chips: number;
  totalBuyInChips: number;
  isConnected: boolean;
  hasPendingRelink: boolean;
  isSittingOut: boolean;
}

export interface SeatView {
  seatNumber: number;
  occupant: SeatOccupant | null;
}

export interface SessionSnapshot {
  code: string;
  status: SessionStatus;
  config: SessionConfig;
  seats: SeatView[];
  pendingRequests: BuyInRequestView[];
  pendingCashOutRequests: CashOutRequestView[];
  cashOuts: CashOutRecordView[];
  settlement: SettlementSummary | null;
  ledgerEntries: LedgerEntryView[];
  hand: HandState | null;
  handInProgress: boolean;
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

export interface CreateBuyInRequestInput {
  kind: FundingKind;
  amountChips: number;
  seatNumber?: number | undefined;
}

export interface CreateBuyInRequestResponse {
  request: BuyInRequestView;
  session: SessionSnapshot;
}

export interface ApproveBuyInRequestResponse {
  request: BuyInRequestView;
  ledgerEntry: LedgerEntryView;
  session: SessionSnapshot;
}

export interface RejectBuyInRequestResponse {
  request: BuyInRequestView;
  session: SessionSnapshot;
}

export interface RecordDirectLedgerInput {
  kind: FundingKind;
  amountChips: number;
}

export interface RecordDirectLedgerResponse {
  ledgerEntry: LedgerEntryView;
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

export interface SetSitOutInput {
  isSittingOut: boolean;
}

export interface SetSitOutResponse {
  session: SessionSnapshot;
}

export interface CreateCashOutRequestInput {
  seatNumber?: number | undefined;
}

export interface CreateCashOutRequestResponse {
  request: CashOutRequestView;
  session: SessionSnapshot;
}

export interface ApproveCashOutRequestResponse {
  request: CashOutRequestView;
  cashOut: CashOutRecordView;
  session: SessionSnapshot;
}

export interface RejectCashOutRequestResponse {
  request: CashOutRequestView;
  session: SessionSnapshot;
}

export interface DirectCashOutResponse {
  cashOut: CashOutRecordView;
  session: SessionSnapshot;
}

export interface SettleSessionResponse {
  settlement: SettlementSummary;
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

/**
 * Converts a Chip quantity into integer Cash minor units using the Session exchange rate.
 */
export function chipsToCashMinor(
  chips: number,
  config: Pick<SessionConfig, "exchangeRateChips" | "exchangeRateCashMinor">,
): number {
  const scaled = (Math.abs(chips) * config.exchangeRateCashMinor) / config.exchangeRateChips;
  return Math.sign(chips) * Math.round(scaled);
}

/**
 * Formats integer Cash minor units (e.g. cents) with the Session currency symbol.
 */
export function formatCashMinor(minorUnits: number, currencySymbol: string): string {
  const sign = minorUnits < 0 ? "-" : "";
  return `${sign}${currencySymbol}${(Math.abs(minorUnits) / 100).toFixed(2)}`;
}

/**
 * Formats a Chip quantity as its Cash obligation equivalent under the Session exchange rate.
 */
export function formatChipsAsCash(
  chips: number,
  config: Pick<SessionConfig, "exchangeRateChips" | "exchangeRateCashMinor" | "currencySymbol">,
): string {
  return formatCashMinor(chipsToCashMinor(chips, config), config.currencySymbol);
}

export interface FundingEligibilityContext {
  config: Pick<SessionConfig, "smallestChipStep" | "minBuyInChips" | "maxBuyInChips">;
  chips: number;
  totalBuyInChips: number;
  handInProgress?: boolean;
}

export type FundingValidationResult =
  | { ok: true; value: { kind: FundingKind; amountChips: number } }
  | { ok: false; reason: "VALIDATION" | "CONFLICT"; error: string };

export interface AvailableFundingOption {
  kind: FundingKind;
  label: string;
  minAmountChips: number;
  maxAmountChips: number | null;
  disabledReason: string | null;
}

const FUNDING_KIND_LABELS: Record<FundingKind, string> = {
  BUY_IN: "Buy-In",
  REBUY: "Rebuy",
  TOP_UP: "Top-Up",
};

function isFundingKind(value: unknown): value is FundingKind {
  return value === "BUY_IN" || value === "REBUY" || value === "TOP_UP";
}

function validateBounds(
  kindLabel: string,
  amountChips: number,
  minBuyInChips: number | null,
  maxBuyInChips: number | null,
): FundingValidationResult | null {
  if (minBuyInChips !== null && amountChips < minBuyInChips) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: `${kindLabel} must be at least ${minBuyInChips} Chips.`,
    };
  }
  if (maxBuyInChips !== null && amountChips > maxBuyInChips) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: `${kindLabel} cannot exceed ${maxBuyInChips} Chips.`,
    };
  }
  return null;
}

/**
 * Validates a Buy-In, Rebuy, or Top-Up request against Session rules and current Seat state.
 */
export function validateFundingOperation(
  input: unknown,
  ctx: FundingEligibilityContext,
): FundingValidationResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "VALIDATION", error: "Funding payload must be an object." };
  }
  const raw = input as Record<string, unknown>;
  if (!isFundingKind(raw.kind)) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: "Funding kind must be BUY_IN, REBUY, or TOP_UP.",
    };
  }
  if (!isPositiveInt(raw.amountChips)) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: "Amount must be a positive integer in Chips.",
    };
  }
  const amountChips = raw.amountChips;
  const { smallestChipStep, minBuyInChips, maxBuyInChips } = ctx.config;
  if (!isStepMultiple(amountChips, smallestChipStep)) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: `Amount must be a multiple of the smallest Chip step (${smallestChipStep}).`,
    };
  }

  const handInProgress = ctx.handInProgress ?? false;

  if (raw.kind === "BUY_IN") {
    if (ctx.totalBuyInChips > 0 || ctx.chips > 0) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Seat already has an initial Buy-In; use Rebuy or Top-Up.",
      };
    }
    const boundsError = validateBounds("Buy-In", amountChips, minBuyInChips, maxBuyInChips);
    if (boundsError) {
      return boundsError;
    }
    return { ok: true, value: { kind: "BUY_IN", amountChips } };
  }

  if (raw.kind === "REBUY") {
    if (handInProgress) {
      return { ok: false, reason: "CONFLICT", error: "Rebuy is only allowed between Hands." };
    }
    if (ctx.chips !== 0) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Rebuy is only allowed when stack is zero Chips.",
      };
    }
    if (ctx.totalBuyInChips === 0) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Initial Buy-In is required before taking a Rebuy.",
      };
    }
    const boundsError = validateBounds("Rebuy", amountChips, minBuyInChips, maxBuyInChips);
    if (boundsError) {
      return boundsError;
    }
    return { ok: true, value: { kind: "REBUY", amountChips } };
  }

  if (handInProgress) {
    return { ok: false, reason: "CONFLICT", error: "Top-Up is only allowed between Hands." };
  }
  if (ctx.chips <= 0) {
    return {
      ok: false,
      reason: "CONFLICT",
      error: "Top-Up requires a non-zero Chip stack.",
    };
  }
  if (maxBuyInChips !== null && ctx.chips + amountChips > maxBuyInChips) {
    return {
      ok: false,
      reason: "CONFLICT",
      error: `Top-Up cannot raise stack above the Session max Buy-In (${maxBuyInChips} Chips).`,
    };
  }
  return { ok: true, value: { kind: "TOP_UP", amountChips } };
}

/**
 * Determines the currently eligible funding action and Chip bounds for an occupied Seat.
 */
export function getAvailableFundingForSeat(
  ctx: FundingEligibilityContext,
): AvailableFundingOption {
  const { smallestChipStep, minBuyInChips, maxBuyInChips } = ctx.config;
  const handInProgress = ctx.handInProgress ?? false;

  if (ctx.chips === 0 && ctx.totalBuyInChips === 0) {
    return {
      kind: "BUY_IN",
      label: FUNDING_KIND_LABELS.BUY_IN,
      minAmountChips: minBuyInChips ?? smallestChipStep,
      maxAmountChips: maxBuyInChips,
      disabledReason: null,
    };
  }

  if (ctx.chips === 0) {
    return {
      kind: "REBUY",
      label: FUNDING_KIND_LABELS.REBUY,
      minAmountChips: minBuyInChips ?? smallestChipStep,
      maxAmountChips: maxBuyInChips,
      disabledReason: handInProgress ? "Rebuy is only allowed between Hands." : null,
    };
  }

  const remainingMax =
    maxBuyInChips !== null ? Math.max(0, maxBuyInChips - ctx.chips) : null;
  let disabledReason: string | null = null;
  if (handInProgress) {
    disabledReason = "Top-Up is only allowed between Hands.";
  } else if (remainingMax !== null && remainingMax < smallestChipStep) {
    disabledReason = `Stack is already at the Session max Buy-In (${maxBuyInChips} Chips).`;
  }

  return {
    kind: "TOP_UP",
    label: FUNDING_KIND_LABELS.TOP_UP,
    minAmountChips: smallestChipStep,
    maxAmountChips: remainingMax,
    disabledReason,
  };
}
