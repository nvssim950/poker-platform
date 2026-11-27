import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  applyHandAction as applyHandActionEngine,
  isHandInProgress,
  normalizeHandState,
  resolveShowdown as resolveShowdownEngine,
  startHand as startHandEngine,
  type HandState,
} from "../shared/handEngine.ts";
import {
  computeLeaderboard,
  type LeaderboardSummary,
} from "../shared/leaderboard.ts";
import {
  normalizeSessionCode,
  normalizeSessionConfig,
  type DepartedPlayerRecord,
  type GetSessionHandsResponse,
  type SeatView,
  type SessionConfig,
  type SessionSnapshot,
  type SessionStats,
  type SessionStatus,
  type ViewerIdentity,
} from "../shared/session.ts";

export interface StoredSeatRow {
  session_code: string;
  seat_number: number;
  player_id: string | null;
  display_name: string | null;
  seat_token: string | null;
  chips: number;
  total_buy_in_chips: number;
  rebuy_count: number;
  is_sitting_out: number;
}

interface StoredDepartedPlayerRow {
  id: string;
  session_code: string;
  seat_number: number;
  player_id: string;
  display_name: string;
  total_issued_chips: number;
  rebuy_count: number;
  ending_chips: number;
  departed_at: string;
}

export interface StoredSession {
  code: string;
  hostToken: string;
  status: SessionStatus;
  config: SessionConfig;
  seats: StoredSeatRow[];
  departedPlayers: DepartedPlayerRecord[];
  finalLeaderboard: LeaderboardSummary | null;
  hand: HandState | null;
  canUndo: boolean;
  handHistory: HandState[];
  sessionStats: SessionStats;
}

export type ClaimSeatResult =
  | { ok: true; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "OCCUPIED" | "SETTLED" };

export type SeatMutationResult =
  | { ok: true; session: StoredSession }
  | {
      ok: false;
      reason: "NOT_FOUND" | "EMPTY" | "CONFLICT";
      error: string;
    };

export type HandMutationResult =
  | { ok: true; hand: HandState; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "VALIDATION" | "CONFLICT"; error: string };

export type EndGameResult =
  | { ok: true; leaderboard: LeaderboardSummary; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "CONFLICT"; error: string };

export interface SessionStorage {
  createSession(code: string, hostToken: string, config: SessionConfig): StoredSession;
  getSession(code: string): StoredSession | null;
  claimSeat(
    code: string,
    seatNumber: number,
    playerId: string,
    displayName: string,
    seatToken: string,
  ): ClaimSeatResult;
  rebuySeat(code: string, seatNumber: number): SeatMutationResult;
  leaveSeat(code: string, seatNumber: number): SeatMutationResult;
  releaseSeat(code: string, seatNumber: number): SeatMutationResult;
  setSeatSittingOut(code: string, seatNumber: number, isSittingOut: boolean): SeatMutationResult;
  endGame(code: string): EndGameResult;
  startHand(code: string): HandMutationResult;
  applyHandAction(
    code: string,
    params: {
      seatNumber: number;
      action: unknown;
      amountChips?: unknown;
      byHostProxy?: boolean;
    },
  ): HandMutationResult;
  resolveShowdown(
    code: string,
    params: {
      winnerSeatNumbers: unknown;
      potId?: string | undefined;
    },
  ): HandMutationResult;
  undoHandStep(code: string): HandMutationResult;
  getSessionHands(code: string): GetSessionHandsResponse | null;
  close(): void;
}

function mapDepartedPlayerRow(row: StoredDepartedPlayerRow): DepartedPlayerRecord {
  return {
    id: row.id,
    seatNumber: row.seat_number,
    playerId: row.player_id,
    displayName: row.display_name,
    totalIssuedChips: row.total_issued_chips,
    rebuyCount: row.rebuy_count,
    endingChips: row.ending_chips,
    departedAt: row.departed_at,
  };
}

