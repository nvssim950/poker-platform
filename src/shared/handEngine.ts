import type { SeatView, SessionConfig } from "./session.ts";

export type Street = "PREFLOP" | "FLOP" | "TURN" | "RIVER";
export type HandStatus = "BETTING" | "SHOWDOWN" | "COMPLETE";
export type PlayerActionType =
  | "FOLD"
  | "CHECK"
  | "CALL"
  | "BET"
  | "RAISE"
  | "ALL_IN";

export interface HandSeatState {
  seatNumber: number;
  playerId: string;
  displayName: string;
  startingChips: number;
  chips: number;
  streetCommittedChips: number;
  totalCommittedChips: number;
  hasFolded: boolean;
  isAllIn: boolean;
  hasActedThisStreet: boolean;
  hasActedSinceFullRaise: boolean;
}

export interface HandPot {
  id: string;
  label: string;
  amountChips: number;
  eligibleSeatNumbers: number[];
  winnerSeatNumbers: number[] | null;
}

export interface PotAwardView {
  potId: string;
  potLabel: string;
  seatNumber: number;
  playerId: string;
  displayName: string;
  amountChips: number;
  oddChips: number;
}

export interface UncalledReturnView {
  seatNumber: number;
  playerId: string;
  displayName: string;
  amountChips: number;
}

export interface HandActionRecord {
  index: number;
  street: Street;
  seatNumber: number;
  playerId: string;
  displayName: string;
  action: PlayerActionType;
  amountChips: number;
  addedChips: number;
  byHostProxy: boolean;
}

export interface HandResult {
  reason: "FOLD_WIN" | "SHOWDOWN";
  totalPotChips: number;
  awards: PotAwardView[];
  uncalledReturned: UncalledReturnView | null;
}

export interface HandState {
  handNumber: number;
  status: HandStatus;
  street: Street;
  buttonSeatNumber: number;
  sbSeatNumber: number;
  bbSeatNumber: number;
  isHeadsUp: boolean;
  actingSeatNumber: number | null;
  potChips: number;
  currentBet: number;
  lastFullRaiseBet: number;
  lastFullRaiseIncrement: number;
  seats: HandSeatState[];
  pots: HandPot[];
  actionHistory: HandActionRecord[];
  lastUncalledReturned: UncalledReturnView | null;
  result: HandResult | null;
}

export interface LegalActionsInfo {
  seatNumber: number;
  toCall: number;
  currentBet: number;
  totalPotChips: number;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callChips: number;
  callIsAllIn: boolean;
  canBet: boolean;
  minBetTo: number | null;
  maxBetTo: number | null;
  canRaise: boolean;
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
  canAllIn: boolean;
  allInTo: number | null;
  allInAddedChips: number | null;
}

export interface QuickWagerPresets {
  min: number;
  halfPot: number;
  pot: number;
  allIn: number;
}

export type HandEngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "VALIDATION" | "CONFLICT"; error: string };

export interface EligibleHandSeat {
  seatNumber: number;
  playerId: string;
  displayName: string;
  chips: number;
}

const STREET_ORDER: readonly Street[] = ["PREFLOP", "FLOP", "TURN", "RIVER"];

/**
 * Returns clockwise distance strictly left of the Button (1 = immediate left of Button, seatCount = Button).
 */
export function clockwiseLeftOfButtonOffset(
  seatNumber: number,
  buttonSeatNumber: number,
  seatCount: number,
): number {
  return ((seatNumber - buttonSeatNumber - 1 + seatCount) % seatCount) + 1;
}

function clockwiseFromAnchorOffset(
  seatNumber: number,
  anchorSeatNumber: number,
  seatCount: number,
): number {
  return seatNumber === anchorSeatNumber
    ? 0
    : clockwiseLeftOfButtonOffset(seatNumber, anchorSeatNumber, seatCount);
}

/**
 * Returns occupied Seats that hold Chips and are ready to be dealt into the next Hand.
 */
export function getEligibleSeatsForNewHand(sessionSeats: readonly SeatView[]): EligibleHandSeat[] {
  return sessionSeats
    .filter(
      (s): s is { seatNumber: number; occupant: NonNullable<SeatView["occupant"]> } =>
        s.occupant !== null && s.occupant.chips > 0 && !s.occupant.isSittingOut,
    )
    .map((s) => ({
      seatNumber: s.seatNumber,
      playerId: s.occupant.playerId,
      displayName: s.occupant.displayName,
      chips: s.occupant.chips,
    }))
    .sort((a, b) => a.seatNumber - b.seatNumber);
}

/**
 * Selects the next Moving Button Seat clockwise among funded active Seats.
 */
export function determineNextButtonSeat(
  eligibleSeatNumbers: readonly number[],
  previousButtonSeatNumber: number | null,
): number {
  const sorted = [...eligibleSeatNumbers].sort((a, b) => a - b);
  const first = sorted[0];
  if (first === undefined) {
    throw new Error("Cannot determine Button without eligible Seats.");
  }
  if (previousButtonSeatNumber === null) {
    return first;
  }
  return sorted.find((seatNumber) => seatNumber > previousButtonSeatNumber) ?? first;
}

