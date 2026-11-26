import { formatCashMinor } from "./session.ts";

export type SettlementParticipantStatus = "CASHED_OUT" | "SETTLED";

export interface SettlementParticipantInput {
  participantId: string;
  displayName: string;
  seatNumber: number;
  totalBuyInChips: number;
  endingChips: number;
  status: SettlementParticipantStatus;
  cashedOutAt?: string | null | undefined;
}

export interface SettlementParticipantSummary {
  participantId: string;
  displayName: string;
  seatNumber: number;
  totalBuyInChips: number;
  endingChips: number;
  netChips: number;
  netCashMinor: number;
  status: SettlementParticipantStatus;
  cashedOutAt: string | null;
}

export interface SettlementTransfer {
  fromParticipantId: string;
  fromDisplayName: string;
  toParticipantId: string;
  toDisplayName: string;
  amountCashMinor: number;
}

export interface SettlementSummary {
  settledAt: string;
  totalBuyInChips: number;
  totalEndingChips: number;
  chipDiscrepancy: number;
  totalNetCashMinor: number;
  isBalanced: boolean;
  participants: SettlementParticipantSummary[];
  transfers: SettlementTransfer[];
}

export interface ComputeSettlementInput {
  participants: readonly SettlementParticipantInput[];
  exchangeRateChips: number;
  exchangeRateCashMinor: number;
  settledAt?: string | undefined;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Formats a Settlement transfer as a human-readable payment instruction.
 */
export function formatSettlementTransfer(
  transfer: Pick<SettlementTransfer, "fromDisplayName" | "toDisplayName" | "amountCashMinor">,
  currencySymbol: string,
): string {
  return `${transfer.fromDisplayName} pays ${transfer.toDisplayName} ${formatCashMinor(
    transfer.amountCashMinor,
    currencySymbol,
  )}`;
}

/**
 * Computes zero-sum Cash Settlement positions and a minimum-transfer payment list from participant Chip records.
 */
export function computeSettlement(input: ComputeSettlementInput): SettlementSummary {
  const { participants, exchangeRateChips, exchangeRateCashMinor } = input;
  if (!Number.isInteger(exchangeRateChips) || exchangeRateChips <= 0) {
    throw new Error("exchangeRateChips must be a positive integer.");
  }
  if (!Number.isInteger(exchangeRateCashMinor) || exchangeRateCashMinor <= 0) {
    throw new Error("exchangeRateCashMinor must be a positive integer.");
  }

  const settledAt = input.settledAt ?? new Date().toISOString();

  if (participants.length === 0) {
    return {
      settledAt,
      totalBuyInChips: 0,
      totalEndingChips: 0,
      chipDiscrepancy: 0,
      totalNetCashMinor: 0,
      isBalanced: true,
      participants: [],
      transfers: [],
    };
  }

  let totalBuyInChips = 0;
  let totalEndingChips = 0;

  const working = participants.map((p, index) => {
    if (!Number.isInteger(p.totalBuyInChips) || p.totalBuyInChips < 0) {
      throw new Error(`Participant ${p.participantId} has invalid totalBuyInChips.`);
    }
    if (!Number.isInteger(p.endingChips) || p.endingChips < 0) {
      throw new Error(`Participant ${p.participantId} has invalid endingChips.`);
    }

    totalBuyInChips += p.totalBuyInChips;
    totalEndingChips += p.endingChips;

    const netChips = p.endingChips - p.totalBuyInChips;
    const exactNumerator = netChips * exchangeRateCashMinor;
    const rounded = Math.round(exactNumerator / exchangeRateChips) || 0;
    // Proportional to (exact - rounded) * exchangeRateChips; positive means rounded down.
    const errorNumerator = exactNumerator - rounded * exchangeRateChips;

    return {
      index,
      participantId: p.participantId,
      displayName: p.displayName,
      seatNumber: p.seatNumber,
      totalBuyInChips: p.totalBuyInChips,
      endingChips: p.endingChips,
      netChips,
      netCashMinor: rounded,
      errorNumerator,
      status: p.status,
      cashedOutAt: p.cashedOutAt ?? null,
    };
  });

  const rawSum = working.reduce((sum, entry) => sum + entry.netCashMinor, 0);
  const residual = -rawSum;

  if (residual !== 0) {
    const direction = residual > 0 ? 1 : -1;
    const orderedForAdjustment = [...working].sort((a, b) => {
      const errDiff = direction * (b.errorNumerator - a.errorNumerator);
      if (errDiff !== 0) {
        return errDiff;
      }
      return compareIds(a.participantId, b.participantId);
    });

    let remaining = Math.abs(residual);
    let cursor = 0;
    while (remaining > 0) {
      const target = orderedForAdjustment[cursor % orderedForAdjustment.length]!;
      target.netCashMinor += direction;
      remaining -= 1;
      cursor += 1;
    }
  }

  const totalNetCashMinor = working.reduce((sum, entry) => sum + entry.netCashMinor, 0);
  const chipDiscrepancy = totalEndingChips - totalBuyInChips;

  const creditors = working
    .filter((entry) => entry.netCashMinor > 0)
    .map((entry) => ({
      participantId: entry.participantId,
      displayName: entry.displayName,
      remaining: entry.netCashMinor,
    }))
    .sort((a, b) => b.remaining - a.remaining || compareIds(a.participantId, b.participantId));

  const debtors = working
    .filter((entry) => entry.netCashMinor < 0)
    .map((entry) => ({
      participantId: entry.participantId,
      displayName: entry.displayName,
      remaining: -entry.netCashMinor,
    }))
    .sort((a, b) => b.remaining - a.remaining || compareIds(a.participantId, b.participantId));

  const transfers: SettlementTransfer[] = [];
  let cIdx = 0;
  let dIdx = 0;
  while (cIdx < creditors.length && dIdx < debtors.length) {
    const creditor = creditors[cIdx]!;
    const debtor = debtors[dIdx]!;
    const amountCashMinor = Math.min(creditor.remaining, debtor.remaining);
    if (amountCashMinor > 0) {
      transfers.push({
        fromParticipantId: debtor.participantId,
        fromDisplayName: debtor.displayName,
        toParticipantId: creditor.participantId,
        toDisplayName: creditor.displayName,
        amountCashMinor,
      });
    }
    creditor.remaining -= amountCashMinor;
    debtor.remaining -= amountCashMinor;
    if (creditor.remaining === 0) {
      cIdx += 1;
    }
    if (debtor.remaining === 0) {
      dIdx += 1;
    }
  }

  return {
    settledAt,
    totalBuyInChips,
    totalEndingChips,
    chipDiscrepancy,
    totalNetCashMinor,
    isBalanced: totalNetCashMinor === 0 && chipDiscrepancy === 0,
    participants: working.map((entry) => ({
      participantId: entry.participantId,
      displayName: entry.displayName,
      seatNumber: entry.seatNumber,
      totalBuyInChips: entry.totalBuyInChips,
      endingChips: entry.endingChips,
      netChips: entry.netChips,
      netCashMinor: entry.netCashMinor,
      status: entry.status,
      cashedOutAt: entry.cashedOutAt,
    })),
    transfers,
  };
}