function mapSeatRowsToViews(
  rows: readonly StoredSeatRow[],
  connectedPlayers: ReadonlySet<string> = new Set(),
): SeatView[] {
  return rows.map((seat) => ({
    seatNumber: seat.seat_number,
    occupant:
      seat.player_id !== null && seat.display_name !== null
        ? {
            playerId: seat.player_id,
            displayName: seat.display_name,
            chips: seat.chips,
            totalBuyInChips: seat.total_buy_in_chips,
            rebuyCount: seat.rebuy_count,
            isConnected: connectedPlayers.has(seat.player_id),
            isSittingOut: seat.is_sitting_out !== 0,
          }
        : null,
  }));
}

/**
 * Creates a SQLite-backed persistence adapter for Sessions, Seats, and Hands.
 */
export function createSessionStorage(dbPath: string): SessionStorage {
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      code TEXT PRIMARY KEY,
      host_token TEXT NOT NULL,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SETTLED')),
      settlement_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seats (
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      seat_number INTEGER NOT NULL,
      player_id TEXT,
      display_name TEXT,
      seat_token TEXT,
      chips INTEGER NOT NULL DEFAULT 0,
      total_buy_in_chips INTEGER NOT NULL DEFAULT 0,
      rebuy_count INTEGER NOT NULL DEFAULT 0,
      is_sitting_out INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_code, seat_number)
    );
    CREATE TABLE IF NOT EXISTS departed_players (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      seat_number INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      total_issued_chips INTEGER NOT NULL CHECK (total_issued_chips >= 0),
      rebuy_count INTEGER NOT NULL DEFAULT 0,
      ending_chips INTEGER NOT NULL CHECK (ending_chips >= 0),
      departed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_departed_players_session
      ON departed_players (session_code, departed_at);
    CREATE TABLE IF NOT EXISTS hands (
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      hand_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('BETTING', 'SHOWDOWN', 'COMPLETE')),
      button_seat_number INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ledger_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_code, hand_number)
    );
    CREATE INDEX IF NOT EXISTS idx_hands_session_latest
      ON hands (session_code, hand_number DESC);
    CREATE TABLE IF NOT EXISTS hand_checkpoints (
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      hand_number INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_code, hand_number, step_index)
    );
  `);

  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((col) => col.name === "status")) {
    db.exec("ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';");
  }
  if (!sessionColumns.some((col) => col.name === "settlement_json")) {
    db.exec("ALTER TABLE sessions ADD COLUMN settlement_json TEXT;");
  }
  if (!sessionColumns.some((col) => col.name === "ledger_seq")) {
    db.exec("ALTER TABLE sessions ADD COLUMN ledger_seq INTEGER NOT NULL DEFAULT 0;");
  }

  const handColumns = db.prepare("PRAGMA table_info(hands)").all() as Array<{ name: string }>;
  if (!handColumns.some((col) => col.name === "ledger_seq")) {
    db.exec("ALTER TABLE hands ADD COLUMN ledger_seq INTEGER NOT NULL DEFAULT 0;");
  }

  const seatColumns = db.prepare("PRAGMA table_info(seats)").all() as Array<{ name: string }>;
  if (!seatColumns.some((col) => col.name === "total_buy_in_chips")) {
    db.exec("ALTER TABLE seats ADD COLUMN total_buy_in_chips INTEGER NOT NULL DEFAULT 0;");
  }
  if (!seatColumns.some((col) => col.name === "is_sitting_out")) {
    db.exec("ALTER TABLE seats ADD COLUMN is_sitting_out INTEGER NOT NULL DEFAULT 0;");
  }
  if (!seatColumns.some((col) => col.name === "rebuy_count")) {
    db.exec("ALTER TABLE seats ADD COLUMN rebuy_count INTEGER NOT NULL DEFAULT 0;");
  }

  const insertSessionStmt = db.prepare(
    "INSERT INTO sessions (code, host_token, config_json, status, settlement_json, ledger_seq, created_at) VALUES (?, ?, ?, 'ACTIVE', NULL, 0, ?)",
  );
  const insertSeatStmt = db.prepare(
    "INSERT INTO seats (session_code, seat_number, player_id, display_name, seat_token, chips, total_buy_in_chips, rebuy_count, is_sitting_out) VALUES (?, ?, NULL, NULL, NULL, 0, 0, 0, 0)",
  );
  const selectSessionStmt = db.prepare(
    "SELECT code, host_token, config_json, status, settlement_json, ledger_seq FROM sessions WHERE code = ?",
  );
  const incrementSessionLedgerSeqStmt = db.prepare(
    "UPDATE sessions SET ledger_seq = ledger_seq + 1 WHERE code = ?",
  );
  const selectSeatsStmt = db.prepare(
    "SELECT session_code, seat_number, player_id, display_name, seat_token, chips, total_buy_in_chips, rebuy_count, is_sitting_out FROM seats WHERE session_code = ? ORDER BY seat_number ASC",
  );
  const selectSeatStmt = db.prepare(
    "SELECT session_code, seat_number, player_id, display_name, seat_token, chips, total_buy_in_chips, rebuy_count, is_sitting_out FROM seats WHERE session_code = ? AND seat_number = ?",
  );
  const selectDepartedPlayersStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, total_issued_chips, rebuy_count, ending_chips, departed_at FROM departed_players WHERE session_code = ? ORDER BY departed_at ASC, rowid ASC",
  );
  const insertDepartedPlayerStmt = db.prepare(
    "INSERT INTO departed_players (id, session_code, seat_number, player_id, display_name, total_issued_chips, rebuy_count, ending_chips, departed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const claimSeatStmt = db.prepare(
    "UPDATE seats SET player_id = ?, display_name = ?, seat_token = ?, chips = ?, total_buy_in_chips = ?, rebuy_count = 0, is_sitting_out = 0 WHERE session_code = ? AND seat_number = ? AND player_id IS NULL",
  );
  const vacateSeatStmt = db.prepare(
    "UPDATE seats SET player_id = NULL, display_name = NULL, seat_token = NULL, chips = 0, total_buy_in_chips = 0, rebuy_count = 0, is_sitting_out = 0 WHERE session_code = ? AND seat_number = ? AND player_id IS NOT NULL",
  );
  const rebuySeatStmt = db.prepare(
    "UPDATE seats SET chips = ?, total_buy_in_chips = total_buy_in_chips + ?, rebuy_count = rebuy_count + 1 WHERE session_code = ? AND seat_number = ? AND player_id IS NOT NULL AND chips = 0",
  );
  const setSeatSittingOutStmt = db.prepare(
    "UPDATE seats SET is_sitting_out = ? WHERE session_code = ? AND seat_number = ? AND player_id IS NOT NULL",
  );
  const markSessionSettledStmt = db.prepare(
    "UPDATE sessions SET status = 'SETTLED', settlement_json = ? WHERE code = ? AND status = 'ACTIVE'",
  );
  const selectLatestHandRowStmt = db.prepare(
    "SELECT hand_number, status, state_json, updated_at, ledger_seq FROM hands WHERE session_code = ? ORDER BY hand_number DESC LIMIT 1",
  );
  const selectCompletedHandsStmt = db.prepare(
    "SELECT state_json FROM hands WHERE session_code = ? AND status = 'COMPLETE' ORDER BY hand_number DESC",
  );
  const selectActiveHandExistsStmt = db.prepare(
    "SELECT 1 AS active FROM hands WHERE session_code = ? AND status != 'COMPLETE' LIMIT 1",
  );
  const insertHandStmt = db.prepare(
    "INSERT INTO hands (session_code, hand_number, status, button_seat_number, state_json, created_at, updated_at, ledger_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const updateHandStmt = db.prepare(
    "UPDATE hands SET status = ?, button_seat_number = ?, state_json = ?, updated_at = ?, ledger_seq = ? WHERE session_code = ? AND hand_number = ?",
  );
  const selectMaxCheckpointStepStmt = db.prepare(
    "SELECT MAX(step_index) AS max_step FROM hand_checkpoints WHERE session_code = ? AND hand_number = ?",
  );
  const selectCheckpointStmt = db.prepare(
    "SELECT state_json FROM hand_checkpoints WHERE session_code = ? AND hand_number = ? AND step_index = ?",
  );
  const insertCheckpointStmt = db.prepare(
    "INSERT INTO hand_checkpoints (session_code, hand_number, step_index, state_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const deleteCheckpointStmt = db.prepare(
    "DELETE FROM hand_checkpoints WHERE session_code = ? AND hand_number = ? AND step_index = ?",
  );
  const prunePriorCheckpointsStmt = db.prepare(
    "DELETE FROM hand_checkpoints WHERE session_code = ? AND hand_number < ?",
  );
  const setSeatChipsStmt = db.prepare(
    "UPDATE seats SET chips = ? WHERE session_code = ? AND seat_number = ? AND player_id = ?",
  );

  interface StoredHandRow {
    hand_number: number;
    status: HandState["status"];
    state_json: string;
    updated_at: string;
    ledger_seq: number;
  }

  type UndoCheckResult =
    | {
        ok: true;
        maxStep: number;
        restoredHand: HandState;
        sessionLedgerSeq: number;
      }
    | {
        ok: false;
        reason: "NOT_FOUND" | "CONFLICT";
        error: string;
      };

  function getLatestHandRow(code: string): StoredHandRow | undefined {
    return selectLatestHandRowStmt.get(code) as StoredHandRow | undefined;
  }

  function getLatestHand(code: string): HandState | null {
    const row = getLatestHandRow(code);
    return row ? normalizeHandState(JSON.parse(row.state_json) as HandState) : null;
  }

  function getHandHistoryAndStats(code: string): {
    handHistory: HandState[];
    sessionStats: SessionStats;
  } {
    const rows = selectCompletedHandsStmt.all(code) as Array<{ state_json: string }>;
    const handHistory = rows.map((r) => normalizeHandState(JSON.parse(r.state_json) as HandState));
    let biggestPotChips = 0;
    let biggestHandNumber: number | null = null;
    for (const hand of handHistory) {
      const potChips =
        hand.result?.totalPotChips ?? hand.pots.reduce((sum, p) => sum + p.amountChips, 0);
      if (potChips > biggestPotChips || (biggestHandNumber === null && potChips === 0)) {
        biggestPotChips = potChips;
        biggestHandNumber = hand.handNumber;
      }
    }
    return {
      handHistory,
      sessionStats: {
        handsPlayed: handHistory.length,
        biggestPotChips,
        biggestHandNumber,
      },
    };
  }

  function validateUndoState(
    code: string,
    sessionRow: { status: SessionStatus; ledger_seq: number } | undefined,
    latestHandRow: StoredHandRow | undefined,
    seatRows: readonly StoredSeatRow[],
  ): UndoCheckResult {
    if (!sessionRow) {
      return { ok: false, reason: "NOT_FOUND", error: "Session not found." };
    }
    if (sessionRow.status === "SETTLED") {
      return { ok: false, reason: "CONFLICT", error: "Session has already ended." };
    }
    if (!latestHandRow) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "At start of current Hand; nothing left to undo.",
      };
    }

    const maxRow = selectMaxCheckpointStepStmt.get(code, latestHandRow.hand_number) as
      | { max_step: number | null }
      | undefined;
    const maxStep = maxRow?.max_step ?? null;
    if (maxStep === null || maxStep <= 0) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "At start of current Hand; nothing left to undo.",
      };
    }

    const prevCheckpoint = selectCheckpointStmt.get(
      code,
      latestHandRow.hand_number,
      maxStep - 1,
    ) as { state_json: string } | undefined;
    if (!prevCheckpoint) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "At start of current Hand; nothing left to undo.",
      };
    }

    const restoredHand = normalizeHandState(JSON.parse(prevCheckpoint.state_json) as HandState);

    if (latestHandRow.status === "COMPLETE") {
      if (sessionRow.ledger_seq > latestHandRow.ledger_seq) {
        return {
          ok: false,
          reason: "CONFLICT",
          error:
            "Cannot undo completed Hand after subsequent Rebuy or Seat departure activity.",
        };
      }
    }

    const seatByNumber = new Map(seatRows.map((s) => [s.seat_number, s]));
    for (const handSeat of restoredHand.seats) {
      const seatRow = seatByNumber.get(handSeat.seatNumber);
      if (!seatRow || seatRow.player_id !== handSeat.playerId) {
        return {
          ok: false,
          reason: "CONFLICT",
          error:
            "Cannot undo Hand because a participating Seat is no longer occupied by the same Player.",
        };
      }
    }

    return {
      ok: true,
      maxStep,
      restoredHand,
      sessionLedgerSeq: sessionRow.ledger_seq,
    };
  }

  function getSession(rawCode: string): StoredSession | null {
    const code = normalizeSessionCode(rawCode);
    const row = selectSessionStmt.get(code) as
      | {
          code: string;
          host_token: string;
          config_json: string;
          status: SessionStatus;
          settlement_json: string | null;
          ledger_seq: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const seats = selectSeatsStmt.all(code) as unknown as StoredSeatRow[];
    const departedRows = selectDepartedPlayersStmt.all(
      code,
    ) as unknown as StoredDepartedPlayerRow[];
    const latestHandRow = getLatestHandRow(code);
    const hand = latestHandRow
      ? normalizeHandState(JSON.parse(latestHandRow.state_json) as HandState)
      : null;
    const { handHistory, sessionStats } = getHandHistoryAndStats(code);
    const canUndo = validateUndoState(code, row, latestHandRow, seats).ok;
    return {
      code: row.code,
      hostToken: row.host_token,
      status: row.status,
      config: normalizeSessionConfig(JSON.parse(row.config_json) as SessionConfig),
      seats,
      departedPlayers: departedRows.map(mapDepartedPlayerRow),
      finalLeaderboard: row.settlement_json
        ? (JSON.parse(row.settlement_json) as LeaderboardSummary)
        : null,
      hand,
      canUndo,
      handHistory,
      sessionStats,
    };
  }

  function runInTransaction<T extends { ok: boolean }>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec(result.ok ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function getSessionMeta(
    code: string,
  ): { config: SessionConfig; status: SessionStatus; ledgerSeq: number } | null {
    const row = selectSessionStmt.get(code) as
      | { config_json: string; status: SessionStatus; ledger_seq: number }
      | undefined;
    return row
      ? {
          config: normalizeSessionConfig(JSON.parse(row.config_json) as SessionConfig),
          status: row.status,
          ledgerSeq: row.ledger_seq,
        }
      : null;
  }

  function requireActiveSessionMeta(
    code: string,
  ):
    | { ok: true; config: SessionConfig; ledgerSeq: number }
    | { ok: false; reason: "NOT_FOUND" | "CONFLICT"; error: string } {
    const meta = getSessionMeta(code);
    if (!meta) {
      return { ok: false, reason: "NOT_FOUND", error: "Session not found." };
    }
    if (meta.status === "SETTLED") {
      return { ok: false, reason: "CONFLICT", error: "Session has already ended." };
    }
    return { ok: true, config: meta.config, ledgerSeq: meta.ledgerSeq };
  }

  function hasActiveHand(code: string): boolean {
    return selectActiveHandExistsStmt.get(code) !== undefined;
  }

  function syncSeatsFromHand(code: string, hand: HandState): void {
    for (const handSeat of hand.seats) {
      const updated = setSeatChipsStmt.run(
        handSeat.chips,
        code,
        handSeat.seatNumber,
        handSeat.playerId,
      );
      if (updated.changes === 0) {
        throw new Error(`Seat ${handSeat.seatNumber} missing or mismatched during Hand sync`);
      }
    }
  }

  function mutateLatestHand(
    rawCode: string,
    expectedStatus: HandState["status"],
    missingStatusError: string,
    transition: (hand: HandState, config: SessionConfig) => ReturnType<typeof applyHandActionEngine>,
    isNoOp?: (prev: HandState, next: HandState) => boolean,
  ): HandMutationResult {
    const code = normalizeSessionCode(rawCode);
    return runInTransaction<HandMutationResult>(() => {
      const activeMeta = requireActiveSessionMeta(code);
      if (!activeMeta.ok) {
        return activeMeta;
      }
      const latestHand = getLatestHand(code);
      if (!latestHand || latestHand.status !== expectedStatus) {
        return { ok: false, reason: "CONFLICT", error: missingStatusError };
      }

      const next = transition(latestHand, activeMeta.config);
      if (!next.ok) {
        return next;
      }

      if (isNoOp?.(latestHand, next.value)) {
        const unchangedSession = getSession(code);
        if (!unchangedSession) {
          throw new Error(`Session ${code} disappeared during Hand mutation`);
        }
        return { ok: true, hand: latestHand, session: unchangedSession };
      }

      const now = new Date().toISOString();
      const nextJson = JSON.stringify(next.value);
      syncSeatsFromHand(code, next.value);

      const maxRow = selectMaxCheckpointStepStmt.get(code, next.value.handNumber) as
        | { max_step: number | null }
        | undefined;
      let nextStep: number;
      if (maxRow?.max_step === null || maxRow?.max_step === undefined) {
        insertCheckpointStmt.run(
          code,
          latestHand.handNumber,
          0,
          JSON.stringify(latestHand),
          now,
        );
        nextStep = 1;
      } else {
        nextStep = maxRow.max_step + 1;
      }

      insertCheckpointStmt.run(code, next.value.handNumber, nextStep, nextJson, now);
      updateHandStmt.run(
        next.value.status,
        next.value.buttonSeatNumber,
        nextJson,
        now,
        activeMeta.ledgerSeq,
        code,
        next.value.handNumber,
      );

      const updated = getSession(code);
      if (!updated) {
        throw new Error(`Session ${code} disappeared during Hand mutation`);
      }
      return { ok: true, hand: next.value, session: updated };
    });
  }

  function vacateAndRecordDeparture(
    rawCode: string,
    seatNumber: number,
    verb: "leave" | "release",
  ): SeatMutationResult {
    const code = normalizeSessionCode(rawCode);
    return runInTransaction<SeatMutationResult>(() => {
      const activeMeta = requireActiveSessionMeta(code);
      if (!activeMeta.ok) {
        return activeMeta;
      }
      if (hasActiveHand(code)) {
        return {
          ok: false,
          reason: "CONFLICT",
          error: `Cannot ${verb} a Seat while a Hand is in progress.`,
        };
      }
      const seat = selectSeatStmt.get(code, seatNumber) as unknown as StoredSeatRow | undefined;
      if (!seat || seat.player_id === null || seat.display_name === null) {
        return { ok: false, reason: "EMPTY", error: "Seat is already open." };
      }

      const vacated = vacateSeatStmt.run(code, seatNumber);
      if (vacated.changes === 0) {
        return { ok: false, reason: "CONFLICT", error: "Seat state changed concurrently." };
      }

      if (seat.total_buy_in_chips > 0 || seat.chips > 0) {
        insertDepartedPlayerStmt.run(
          randomUUID(),
          code,
          seatNumber,
          seat.player_id,
          seat.display_name,
          seat.total_buy_in_chips,
          seat.rebuy_count,
          seat.chips,
          new Date().toISOString(),
        );
        incrementSessionLedgerSeqStmt.run(code);
      }

      const updated = getSession(code);
      if (!updated) {
        throw new Error(`Session ${code} disappeared during ${verb}Seat`);
      }
      return { ok: true, session: updated };
    });
  }

  return {
    createSession(rawCode: string, hostToken: string, config: SessionConfig): StoredSession {
      const code = normalizeSessionCode(rawCode);
      db.exec("BEGIN IMMEDIATE");
      try {
        insertSessionStmt.run(code, hostToken, JSON.stringify(config), new Date().toISOString());
        for (let seatNumber = 1; seatNumber <= config.seatCount; seatNumber += 1) {
          insertSeatStmt.run(code, seatNumber);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const created = getSession(code);
      if (!created) {
        throw new Error(`Failed to reload newly created Session ${code}`);
      }
      return created;
    },

    getSession,

    claimSeat(
      rawCode: string,
      seatNumber: number,
      playerId: string,
      displayName: string,
      seatToken: string,
    ): ClaimSeatResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<ClaimSeatResult>(() => {
        const meta = getSessionMeta(code);
        if (!meta) {
          return { ok: false, reason: "NOT_FOUND" };
        }
        if (meta.status === "SETTLED") {
          return { ok: false, reason: "SETTLED" };
        }
        const startingChips = meta.config.startingStackChips;
        const result = claimSeatStmt.run(
          playerId,
          displayName,
          seatToken,
          startingChips,
          startingChips,
          code,
          seatNumber,
        );
        if (result.changes === 0) {
          return { ok: false, reason: "OCCUPIED" };
        }
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during claimSeat`);
        }
        return { ok: true, session: updated };
      });
    },

    rebuySeat(rawCode: string, seatNumber: number): SeatMutationResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<SeatMutationResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        if (hasActiveHand(code)) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Rebuy is only allowed between Hands.",
          };
        }
        const seat = selectSeatStmt.get(code, seatNumber) as unknown as StoredSeatRow | undefined;
        if (!seat || seat.player_id === null) {
          return { ok: false, reason: "EMPTY", error: "Seat is open and has no Player." };
        }
        if (seat.chips !== 0) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Rebuy is only allowed when stack is 0 Chips.",
          };
        }
        const stack = activeMeta.config.startingStackChips;
        const result = rebuySeatStmt.run(stack, stack, code, seatNumber);
        if (result.changes === 0) {
          return { ok: false, reason: "CONFLICT", error: "Seat state changed concurrently." };
        }
        incrementSessionLedgerSeqStmt.run(code);
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during rebuySeat`);
        }
        return { ok: true, session: updated };
      });
    },

    leaveSeat(rawCode: string, seatNumber: number): SeatMutationResult {
      return vacateAndRecordDeparture(rawCode, seatNumber, "leave");
    },

    releaseSeat(rawCode: string, seatNumber: number): SeatMutationResult {
      return vacateAndRecordDeparture(rawCode, seatNumber, "release");
    },

    setSeatSittingOut(
      rawCode: string,
      seatNumber: number,
      isSittingOut: boolean,
    ): SeatMutationResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<SeatMutationResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        if (hasActiveHand(code)) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Sit Out status can only be changed between Hands.",
          };
        }
        const seat = selectSeatStmt.get(code, seatNumber) as unknown as StoredSeatRow | undefined;
        if (!seat || seat.player_id === null) {
          return { ok: false, reason: "EMPTY", error: "Seat is open and has no Player." };
        }
        setSeatSittingOutStmt.run(isSittingOut ? 1 : 0, code, seatNumber);
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during setSeatSittingOut`);
        }
        return { ok: true, session: updated };
      });
    },

    endGame(rawCode): EndGameResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<EndGameResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        if (hasActiveHand(code)) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Cannot end the game while a Hand is in progress.",
          };
        }

        const now = new Date().toISOString();
        const seatRows = selectSeatsStmt.all(code) as unknown as StoredSeatRow[];
        const departedRows = selectDepartedPlayersStmt.all(
          code,
        ) as unknown as StoredDepartedPlayerRow[];

        const leaderboard = computeLeaderboard({
          seats: mapSeatRowsToViews(seatRows),
          departedPlayers: departedRows.map(mapDepartedPlayerRow),
          endedAt: now,
        });

        const settled = markSessionSettledStmt.run(JSON.stringify(leaderboard), code);
        if (settled.changes === 0) {
          return { ok: false, reason: "CONFLICT", error: "Session has already ended." };
        }

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during endGame`);
        }
        return { ok: true, leaderboard, session: updated };
      });
    },

    startHand(rawCode): HandMutationResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<HandMutationResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const latestHand = getLatestHand(code);
        if (isHandInProgress(latestHand)) {
          return { ok: false, reason: "CONFLICT", error: "A Hand is already in progress." };
        }
        const seatRows = selectSeatsStmt.all(code) as unknown as StoredSeatRow[];
        const started = startHandEngine({
          handNumber: latestHand ? latestHand.handNumber + 1 : 1,
          config: activeMeta.config,
          seats: mapSeatRowsToViews(seatRows),
          previousButtonSeatNumber: latestHand ? latestHand.buttonSeatNumber : null,
        });
        if (!started.ok) {
          return started;
        }

        const now = new Date().toISOString();
        const serialized = JSON.stringify(started.value);
        syncSeatsFromHand(code, started.value);
        insertHandStmt.run(
          code,
          started.value.handNumber,
          started.value.status,
          started.value.buttonSeatNumber,
          serialized,
          now,
          now,
          activeMeta.ledgerSeq,
        );
        prunePriorCheckpointsStmt.run(code, started.value.handNumber);
        insertCheckpointStmt.run(code, started.value.handNumber, 0, serialized, now);

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during startHand`);
        }
        return { ok: true, hand: started.value, session: updated };
      });
    },

    applyHandAction(rawCode, params): HandMutationResult {
      return mutateLatestHand(
        rawCode,
        "BETTING",
        "No active Hand is currently in a betting Street.",
        (hand, config) => applyHandActionEngine(hand, config, params),
      );
    },

    resolveShowdown(rawCode, params): HandMutationResult {
      return mutateLatestHand(
        rawCode,
        "SHOWDOWN",
        "No Hand is currently awaiting Showdown.",
        (hand, config) => resolveShowdownEngine(hand, config, params),
      );
    },

    undoHandStep(rawCode): HandMutationResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<HandMutationResult>(() => {
        const sessionRow = selectSessionStmt.get(code) as
          | { status: SessionStatus; ledger_seq: number }
          | undefined;
        const latestHandRow = getLatestHandRow(code);
        const seatRows = selectSeatsStmt.all(code) as unknown as StoredSeatRow[];
        const check = validateUndoState(code, sessionRow, latestHandRow, seatRows);
        if (!check.ok) {
          return check;
        }

        const now = new Date().toISOString();
        syncSeatsFromHand(code, check.restoredHand);
        deleteCheckpointStmt.run(code, check.restoredHand.handNumber, check.maxStep);
        updateHandStmt.run(
          check.restoredHand.status,
          check.restoredHand.buttonSeatNumber,
          JSON.stringify(check.restoredHand),
          now,
          check.sessionLedgerSeq,
          code,
          check.restoredHand.handNumber,
        );

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during undoHandStep`);
        }
        return { ok: true, hand: check.restoredHand, session: updated };
      });
    },

    getSessionHands(rawCode): GetSessionHandsResponse | null {
      const code = normalizeSessionCode(rawCode);
      const meta = getSessionMeta(code);
      if (!meta) {
        return null;
      }
      const { handHistory, sessionStats } = getHandHistoryAndStats(code);
      return {
        hands: handHistory,
        sessionStats,
      };
    },

    close(): void {
      db.close();
    },
  };
}

export function safeTokenEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Resolves Host and Seat identity from secret tokens against a stored Session.
 */
export function resolveSessionViewer(
  stored: StoredSession,
  hostToken: string | null | undefined,
  seatToken: string | null | undefined,
): ViewerIdentity {
  const isHost = safeTokenEqual(hostToken, stored.hostToken);
  const matchedSeat = stored.seats.find((seat) => safeTokenEqual(seatToken, seat.seat_token));
  return {
    isHost,
    seatNumber: matchedSeat ? matchedSeat.seat_number : null,
    playerId: matchedSeat ? matchedSeat.player_id : null,
  };
}

/**
 * Projects internal Seat and Session records to a public snapshot without leaking secret tokens.
 */
export function toSessionSnapshot(
  stored: StoredSession,
  connectedPlayers: ReadonlySet<string> = new Set(),
): SessionSnapshot {
  const seats = mapSeatRowsToViews(stored.seats, connectedPlayers);

  return {
    code: stored.code,
    status: stored.status,
    config: stored.config,
    seats,
    departedPlayers: stored.departedPlayers,
    leaderboard:
      stored.finalLeaderboard ??
      computeLeaderboard({
        seats,
        departedPlayers: stored.departedPlayers,
      }),
    hand: stored.hand,
    handInProgress: isHandInProgress(stored.hand),
    canUndo: stored.canUndo,
    handHistory: stored.handHistory,
    sessionStats: stored.sessionStats,
  };
}