/**
 * Normalizes persisted HandState snapshots by stripping legacy house-rule fields.
 */
export function normalizeHandState(raw: HandState): HandState {
  return {
    handNumber: raw.handNumber,
    status: raw.status,
    street: raw.street,
    buttonSeatNumber: raw.buttonSeatNumber,
    sbSeatNumber: raw.sbSeatNumber,
    bbSeatNumber: raw.bbSeatNumber,
    isHeadsUp: raw.isHeadsUp,
    actingSeatNumber: raw.actingSeatNumber,
    potChips: raw.potChips,
    currentBet: raw.currentBet,
    lastFullRaiseBet: raw.lastFullRaiseBet,
    lastFullRaiseIncrement: raw.lastFullRaiseIncrement,
    seats: raw.seats.map((s) => ({
      seatNumber: s.seatNumber,
      playerId: s.playerId,
      displayName: s.displayName,
      startingChips: s.startingChips,
      chips: s.chips,
      streetCommittedChips: s.streetCommittedChips,
      totalCommittedChips: s.totalCommittedChips,
      hasFolded: s.hasFolded,
      isAllIn: s.isAllIn,
      hasActedThisStreet: s.hasActedThisStreet,
      hasActedSinceFullRaise: s.hasActedSinceFullRaise,
    })),
    pots: raw.pots,
    actionHistory: raw.actionHistory,
    lastUncalledReturned: raw.lastUncalledReturned,
    result: raw.result,
  };
}

/**
 * Computes the total live Chips currently in the Pot (center pot plus current Street wagers).
 */
export function getTotalPotChips(hand: HandState): number {
  if (hand.status === "COMPLETE") {
    return 0;
  }
  const streetTotal = hand.seats.reduce((sum, seat) => sum + seat.streetCommittedChips, 0);
  return hand.potChips + streetTotal;
}

/**
 * Computes integer quick-bet/raise targets (Min, ½ Pot, Pot, All-In) clamped within legal bounds.
 */
export function computeQuickWagerPresets(legal: LegalActionsInfo): QuickWagerPresets | null {
  if (!legal.canBet && !legal.canRaise) {
    return null;
  }
  const min = legal.canBet ? legal.minBetTo : legal.minRaiseTo;
  const max = legal.canBet ? legal.maxBetTo : legal.maxRaiseTo;
  if (min === null || max === null) {
    return null;
  }
  const clamp = (raw: number): number => Math.min(max, Math.max(min, Math.round(raw)));
  if (legal.canBet) {
    return {
      min,
      halfPot: clamp(legal.totalPotChips / 2),
      pot: clamp(legal.totalPotChips),
      allIn: max,
    };
  }
  const potAfterCall = legal.totalPotChips + legal.toCall;
  return {
    min,
    halfPot: clamp(legal.currentBet + potAfterCall / 2),
    pot: clamp(legal.currentBet + potAfterCall),
    allIn: max,
  };
}

/**
 * Returns true while a Hand is actively running (betting or awaiting Showdown resolution).
 */
export function isHandInProgress(hand: HandState | null | undefined): boolean {
  return hand !== null && hand !== undefined && hand.status !== "COMPLETE";
}

function cloneHandState(hand: HandState): HandState {
  return {
    ...hand,
    seats: hand.seats.map((s) => ({ ...s })),
    pots: hand.pots.map((p) => ({
      ...p,
      eligibleSeatNumbers: [...p.eligibleSeatNumbers],
      winnerSeatNumbers: p.winnerSeatNumbers ? [...p.winnerSeatNumbers] : null,
    })),
    actionHistory: hand.actionHistory.map((a) => ({ ...a })),
    lastUncalledReturned: hand.lastUncalledReturned ? { ...hand.lastUncalledReturned } : null,
    result: hand.result
      ? {
          ...hand.result,
          awards: hand.result.awards.map((a) => ({ ...a })),
          uncalledReturned: hand.result.uncalledReturned
            ? { ...hand.result.uncalledReturned }
            : null,
        }
      : null,
  };
}

function getSeat(hand: HandState, seatNumber: number): HandSeatState | undefined {
  return hand.seats.find((s) => s.seatNumber === seatNumber);
}

function orderSeatsStartingAt(
  seats: readonly HandSeatState[],
  anchorSeatNumber: number,
  seatCount: number,
): HandSeatState[] {
  return [...seats].sort(
    (a, b) =>
      clockwiseFromAnchorOffset(a.seatNumber, anchorSeatNumber, seatCount) -
      clockwiseFromAnchorOffset(b.seatNumber, anchorSeatNumber, seatCount),
  );
}

