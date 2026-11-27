import type { HandSeatState, Street } from "../shared/handEngine.ts";

export const STREET_LABELS: Record<Street, string> = {
  PREFLOP: "Preflop",
  FLOP: "Flop",
  TURN: "Turn",
  RIVER: "River",
};

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
