import type { DepartedPlayerRecord, SeatView } from "./session.ts";

export type LeaderboardEntryStatus = "ACTIVE" | "LEFT";

export interface LeaderboardEntry {
  participantId: string;
  displayName: string;
  seatNumber: number;
  chips: number;
  totalIssuedChips: number;
  rebuyCount: number;
  netChips: number;
  status: LeaderboardEntryStatus;
}

export interface LeaderboardSummary {
  endedAt: string | null;
  totalIssuedChips: number;
  totalChips: number;
  entries: LeaderboardEntry[];
}

/**
 * Computes sorted Chip Leaderboard standings across active Seats and departed Players.
 */
export function computeLeaderboard(params: {
  seats: readonly SeatView[];
  departedPlayers: readonly DepartedPlayerRecord[];
  endedAt?: string | null;
}): LeaderboardSummary {
  const entries: LeaderboardEntry[] = [];

  for (const departed of params.departedPlayers) {
    entries.push({
      participantId: departed.playerId,
      displayName: departed.displayName,
      seatNumber: departed.seatNumber,
      chips: departed.endingChips,
      totalIssuedChips: departed.totalIssuedChips,
      rebuyCount: departed.rebuyCount,
      netChips: departed.endingChips - departed.totalIssuedChips,
      status: "LEFT",
    });
  }

  for (const seat of params.seats) {
    if (!seat.occupant) {
      continue;
    }
    const occ = seat.occupant;
    entries.push({
      participantId: occ.playerId,
      displayName: occ.displayName,
      seatNumber: seat.seatNumber,
      chips: occ.chips,
      totalIssuedChips: occ.totalBuyInChips,
      rebuyCount: occ.rebuyCount,
      netChips: occ.chips - occ.totalBuyInChips,
      status: "ACTIVE",
    });
  }

  entries.sort((a, b) => {
    if (b.netChips !== a.netChips) {
      return b.netChips - a.netChips;
    }
    if (b.chips !== a.chips) {
      return b.chips - a.chips;
    }
    if (a.seatNumber !== b.seatNumber) {
      return a.seatNumber - b.seatNumber;
    }
    return a.displayName.localeCompare(b.displayName);
  });

  const totalIssuedChips = entries.reduce((sum, e) => sum + e.totalIssuedChips, 0);
  const totalChips = entries.reduce((sum, e) => sum + e.chips, 0);

  return {
    endedAt: params.endedAt ?? null,
    totalIssuedChips,
    totalChips,
    entries,
  };
}