function orderSeatsLeftOfButton(
  seats: readonly HandSeatState[],
  buttonSeatNumber: number,
  seatCount: number,
): HandSeatState[] {
  return [...seats].sort(
    (a, b) =>
      clockwiseLeftOfButtonOffset(a.seatNumber, buttonSeatNumber, seatCount) -
      clockwiseLeftOfButtonOffset(b.seatNumber, buttonSeatNumber, seatCount),
  );
}

function findFirstEligibleActorFrom(
  seats: readonly HandSeatState[],
  startSeatNumber: number,
  seatCount: number,
  includeStartSeat: boolean,
): number | null {
  const ordered = includeStartSeat
    ? orderSeatsStartingAt(seats, startSeatNumber, seatCount)
    : orderSeatsLeftOfButton(seats, startSeatNumber, seatCount);
  const next = ordered.find((s) => !s.hasFolded && !s.isAllIn && s.chips > 0);
  return next ? next.seatNumber : null;
}

function isStreetBettingClosed(hand: HandState): boolean {
  const contenders = hand.seats.filter((s) => !s.hasFolded);
  if (contenders.length <= 1) {
    return true;
  }
  const canActSeats = contenders.filter((s) => !s.isAllIn && s.chips > 0);
  if (canActSeats.length === 0) {
    return true;
  }
  if (canActSeats.length === 1) {
    return canActSeats[0]!.streetCommittedChips >= hand.currentBet;
  }
  return canActSeats.every(
    (s) => s.hasActedThisStreet && s.streetCommittedChips === hand.currentBet,
  );
}

function slicePotsByLevels(
  seats: readonly HandSeatState[],
  levels: readonly number[],
  liveBettingMode: boolean,
): HandPot[] {
  const nonFolded = seats.filter((s) => !s.hasFolded);
  const pots: HandPot[] = [];
  let prevLevel = 0;

  for (const level of levels) {
    let sliceAmount = 0;
    for (const seat of seats) {
      if (seat.totalCommittedChips > prevLevel) {
        sliceAmount += Math.min(seat.totalCommittedChips, level) - prevLevel;
      }
    }
    const eligibleSeatNumbers = liveBettingMode
      ? pots.length === 0
        ? nonFolded.map((s) => s.seatNumber)
        : nonFolded
            .filter((s) => s.totalCommittedChips > prevLevel)
            .map((s) => s.seatNumber)
      : nonFolded
          .filter((s) => s.totalCommittedChips >= level)
          .map((s) => s.seatNumber);

    if (sliceAmount > 0 && eligibleSeatNumbers.length > 0) {
      const potIndex = pots.length;
      pots.push({
        id: potIndex === 0 ? "main" : `side-${potIndex}`,
        label: potIndex === 0 ? "Main Pot" : `Side Pot ${potIndex}`,
        amountChips: sliceAmount,
        eligibleSeatNumbers,
        winnerSeatNumbers: null,
      });
    }
    prevLevel = level;
  }

  return pots;
}

/**
 * Slices total Hand commitments into Main Pot and any Side Pots for Showdown resolution.
 */
export function buildShowdownPots(seats: readonly HandSeatState[]): HandPot[] {
  const nonFolded = seats.filter((s) => !s.hasFolded);
  const distinctLevels = Array.from(
    new Set(nonFolded.map((s) => s.totalCommittedChips).filter((amt) => amt > 0)),
  ).sort((a, b) => a - b);

  return slicePotsByLevels(seats, distinctLevels, false);
}

/**
 * Computes live Main Pot and Side Pots during betting, or returns authoritative Showdown/Complete Pots.
 */
export function getLivePots(hand: HandState): HandPot[] {
  if (hand.status !== "BETTING") {
    return hand.pots.map((p) => ({
      ...p,
      eligibleSeatNumbers: [...p.eligibleSeatNumbers],
      winnerSeatNumbers: p.winnerSeatNumbers ? [...p.winnerSeatNumbers] : null,
    }));
  }

  const nonFolded = hand.seats.filter((s) => !s.hasFolded);
  if (nonFolded.length === 0) {
    return [];
  }

  const maxCommitted = Math.max(0, ...nonFolded.map((s) => s.totalCommittedChips));
  if (maxCommitted === 0) {
    return [];
  }

  const allInCaps = Array.from(
    new Set(
      nonFolded
        .filter((s) => s.isAllIn && s.totalCommittedChips > 0)
        .map((s) => s.totalCommittedChips),
    ),
  ).sort((a, b) => a - b);

  const levels = [...allInCaps];
  if (levels.length === 0 || levels[levels.length - 1]! < maxCommitted) {
    levels.push(maxCommitted);
  }

  return slicePotsByLevels(hand.seats, levels, true);
}

