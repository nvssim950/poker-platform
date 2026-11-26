import type { HandActionRecord, HandSeatState, Street } from "../shared/handEngine.ts";

export const STREET_ORDER: readonly Street[] = ["PREFLOP", "FLOP", "TURN", "RIVER"];

export const STREET_LABELS: Record<Street, string> = {
  PREFLOP: "Preflop",
  FLOP: "Flop",
  TURN: "Turn",
  RIVER: "River",
};

/**
 * Formats a single Hand Action record without its Street prefix.
 */
export function formatActionBody(record: HandActionRecord, includeProxyTag = true): string {
  const seatLabel = `Seat ${record.seatNumber} (${record.displayName})`;
  const proxyTag = includeProxyTag && record.byHostProxy ? " · Host Proxy" : "";
  switch (record.action) {
    case "FOLD":
      return `${seatLabel} Folded${proxyTag}`;
    case "CHECK":
      return `${seatLabel} Checked${proxyTag}`;
    case "CALL":
      return `${seatLabel} Called ${record.amountChips} Chips${proxyTag}`;
    case "BET":
      return `${seatLabel} Bet ${record.amountChips} Chips${proxyTag}`;
    case "RAISE":
      return `${seatLabel} Raised to ${record.amountChips} Chips${proxyTag}`;
    case "ALL_IN":
      return `${seatLabel} All-In (${record.amountChips} Chips)${proxyTag}`;
    case "STRADDLE":
      return `${seatLabel} Straddled ${record.amountChips} Chips${proxyTag}`;
  }
}

/**
 * Formats a Hand Action record prefixed by its Street label.
 */
export function formatActionSummary(record: HandActionRecord): string {
  return `${STREET_LABELS[record.street]} · ${formatActionBody(record)}`;
}

/**
 * Formats a comma-separated list of eligible Seats with display names.
 */
export function formatEligibleSeatList(
  seatNumbers: readonly number[],
  seats: readonly HandSeatState[],
): string {
  return seatNumbers
    .map((seatNumber) => {
      const seat = seats.find((s) => s.seatNumber === seatNumber);
      return seat ? `Seat ${seatNumber} (${seat.displayName})` : `Seat ${seatNumber}`;
    })
    .join(", ");
}