function returnUncalledStreetExcess(hand: HandState): UncalledReturnView | null {
  let highest = 0;
  for (const seat of hand.seats) {
    if (seat.streetCommittedChips > highest) {
      highest = seat.streetCommittedChips;
    }
  }
  if (highest === 0) {
    return null;
  }
  const leaders = hand.seats.filter((s) => s.streetCommittedChips === highest);
  if (leaders.length !== 1) {
    return null;
  }
  const leader = leaders[0]!;
  let secondHighest = 0;
  for (const seat of hand.seats) {
    if (seat.seatNumber !== leader.seatNumber && seat.streetCommittedChips > secondHighest) {
      secondHighest = seat.streetCommittedChips;
    }
  }
  const uncalled = highest - secondHighest;
  if (uncalled <= 0) {
    return null;
  }

  leader.chips += uncalled;
  leader.streetCommittedChips -= uncalled;
  leader.totalCommittedChips -= uncalled;
  leader.isAllIn = leader.chips === 0 && !leader.hasFolded;

  return {
    seatNumber: leader.seatNumber,
    playerId: leader.playerId,
    displayName: leader.displayName,
    amountChips: uncalled,
  };
}

function sweepStreetIntoPot(hand: HandState): void {
  let swept = 0;
  for (const seat of hand.seats) {
    swept += seat.streetCommittedChips;
    seat.streetCommittedChips = 0;
  }
  hand.potChips += swept;
}

function settleClosedStreet(hand: HandState, config: SessionConfig): void {
  const uncalled = returnUncalledStreetExcess(hand);
  if (uncalled) {
    hand.lastUncalledReturned = uncalled;
  }
  sweepStreetIntoPot(hand);

  const contenders = hand.seats.filter((s) => !s.hasFolded);
  if (contenders.length === 1) {
    const winner = contenders[0]!;
    const awardedPot = hand.potChips;
    winner.chips += awardedPot;
    hand.potChips = 0;
    hand.status = "COMPLETE";
    hand.actingSeatNumber = null;
    hand.currentBet = 0;
    hand.lastFullRaiseBet = 0;
    hand.pots = [
      {
        id: "main",
        label: "Main Pot",
        amountChips: awardedPot,
        eligibleSeatNumbers: [winner.seatNumber],
        winnerSeatNumbers: [winner.seatNumber],
      },
    ];
    hand.result = {
      reason: "FOLD_WIN",
      totalPotChips: awardedPot,
      awards: [
        {
          potId: "main",
          potLabel: "Main Pot",
          seatNumber: winner.seatNumber,
          playerId: winner.playerId,
          displayName: winner.displayName,
          amountChips: awardedPot,
          oddChips: 0,
        },
      ],
      uncalledReturned: hand.lastUncalledReturned,
    };
    return;
  }

  const canContinueBetting = contenders.filter((s) => !s.isAllIn && s.chips > 0).length >= 2;
  const currentStreetIndex = STREET_ORDER.indexOf(hand.street);

  if (hand.street === "RIVER" || !canContinueBetting) {
    hand.street = "RIVER";
    hand.status = "SHOWDOWN";
    hand.actingSeatNumber = null;
    hand.currentBet = 0;
    hand.lastFullRaiseBet = 0;
    hand.lastFullRaiseIncrement = config.bigBlind;
    hand.pots = buildShowdownPots(hand.seats);

    const autoAwards: PotAwardView[] = [];
    for (const pot of hand.pots) {
      if (pot.eligibleSeatNumbers.length !== 1) {
        continue;
      }
      const winnerSeatNumber = pot.eligibleSeatNumbers[0]!;
      const winnerSeat = getSeat(hand, winnerSeatNumber);
      if (!winnerSeat) {
        continue;
      }
      winnerSeat.chips += pot.amountChips;
      pot.winnerSeatNumbers = [winnerSeatNumber];
      hand.potChips = Math.max(0, hand.potChips - pot.amountChips);
      autoAwards.push({
        potId: pot.id,
        potLabel: pot.label,
        seatNumber: winnerSeat.seatNumber,
        playerId: winnerSeat.playerId,
        displayName: winnerSeat.displayName,
        amountChips: pot.amountChips,
        oddChips: 0,
      });
    }

    const totalPotChips = hand.pots.reduce((sum, p) => sum + p.amountChips, 0);
    const remainingUnresolved = hand.pots.some((p) => p.winnerSeatNumbers === null);
    if (!remainingUnresolved) {
      hand.potChips = 0;
      hand.status = "COMPLETE";
      hand.result = {
        reason: "SHOWDOWN",
        totalPotChips,
        awards: autoAwards,
        uncalledReturned: hand.lastUncalledReturned,
      };
    } else if (autoAwards.length > 0) {
      hand.result = {
        reason: "SHOWDOWN",
        totalPotChips,
        awards: autoAwards,
        uncalledReturned: hand.lastUncalledReturned,
      };
    }
    return;
  }

  const nextStreet = STREET_ORDER[currentStreetIndex + 1]!;
  hand.street = nextStreet;
  hand.status = "BETTING";
  hand.currentBet = 0;
  hand.lastFullRaiseBet = 0;
  hand.lastFullRaiseIncrement = config.bigBlind;
  for (const seat of hand.seats) {
    seat.hasActedThisStreet = false;
    seat.hasActedSinceFullRaise = false;
  }
  hand.actingSeatNumber = findFirstEligibleActorFrom(
    hand.seats,
    hand.buttonSeatNumber,
    config.seatCount,
    false,
  );
}

/**
 * Starts a new No-Limit Hold'em Hand, rotating the Moving Button and posting blinds.
 */
export function startHand(params: {
  handNumber: number;
  config: SessionConfig;
  seats: readonly SeatView[];
  previousButtonSeatNumber: number | null;
}): HandEngineResult<HandState> {
  const eligible = getEligibleSeatsForNewHand(params.seats);
  if (eligible.length < 2) {
    return {
      ok: false,
      reason: "CONFLICT",
      error: "At least 2 funded active Seats are required to start a Hand.",
    };
  }

  const buttonSeatNumber = determineNextButtonSeat(
    eligible.map((s) => s.seatNumber),
    params.previousButtonSeatNumber,
  );
  const isHeadsUp = eligible.length === 2;

  const initialSeats: HandSeatState[] = eligible.map((s) => ({
    seatNumber: s.seatNumber,
    playerId: s.playerId,
    displayName: s.displayName,
    startingChips: s.chips,
    chips: s.chips,
    streetCommittedChips: 0,
    totalCommittedChips: 0,
    hasFolded: false,
    isAllIn: false,
    hasActedThisStreet: false,
    hasActedSinceFullRaise: false,
  }));

  const ordered = orderSeatsStartingAt(initialSeats, buttonSeatNumber, params.config.seatCount);
  const sbSeat = isHeadsUp ? ordered[0]! : ordered[1]!;
  const bbSeat = isHeadsUp ? ordered[1]! : ordered[2]!;
  const firstPreflopSeat = isHeadsUp ? ordered[0]! : ordered[3 % ordered.length]!;

  const sbPosted = Math.min(sbSeat.chips, params.config.smallBlind);
  sbSeat.chips -= sbPosted;
  sbSeat.streetCommittedChips += sbPosted;
  sbSeat.totalCommittedChips += sbPosted;
  if (sbSeat.chips === 0) {
    sbSeat.isAllIn = true;
  }

  const bbPosted = Math.min(bbSeat.chips, params.config.bigBlind);
  bbSeat.chips -= bbPosted;
  bbSeat.streetCommittedChips += bbPosted;
  bbSeat.totalCommittedChips += bbPosted;
  if (bbSeat.chips === 0) {
    bbSeat.isAllIn = true;
  }

  const hand: HandState = {
    handNumber: params.handNumber,
    status: "BETTING",
    street: "PREFLOP",
    buttonSeatNumber,
    sbSeatNumber: sbSeat.seatNumber,
    bbSeatNumber: bbSeat.seatNumber,
    isHeadsUp,
    actingSeatNumber: findFirstEligibleActorFrom(
      ordered,
      firstPreflopSeat.seatNumber,
      params.config.seatCount,
      true,
    ),
    potChips: 0,
    currentBet: Math.max(sbPosted, bbPosted),
    lastFullRaiseBet: params.config.bigBlind,
    lastFullRaiseIncrement: params.config.bigBlind,
    seats: ordered.sort((a, b) => a.seatNumber - b.seatNumber),
    pots: [],
    actionHistory: [],
    lastUncalledReturned: null,
    result: null,
  };

  if (isStreetBettingClosed(hand)) {
    settleClosedStreet(hand, params.config);
  }

  return { ok: true, value: hand };
}

/**
 * Computes legal Actions and exact min/max Chip wager bounds for a Seat in the current Street.
 */
export function getLegalActions(
  hand: HandState,
  _config: SessionConfig,
  targetSeatNumber?: number | null,
): LegalActionsInfo | null {
  if (hand.status !== "BETTING") {
    return null;
  }
  const seatNumber = targetSeatNumber ?? hand.actingSeatNumber;
  if (seatNumber === null) {
    return null;
  }
  const seat = getSeat(hand, seatNumber);
  if (!seat || seat.hasFolded || seat.isAllIn || seat.chips <= 0) {
    return null;
  }

  const toCall = Math.max(0, hand.currentBet - seat.streetCommittedChips);
  const maxStreetBet = seat.streetCommittedChips + seat.chips;
  const hasActiveOpponentWithChips = hand.seats.some(
    (s) => s.seatNumber !== seatNumber && !s.hasFolded && !s.isAllIn && s.chips > 0,
  );

  const canFold = true;
  const canCheck = toCall === 0;
  const canCall = toCall > 0;
  const callChips = Math.min(toCall, seat.chips);
  const callIsAllIn = canCall && seat.chips <= toCall;

  const canBet =
    hand.currentBet === 0 &&
    hasActiveOpponentWithChips &&
    maxStreetBet >= _config.bigBlind;

  const rawMinRaiseTo = hand.currentBet + hand.lastFullRaiseIncrement;
  const canRaise =
    hand.currentBet > 0 &&
    !seat.hasActedSinceFullRaise &&
    hasActiveOpponentWithChips &&
    maxStreetBet >= rawMinRaiseTo;

  const canAllIn =
    hand.currentBet === 0
      ? hasActiveOpponentWithChips && seat.chips > 0
      : maxStreetBet <= hand.currentBet
        ? seat.chips > 0
        : !seat.hasActedSinceFullRaise && hasActiveOpponentWithChips;

  return {
    seatNumber,
    toCall,
    currentBet: hand.currentBet,
    totalPotChips: getTotalPotChips(hand),
    canFold,
    canCheck,
    canCall,
    callChips,
    callIsAllIn,
    canBet,
    minBetTo: canBet ? _config.bigBlind : null,
    maxBetTo: canBet ? maxStreetBet : null,
    canRaise,
    minRaiseTo: canRaise ? rawMinRaiseTo : null,
    maxRaiseTo: canRaise ? maxStreetBet : null,
    canAllIn,
    allInTo: canAllIn ? maxStreetBet : null,
    allInAddedChips: canAllIn ? seat.chips : null,
  };
}

function isPlayerActionType(value: unknown): value is PlayerActionType {
  return (
    value === "FOLD" ||
    value === "CHECK" ||
    value === "CALL" ||
    value === "BET" ||
    value === "RAISE" ||
    value === "ALL_IN"
  );
}

function validateWagerTarget(
  label: "Bet" | "Raise",
  rawAmount: unknown,
  minTo: number,
  maxTo: number,
): HandEngineResult<number> {
  if (typeof rawAmount !== "number" || !Number.isInteger(rawAmount)) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: `${label} amount must be a whole number in Chips.`,
    };
  }
  if (rawAmount < minTo) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: `Minimum ${label} is ${minTo} Chips.`,
    };
  }
  if (rawAmount > maxTo) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: `${label} cannot exceed your available stack (${maxTo} Chips).`,
    };
  }
  return { ok: true, value: rawAmount };
}

function reopenRaisingForOthers(hand: HandState, actorSeatNumber: number): void {
  for (const other of hand.seats) {
    if (other.seatNumber !== actorSeatNumber && !other.hasFolded && !other.isAllIn) {
      other.hasActedSinceFullRaise = false;
    }
  }
}

function applySeatWagerToStreetTarget(
  seat: HandSeatState,
  targetStreetChips: number,
): number {
  const added = targetStreetChips - seat.streetCommittedChips;
  seat.chips -= added;
  seat.streetCommittedChips = targetStreetChips;
  seat.totalCommittedChips += added;
  seat.hasActedThisStreet = true;
  seat.hasActedSinceFullRaise = true;
  if (seat.chips === 0) {
    seat.isAllIn = true;
  }
  return added;
}

/**
 * Validates and applies a Player or Host-proxied Action, advancing turn, Street, Fold-Win, or Showdown.
 */
export function applyHandAction(
  currentHand: HandState,
  config: SessionConfig,
  input: {
    seatNumber: number;
    action: unknown;
    amountChips?: unknown;
    byHostProxy?: boolean;
  },
): HandEngineResult<HandState> {
  if (currentHand.status !== "BETTING") {
    return { ok: false, reason: "CONFLICT", error: "Hand is not currently in a betting Street." };
  }
  if (!isPlayerActionType(input.action)) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: "Action must be FOLD, CHECK, CALL, BET, RAISE, or ALL_IN.",
    };
  }
  if (currentHand.actingSeatNumber !== input.seatNumber) {
    return {
      ok: false,
      reason: "CONFLICT",
      error: `It is Seat ${currentHand.actingSeatNumber}'s turn to act.`,
    };
  }

  const hand = cloneHandState(currentHand);
  const seat = getSeat(hand, input.seatNumber);
  if (!seat) {
    return { ok: false, reason: "CONFLICT", error: "Seat is not part of the active Hand." };
  }

  const legal = getLegalActions(hand, config, seat.seatNumber);
  if (!legal) {
    return { ok: false, reason: "CONFLICT", error: "Seat cannot act in this Hand." };
  }

  const action = input.action;
  let recordedAmount = 0;
  let addedChips = 0;

  if (action === "FOLD") {
    seat.hasFolded = true;
    seat.hasActedThisStreet = true;
    seat.hasActedSinceFullRaise = true;
  } else if (action === "CHECK") {
    if (!legal.canCheck) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: `Cannot Check when facing ${legal.toCall} Chips to Call.`,
      };
    }
    seat.hasActedThisStreet = true;
    seat.hasActedSinceFullRaise = true;
  } else if (action === "CALL") {
    if (!legal.canCall) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Cannot Call when there is nothing to Call; Check instead.",
      };
    }
    addedChips = applySeatWagerToStreetTarget(seat, seat.streetCommittedChips + legal.callChips);
    recordedAmount = addedChips;
  } else if (action === "BET") {
    if (hand.currentBet > 0) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "A Bet is already open on this Street; Raise instead.",
      };
    }
    if (!legal.canBet || legal.minBetTo === null || legal.maxBetTo === null) {
      return { ok: false, reason: "CONFLICT", error: "Bet is not legal in the current table state." };
    }
    const target = validateWagerTarget("Bet", input.amountChips, legal.minBetTo, legal.maxBetTo);
    if (!target.ok) {
      return target;
    }

    addedChips = applySeatWagerToStreetTarget(seat, target.value);
    recordedAmount = target.value;
    hand.currentBet = target.value;
    hand.lastFullRaiseBet = target.value;
    hand.lastFullRaiseIncrement = target.value;
    reopenRaisingForOthers(hand, seat.seatNumber);
  } else if (action === "RAISE") {
    if (hand.currentBet === 0) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "No Bet is open on this Street; Bet instead.",
      };
    }
    if (seat.hasActedSinceFullRaise) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Raising is not reopened by a short All-In; Fold or Call.",
      };
    }
    if (!legal.canRaise || legal.minRaiseTo === null || legal.maxRaiseTo === null) {
      return { ok: false, reason: "CONFLICT", error: "Raise is not legal in the current table state." };
    }
    const target = validateWagerTarget(
      "Raise",
      input.amountChips,
      legal.minRaiseTo,
      legal.maxRaiseTo,
    );
    if (!target.ok) {
      return target;
    }

    const oldCurrentBet = hand.currentBet;
    addedChips = applySeatWagerToStreetTarget(seat, target.value);
    recordedAmount = target.value;
    hand.currentBet = target.value;
    hand.lastFullRaiseBet = target.value;
    hand.lastFullRaiseIncrement = target.value - oldCurrentBet;
    reopenRaisingForOthers(hand, seat.seatNumber);
  } else {
    if (!legal.canAllIn || legal.allInTo === null || legal.allInAddedChips === null) {
      const blockedByShortAllIn =
        hand.currentBet > 0 &&
        seat.hasActedSinceFullRaise &&
        seat.streetCommittedChips + seat.chips > hand.currentBet;
      return {
        ok: false,
        reason: "CONFLICT",
        error: blockedByShortAllIn
          ? "Raising is not reopened by a short All-In; Fold or Call."
          : "All-In is not legal in the current table state.",
      };
    }
    if (
      input.amountChips !== undefined &&
      input.amountChips !== null &&
      input.amountChips !== legal.allInTo
    ) {
      return {
        ok: false,
        reason: "VALIDATION",
        error: `All-In amount must equal your full street stack (${legal.allInTo} Chips).`,
      };
    }

    const oldCurrentBet = hand.currentBet;
    const target = legal.allInTo;
    addedChips = applySeatWagerToStreetTarget(seat, target);
    recordedAmount = target;

    if (target > oldCurrentBet) {
      const increment = target - oldCurrentBet;
      const fullRaiseThreshold =
        (hand.lastFullRaiseBet ?? oldCurrentBet) + hand.lastFullRaiseIncrement;
      const isFullOpenOrRaise =
        oldCurrentBet === 0
          ? target >= config.bigBlind
          : target >= fullRaiseThreshold && target >= config.bigBlind;

      hand.currentBet = target;
      if (isFullOpenOrRaise) {
        hand.lastFullRaiseBet = target;
        hand.lastFullRaiseIncrement =
          oldCurrentBet === 0 ? target : Math.max(hand.lastFullRaiseIncrement, increment);
        reopenRaisingForOthers(hand, seat.seatNumber);
      }
    }
  }

  hand.actionHistory.push({
    index: hand.actionHistory.length,
    street: hand.street,
    seatNumber: seat.seatNumber,
    playerId: seat.playerId,
    displayName: seat.displayName,
    action,
    amountChips: recordedAmount,
    addedChips,
    byHostProxy: input.byHostProxy ?? false,
  });

  if (isStreetBettingClosed(hand)) {
    settleClosedStreet(hand, config);
  } else {
    hand.actingSeatNumber = findFirstEligibleActorFrom(
      hand.seats,
      seat.seatNumber,
      config.seatCount,
      false,
    );
  }

  return { ok: true, value: hand };
}

/**
 * Splits a Pot among selected winning Seats in whole Chips, awarding any odd Chip clockwise left of Button.
 */
export function computePotSplitAwards(params: {
  potAmountChips: number;
  winnerSeatNumbers: readonly number[];
  buttonSeatNumber: number;
  seatCount: number;
}): Map<number, { amountChips: number; oddChips: number }> {
  const orderedWinners = [...params.winnerSeatNumbers].sort(
    (a, b) =>
      clockwiseLeftOfButtonOffset(a, params.buttonSeatNumber, params.seatCount) -
      clockwiseLeftOfButtonOffset(b, params.buttonSeatNumber, params.seatCount),
  );

  const base = Math.floor(params.potAmountChips / orderedWinners.length);
  const remainder = params.potAmountChips % orderedWinners.length;

  const payouts = new Map<number, { amountChips: number; oddChips: number }>();
  orderedWinners.forEach((seatNumber, idx) => {
    const oddChips = idx < remainder ? 1 : 0;
    payouts.set(seatNumber, {
      amountChips: base + oddChips,
      oddChips,
    });
  });

  return payouts;
}

/**
 * Resolves a Showdown Pot via Host winner/split selection and awards Chips atomically.
 */
export function resolveShowdown(
  currentHand: HandState,
  config: SessionConfig,
  input: { winnerSeatNumbers: unknown; potId?: string | undefined },
): HandEngineResult<HandState> {
  if (currentHand.status !== "SHOWDOWN") {
    return {
      ok: false,
      reason: "CONFLICT",
      error: "Hand is not currently at Showdown.",
    };
  }

  const hand = cloneHandState(currentHand);
  const targetPot =
    input.potId !== undefined
      ? hand.pots.find((p) => p.id === input.potId && p.winnerSeatNumbers === null)
      : hand.pots.find((p) => p.winnerSeatNumbers === null);

  if (!targetPot) {
    return {
      ok: false,
      reason: "CONFLICT",
      error: "No unresolved Showdown Pot found.",
    };
  }

  if (!Array.isArray(input.winnerSeatNumbers) || input.winnerSeatNumbers.length === 0) {
    return {
      ok: false,
      reason: "VALIDATION",
      error: "Select at least one winning Seat for Showdown.",
    };
  }

  const seen = new Set<number>();
  const winners: number[] = [];
  for (const rawSeat of input.winnerSeatNumbers) {
    if (typeof rawSeat !== "number" || !Number.isInteger(rawSeat)) {
      return {
        ok: false,
        reason: "VALIDATION",
        error: "Winner Seat numbers must be integers.",
      };
    }
    if (seen.has(rawSeat)) {
      return {
        ok: false,
        reason: "VALIDATION",
        error: "Duplicate Seat selected for Showdown.",
      };
    }
    if (!targetPot.eligibleSeatNumbers.includes(rawSeat)) {
      return {
        ok: false,
        reason: "VALIDATION",
        error: `Seat ${rawSeat} is not eligible for ${targetPot.label}.`,
      };
    }
    seen.add(rawSeat);
    winners.push(rawSeat);
  }

  const payouts = computePotSplitAwards({
    potAmountChips: targetPot.amountChips,
    winnerSeatNumbers: winners,
    buttonSeatNumber: hand.buttonSeatNumber,
    seatCount: config.seatCount,
  });

  const existingAwards = hand.result ? [...hand.result.awards] : [];
  const potAwards: PotAwardView[] = [];
  const orderedWinners = [...winners].sort(
    (a, b) =>
      clockwiseLeftOfButtonOffset(a, hand.buttonSeatNumber, config.seatCount) -
      clockwiseLeftOfButtonOffset(b, hand.buttonSeatNumber, config.seatCount),
  );

  for (const seatNumber of orderedWinners) {
    const seat = getSeat(hand, seatNumber);
    const payout = payouts.get(seatNumber);
    if (!seat || !payout) {
      continue;
    }
    seat.chips += payout.amountChips;
    potAwards.push({
      potId: targetPot.id,
      potLabel: targetPot.label,
      seatNumber,
      playerId: seat.playerId,
      displayName: seat.displayName,
      amountChips: payout.amountChips,
      oddChips: payout.oddChips,
    });
  }

  targetPot.winnerSeatNumbers = orderedWinners;
  hand.potChips = Math.max(0, hand.potChips - targetPot.amountChips);

  const potOrder = new Map(hand.pots.map((p, idx) => [p.id, idx]));
  const allAwards = [...existingAwards, ...potAwards].sort(
    (a, b) => (potOrder.get(a.potId) ?? 0) - (potOrder.get(b.potId) ?? 0),
  );
  const remainingUnresolved = hand.pots.some((p) => p.winnerSeatNumbers === null);

  if (!remainingUnresolved) {
    const totalPotChips = hand.pots.reduce((sum, p) => sum + p.amountChips, 0);
    hand.potChips = 0;
    hand.status = "COMPLETE";
    hand.actingSeatNumber = null;
    hand.result = {
      reason: "SHOWDOWN",
      totalPotChips,
      awards: allAwards,
      uncalledReturned: hand.lastUncalledReturned,
    };
  } else {
    hand.result = {
      reason: "SHOWDOWN",
      totalPotChips: hand.pots.reduce((sum, p) => sum + p.amountChips, 0),
      awards: allAwards,
      uncalledReturned: hand.lastUncalledReturned,
    };
  }

  return { ok: true, value: hand };
}
