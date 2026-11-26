import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  applyHandAction as applyHandActionEngine,
  isHandInProgress,
  normalizeHandState,
  resolveShowdown as resolveShowdownEngine,
  setRunItTwice as setRunItTwiceEngine,
  startHand as startHandEngine,
  type HandState,
} from "../shared/handEngine.ts";
import {
  normalizeSessionCode,
  normalizeSessionConfig,
  validateFundingOperation,
  type BuyInRequestView,
  type CashOutRecordView,
  type CashOutRequestView,
  type CashOutSource,
  type FundingKind,
  type GetSessionHandsResponse,
  type LedgerEntrySource,
  type LedgerEntryView,
  type SeatView,
  type SessionConfig,
  type SessionSnapshot,
  type SessionStats,
  type SessionStatus,
  type ViewerIdentity,
} from "../shared/session.ts";
import {
  computeSettlement,
  type SettlementParticipantInput,
  type SettlementSummary,
} from "../shared/settlement.ts";

export interface StoredSeatRow {
  session_code: string;
  seat_number: number;
  player_id: string | null;
  display_name: string | null;
  seat_token: string | null;
  relink_code: string | null;
  chips: number;
  total_buy_in_chips: number;
  is_sitting_out: number;
}

interface StoredBuyInRequestRow {
  id: string;
  session_code: string;
  seat_number: number;
  player_id: string;
  display_name: string;
  kind: FundingKind;
  amount_chips: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  created_at: string;
  resolved_at: string | null;
}

interface StoredCashOutRequestRow {
  id: string;
  session_code: string;
  seat_number: number;
  player_id: string;
  display_name: string;
  chips_snapshot: number;
  total_buy_in_chips_snapshot: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  created_at: string;
  resolved_at: string | null;
}

interface StoredCashOutRow {
  id: string;
  session_code: string;
  seat_number: number;
  player_id: string;
  display_name: string;
  total_buy_in_chips: number;
  ending_chips: number;
  source: CashOutSource;
  request_id: string | null;
  cashed_out_at: string;
}

interface StoredLedgerEntryRow {
  id: string;
  session_code: string;
  seat_number: number;
  player_id: string;
  display_name: string;
  kind: FundingKind;
  amount_chips: number;
  source: LedgerEntrySource;
  request_id: string | null;
  created_at: string;
}

export interface StoredSession {
  code: string;
  hostToken: string;
  status: SessionStatus;
  config: SessionConfig;
  seats: StoredSeatRow[];
  pendingRequests: BuyInRequestView[];
  pendingCashOutRequests: CashOutRequestView[];
  cashOuts: CashOutRecordView[];
  settlement: SettlementSummary | null;
  ledgerEntries: LedgerEntryView[];
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
      reason: "NOT_FOUND" | "EMPTY" | "HAS_LEDGER_ACTIVITY" | "CONFLICT";
      error: string;
    };

export type RedeemRelinkResult =
  | { ok: true; session: StoredSession; seatNumber: number; playerId: string }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_CODE" | "SETTLED" };

export type CreateBuyInRequestResult =
  | { ok: true; request: BuyInRequestView; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "VALIDATION" | "CONFLICT"; error: string };

export type ApproveBuyInRequestResult =
  | { ok: true; request: BuyInRequestView; ledgerEntry: LedgerEntryView; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "REQUEST_NOT_FOUND" | "CONFLICT"; error: string };

export type RejectBuyInRequestResult =
  | { ok: true; request: BuyInRequestView; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "REQUEST_NOT_FOUND" | "CONFLICT"; error: string };

export type RecordDirectLedgerResult =
  | { ok: true; ledgerEntry: LedgerEntryView; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "VALIDATION" | "CONFLICT"; error: string };

export type HandMutationResult =
  | { ok: true; hand: HandState; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "VALIDATION" | "CONFLICT"; error: string };

export type CreateCashOutRequestResult =
  | { ok: true; request: CashOutRequestView; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "CONFLICT"; error: string };

export type ApproveCashOutRequestResult =
  | { ok: true; request: CashOutRequestView; cashOut: CashOutRecordView; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "REQUEST_NOT_FOUND" | "CONFLICT"; error: string };

export type RejectCashOutRequestResult =
  | { ok: true; request: CashOutRequestView; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "REQUEST_NOT_FOUND" | "CONFLICT"; error: string };

export type DirectCashOutResult =
  | { ok: true; cashOut: CashOutRecordView; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "CONFLICT"; error: string };

export type SettleSessionResult =
  | { ok: true; settlement: SettlementSummary; session: StoredSession }
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
  releaseSeat(code: string, seatNumber: number): SeatMutationResult;
  setSeatSittingOut(code: string, seatNumber: number, isSittingOut: boolean): SeatMutationResult;
  issueRelinkCode(code: string, seatNumber: number, relinkCode: string): SeatMutationResult;
  redeemRelinkCode(code: string, relinkCode: string, newSeatToken: string): RedeemRelinkResult;
  createBuyInRequest(
    code: string,
    params: {
      id: string;
      seatNumber: number;
      playerId: string;
      kind: unknown;
      amountChips: unknown;
    },
  ): CreateBuyInRequestResult;
  approveBuyInRequest(
    code: string,
    requestId: string,
    ledgerEntryId: string,
  ): ApproveBuyInRequestResult;
  rejectBuyInRequest(code: string, requestId: string): RejectBuyInRequestResult;
  recordDirectLedgerEntry(
    code: string,
    params: {
      ledgerEntryId: string;
      seatNumber: number;
      kind: unknown;
      amountChips: unknown;
    },
  ): RecordDirectLedgerResult;
  createCashOutRequest(
    code: string,
    params: {
      id: string;
      seatNumber: number;
      playerId: string;
    },
  ): CreateCashOutRequestResult;
  approveCashOutRequest(
    code: string,
    requestId: string,
    cashOutId: string,
  ): ApproveCashOutRequestResult;
  rejectCashOutRequest(code: string, requestId: string): RejectCashOutRequestResult;
  directCashOutSeat(
    code: string,
    params: {
      cashOutId: string;
      seatNumber: number;
    },
  ): DirectCashOutResult;
  settleSession(code: string): SettleSessionResult;
  startHand(code: string, params?: { postStraddle?: boolean | undefined }): HandMutationResult;
  applyHandAction(
    code: string,
    params: {
      seatNumber: number;
      action: unknown;
      amountChips?: unknown;
      byHostProxy?: boolean;
    },
  ): HandMutationResult;
  setRunItTwice(
    code: string,
    params: {
      enabled: unknown;
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

function mapBuyInRequestRow(row: StoredBuyInRequestRow): BuyInRequestView {
  return {
    id: row.id,
    seatNumber: row.seat_number,
    playerId: row.player_id,
    displayName: row.display_name,
    kind: row.kind,
    amountChips: row.amount_chips,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapCashOutRequestRow(row: StoredCashOutRequestRow): CashOutRequestView {
  return {
    id: row.id,
    seatNumber: row.seat_number,
    playerId: row.player_id,
    displayName: row.display_name,
    chips: row.chips_snapshot,
    totalBuyInChips: row.total_buy_in_chips_snapshot,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapCashOutRow(row: StoredCashOutRow): CashOutRecordView {
  return {
    id: row.id,
    seatNumber: row.seat_number,
    playerId: row.player_id,
    displayName: row.display_name,
    totalBuyInChips: row.total_buy_in_chips,
    endingChips: row.ending_chips,
    source: row.source,
    requestId: row.request_id,
    cashedOutAt: row.cashed_out_at,
  };
}

function mapLedgerEntryRow(row: StoredLedgerEntryRow): LedgerEntryView {
  return {
    id: row.id,
    seatNumber: row.seat_number,
    playerId: row.player_id,
    displayName: row.display_name,
    kind: row.kind,
    amountChips: row.amount_chips,
    source: row.source,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

/**
 * Creates a SQLite-backed persistence adapter for Sessions, Seats, and the Cash/Chip ledger.
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
      relink_code TEXT,
      chips INTEGER NOT NULL DEFAULT 0,
      total_buy_in_chips INTEGER NOT NULL DEFAULT 0,
      is_sitting_out INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_code, seat_number)
    );
    CREATE TABLE IF NOT EXISTS buy_in_requests (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      seat_number INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('BUY_IN', 'REBUY', 'TOP_UP')),
      amount_chips INTEGER NOT NULL CHECK (amount_chips > 0),
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_buy_in_requests_session_status
      ON buy_in_requests (session_code, status, created_at);
    CREATE TABLE IF NOT EXISTS cash_out_requests (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      seat_number INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      chips_snapshot INTEGER NOT NULL CHECK (chips_snapshot >= 0),
      total_buy_in_chips_snapshot INTEGER NOT NULL CHECK (total_buy_in_chips_snapshot >= 0),
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cash_out_requests_session_status
      ON cash_out_requests (session_code, status, created_at);
    CREATE TABLE IF NOT EXISTS cash_outs (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      seat_number INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      total_buy_in_chips INTEGER NOT NULL CHECK (total_buy_in_chips >= 0),
      ending_chips INTEGER NOT NULL CHECK (ending_chips >= 0),
      source TEXT NOT NULL CHECK (source IN ('REQUEST_APPROVAL', 'HOST_DIRECT')),
      request_id TEXT REFERENCES cash_out_requests(id),
      cashed_out_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cash_outs_session
      ON cash_outs (session_code, cashed_out_at);
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      seat_number INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('BUY_IN', 'REBUY', 'TOP_UP')),
      amount_chips INTEGER NOT NULL CHECK (amount_chips > 0),
      source TEXT NOT NULL CHECK (source IN ('REQUEST_APPROVAL', 'HOST_DIRECT')),
      request_id TEXT REFERENCES buy_in_requests(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_session
      ON ledger_entries (session_code, created_at);
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

  const insertSessionStmt = db.prepare(
    "INSERT INTO sessions (code, host_token, config_json, status, settlement_json, ledger_seq, created_at) VALUES (?, ?, ?, 'ACTIVE', NULL, 0, ?)",
  );
  const insertSeatStmt = db.prepare(
    "INSERT INTO seats (session_code, seat_number, player_id, display_name, seat_token, relink_code, chips, total_buy_in_chips, is_sitting_out) VALUES (?, ?, NULL, NULL, NULL, NULL, 0, 0, 0)",
  );
  const selectSessionStmt = db.prepare(
    "SELECT code, host_token, config_json, status, settlement_json, ledger_seq FROM sessions WHERE code = ?",
  );
  const incrementSessionLedgerSeqStmt = db.prepare(
    "UPDATE sessions SET ledger_seq = ledger_seq + 1 WHERE code = ?",
  );
  const selectSeatsStmt = db.prepare(
    "SELECT session_code, seat_number, player_id, display_name, seat_token, relink_code, chips, total_buy_in_chips, is_sitting_out FROM seats WHERE session_code = ? ORDER BY seat_number ASC",
  );
  const selectSeatStmt = db.prepare(
    "SELECT session_code, seat_number, player_id, display_name, seat_token, relink_code, chips, total_buy_in_chips, is_sitting_out FROM seats WHERE session_code = ? AND seat_number = ?",
  );
  const selectPendingRequestsStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, kind, amount_chips, status, created_at, resolved_at FROM buy_in_requests WHERE session_code = ? AND status = 'PENDING' ORDER BY created_at ASC, rowid ASC",
  );
  const selectRequestByIdStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, kind, amount_chips, status, created_at, resolved_at FROM buy_in_requests WHERE session_code = ? AND id = ?",
  );
  const selectPendingCashOutRequestsStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, chips_snapshot, total_buy_in_chips_snapshot, status, created_at, resolved_at FROM cash_out_requests WHERE session_code = ? AND status = 'PENDING' ORDER BY created_at ASC, rowid ASC",
  );
  const selectCashOutRequestByIdStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, chips_snapshot, total_buy_in_chips_snapshot, status, created_at, resolved_at FROM cash_out_requests WHERE session_code = ? AND id = ?",
  );
  const selectPendingCashOutForPlayerStmt = db.prepare(
    "SELECT id FROM cash_out_requests WHERE session_code = ? AND seat_number = ? AND player_id = ? AND status = 'PENDING' LIMIT 1",
  );
  const insertCashOutRequestStmt = db.prepare(
    "INSERT INTO cash_out_requests (id, session_code, seat_number, player_id, display_name, chips_snapshot, total_buy_in_chips_snapshot, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL)",
  );
  const resolveCashOutRequestStmt = db.prepare(
    "UPDATE cash_out_requests SET status = ?, resolved_at = ? WHERE session_code = ? AND id = ? AND status = 'PENDING'",
  );
  const selectCashOutsStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, total_buy_in_chips, ending_chips, source, request_id, cashed_out_at FROM cash_outs WHERE session_code = ? ORDER BY cashed_out_at ASC, rowid ASC",
  );
  const insertCashOutStmt = db.prepare(
    "INSERT INTO cash_outs (id, session_code, seat_number, player_id, display_name, total_buy_in_chips, ending_chips, source, request_id, cashed_out_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectLedgerEntriesStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, kind, amount_chips, source, request_id, created_at FROM ledger_entries WHERE session_code = ? ORDER BY created_at ASC, rowid ASC",
  );
  const claimSeatStmt = db.prepare(
    "UPDATE seats SET player_id = ?, display_name = ?, seat_token = ?, relink_code = NULL, is_sitting_out = 0 WHERE session_code = ? AND seat_number = ? AND player_id IS NULL",
  );
  const vacateSeatStmt = db.prepare(
    "UPDATE seats SET player_id = NULL, display_name = NULL, seat_token = NULL, relink_code = NULL, chips = 0, total_buy_in_chips = 0, is_sitting_out = 0 WHERE session_code = ? AND seat_number = ? AND player_id IS NOT NULL",
  );
  const setSeatSittingOutStmt = db.prepare(
    "UPDATE seats SET is_sitting_out = ? WHERE session_code = ? AND seat_number = ? AND player_id IS NOT NULL",
  );
  const rejectPendingSeatBuyInRequestsStmt = db.prepare(
    "UPDATE buy_in_requests SET status = 'REJECTED', resolved_at = ? WHERE session_code = ? AND seat_number = ? AND status = 'PENDING'",
  );
  const rejectPendingSeatCashOutRequestsStmt = db.prepare(
    "UPDATE cash_out_requests SET status = 'REJECTED', resolved_at = ? WHERE session_code = ? AND seat_number = ? AND status = 'PENDING'",
  );
  const rejectAllPendingBuyInRequestsStmt = db.prepare(
    "UPDATE buy_in_requests SET status = 'REJECTED', resolved_at = ? WHERE session_code = ? AND status = 'PENDING'",
  );
  const rejectAllPendingCashOutRequestsStmt = db.prepare(
    "UPDATE cash_out_requests SET status = 'REJECTED', resolved_at = ? WHERE session_code = ? AND status = 'PENDING'",
  );
  const markSessionSettledStmt = db.prepare(
    "UPDATE sessions SET status = 'SETTLED', settlement_json = ? WHERE code = ? AND status = 'ACTIVE'",
  );
  const issueRelinkStmt = db.prepare(
    "UPDATE seats SET seat_token = NULL, relink_code = ? WHERE session_code = ? AND seat_number = ? AND player_id IS NOT NULL",
  );
  const findRelinkSeatStmt = db.prepare(
    "SELECT seat_number, player_id FROM seats WHERE session_code = ? AND relink_code = ? AND player_id IS NOT NULL",
  );
  const redeemRelinkStmt = db.prepare(
    "UPDATE seats SET seat_token = ?, relink_code = NULL WHERE session_code = ? AND seat_number = ? AND relink_code = ? AND player_id IS NOT NULL",
  );
  const insertBuyInRequestStmt = db.prepare(
    "INSERT INTO buy_in_requests (id, session_code, seat_number, player_id, display_name, kind, amount_chips, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL)",
  );
  const resolveBuyInRequestStmt = db.prepare(
    "UPDATE buy_in_requests SET status = ?, resolved_at = ? WHERE session_code = ? AND id = ? AND status = 'PENDING'",
  );
  const addSeatChipsStmt = db.prepare(
    "UPDATE seats SET chips = chips + ?, total_buy_in_chips = total_buy_in_chips + ? WHERE session_code = ? AND seat_number = ? AND player_id = ?",
  );
  const insertLedgerEntryStmt = db.prepare(
    "INSERT INTO ledger_entries (id, session_code, seat_number, player_id, display_name, kind, amount_chips, source, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
  const selectLedgerAfterStmt = db.prepare(
    "SELECT 1 AS hit FROM ledger_entries WHERE session_code = ? AND created_at > ? LIMIT 1",
  );
  const selectCashOutAfterStmt = db.prepare(
    "SELECT 1 AS hit FROM cash_outs WHERE session_code = ? AND cashed_out_at > ? LIMIT 1",
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

  function mapSeatRowsToViews(rows: readonly StoredSeatRow[]): SeatView[] {
    return rows.map((seat) => ({
      seatNumber: seat.seat_number,
      occupant:
        seat.player_id !== null && seat.display_name !== null
          ? {
              playerId: seat.player_id,
              displayName: seat.display_name,
              chips: seat.chips,
              totalBuyInChips: seat.total_buy_in_chips,
              isConnected: false,
              hasPendingRelink: seat.relink_code !== null,
              isSittingOut: seat.is_sitting_out !== 0,
            }
          : null,
    }));
  }

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
      return { ok: false, reason: "CONFLICT", error: "Session is already settled." };
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
      const hasSubsequentLedger =
        sessionRow.ledger_seq > latestHandRow.ledger_seq ||
        selectLedgerAfterStmt.get(code, latestHandRow.updated_at) !== undefined ||
        selectCashOutAfterStmt.get(code, latestHandRow.updated_at) !== undefined;
      if (hasSubsequentLedger) {
        return {
          ok: false,
          reason: "CONFLICT",
          error:
            "Cannot undo completed Hand after subsequent Buy-In, Rebuy, Top-Up, or Cash-Out activity.",
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
    const pendingRows = selectPendingRequestsStmt.all(code) as unknown as StoredBuyInRequestRow[];
    const pendingCashOutRows = selectPendingCashOutRequestsStmt.all(
      code,
    ) as unknown as StoredCashOutRequestRow[];
    const cashOutRows = selectCashOutsStmt.all(code) as unknown as StoredCashOutRow[];
    const ledgerRows = selectLedgerEntriesStmt.all(code) as unknown as StoredLedgerEntryRow[];
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
      pendingRequests: pendingRows.map(mapBuyInRequestRow),
      pendingCashOutRequests: pendingCashOutRows.map(mapCashOutRequestRow),
      cashOuts: cashOutRows.map(mapCashOutRow),
      settlement: row.settlement_json
        ? (JSON.parse(row.settlement_json) as SettlementSummary)
        : null,
      ledgerEntries: ledgerRows.map(mapLedgerEntryRow),
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
      return { ok: false, reason: "CONFLICT", error: "Session is already settled." };
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

  function executeSeatCashOut(params: {
    code: string;
    seatNumber: number;
    expectedPlayerId: string | null;
    cashOutId: string;
    source: CashOutSource;
    requestId: string | null;
    now: string;
  }): { ok: true; cashOut: CashOutRecordView } | { ok: false; reason: "CONFLICT"; error: string } {
    if (hasActiveHand(params.code)) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Cash-Out is only allowed between Hands.",
      };
    }

    const seat = selectSeatStmt.get(params.code, params.seatNumber) as unknown as
      | StoredSeatRow
      | undefined;
    if (!seat || seat.player_id === null || seat.display_name === null) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Seat is open and has no Player.",
      };
    }
    if (params.expectedPlayerId !== null && seat.player_id !== params.expectedPlayerId) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Seat is no longer occupied by the requesting Player.",
      };
    }

    const vacated = vacateSeatStmt.run(params.code, params.seatNumber);
    if (vacated.changes === 0) {
      return { ok: false, reason: "CONFLICT", error: "Seat state changed concurrently." };
    }

    if (params.requestId !== null) {
      const resolved = resolveCashOutRequestStmt.run(
        "APPROVED",
        params.now,
        params.code,
        params.requestId,
      );
      if (resolved.changes === 0) {
        return {
          ok: false,
          reason: "CONFLICT",
          error: "Cash-Out request has already been resolved.",
        };
      }
    }

    insertCashOutStmt.run(
      params.cashOutId,
      params.code,
      params.seatNumber,
      seat.player_id,
      seat.display_name,
      seat.total_buy_in_chips,
      seat.chips,
      params.source,
      params.requestId,
      params.now,
    );
    incrementSessionLedgerSeqStmt.run(params.code);

    rejectPendingSeatBuyInRequestsStmt.run(params.now, params.code, params.seatNumber);
    rejectPendingSeatCashOutRequestsStmt.run(params.now, params.code, params.seatNumber);

    return {
      ok: true,
      cashOut: {
        id: params.cashOutId,
        seatNumber: params.seatNumber,
        playerId: seat.player_id,
        displayName: seat.display_name,
        totalBuyInChips: seat.total_buy_in_chips,
        endingChips: seat.chips,
        source: params.source,
        requestId: params.requestId,
        cashedOutAt: params.now,
      },
    };
  }

  function applyApprovedFunding(params: {
    code: string;
    config: SessionConfig;
    seatNumber: number;
    expectedPlayerId: string | null;
    kind: unknown;
    amountChips: unknown;
    ledgerEntryId: string;
    source: LedgerEntrySource;
    requestId: string | null;
    now: string;
  }):
    | { ok: true; ledgerEntry: LedgerEntryView }
    | { ok: false; reason: "VALIDATION" | "CONFLICT"; error: string } {
    const seat = selectSeatStmt.get(params.code, params.seatNumber) as unknown as
      | StoredSeatRow
      | undefined;
    if (!seat || seat.player_id === null || seat.display_name === null) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Seat is open and has no Player.",
      };
    }
    if (params.expectedPlayerId !== null && seat.player_id !== params.expectedPlayerId) {
      return {
        ok: false,
        reason: "CONFLICT",
        error: "Seat is no longer occupied by the requesting Player.",
      };
    }

    const validation = validateFundingOperation(
      { kind: params.kind, amountChips: params.amountChips },
      {
        config: params.config,
        chips: seat.chips,
        totalBuyInChips: seat.total_buy_in_chips,
        handInProgress: hasActiveHand(params.code),
      },
    );
    if (!validation.ok) {
      return validation;
    }

    const { kind, amountChips } = validation.value;
    const updated = addSeatChipsStmt.run(
      amountChips,
      amountChips,
      params.code,
      params.seatNumber,
      seat.player_id,
    );
    if (updated.changes === 0) {
      return { ok: false, reason: "CONFLICT", error: "Seat state changed concurrently." };
    }

    insertLedgerEntryStmt.run(
      params.ledgerEntryId,
      params.code,
      params.seatNumber,
      seat.player_id,
      seat.display_name,
      kind,
      amountChips,
      params.source,
      params.requestId,
      params.now,
    );
    incrementSessionLedgerSeqStmt.run(params.code);

    return {
      ok: true,
      ledgerEntry: {
        id: params.ledgerEntryId,
        seatNumber: params.seatNumber,
        playerId: seat.player_id,
        displayName: seat.display_name,
        kind,
        amountChips,
        source: params.source,
        requestId: params.requestId,
        createdAt: params.now,
      },
    };
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
        const result = claimSeatStmt.run(playerId, displayName, seatToken, code, seatNumber);
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

    releaseSeat(rawCode: string, seatNumber: number): SeatMutationResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<SeatMutationResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const seat = selectSeatStmt.get(code, seatNumber) as unknown as StoredSeatRow | undefined;
        if (!seat || seat.player_id === null) {
          return { ok: false, reason: "EMPTY", error: "Seat is already open." };
        }
        if (seat.chips > 0 || seat.total_buy_in_chips > 0) {
          return {
            ok: false,
            reason: "HAS_LEDGER_ACTIVITY",
            error: "Cannot release a Seat with Chips or recorded Buy-Ins on the ledger.",
          };
        }
        const activeHand = getLatestHand(code);
        if (
          activeHand &&
          isHandInProgress(activeHand) &&
          activeHand.seats.some((s) => s.seatNumber === seatNumber)
        ) {
          return {
            ok: false,
            reason: "HAS_LEDGER_ACTIVITY",
            error: "Cannot release a Seat participating in an active Hand.",
          };
        }
        const now = new Date().toISOString();
        vacateSeatStmt.run(code, seatNumber);
        rejectPendingSeatBuyInRequestsStmt.run(now, code, seatNumber);
        rejectPendingSeatCashOutRequestsStmt.run(now, code, seatNumber);
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during releaseSeat`);
        }
        return { ok: true, session: updated };
      });
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

    issueRelinkCode(rawCode: string, seatNumber: number, relinkCode: string): SeatMutationResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<SeatMutationResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        if (Number(issueRelinkStmt.run(relinkCode, code, seatNumber).changes) === 0) {
          return {
            ok: false,
            reason: "EMPTY",
            error: "Seat is open and has no Player to re-link.",
          };
        }
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during issueRelinkCode`);
        }
        return { ok: true, session: updated };
      });
    },

    redeemRelinkCode(rawCode: string, relinkCode: string, newSeatToken: string): RedeemRelinkResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<RedeemRelinkResult>(() => {
        const meta = getSessionMeta(code);
        if (!meta) {
          return { ok: false, reason: "NOT_FOUND" };
        }
        if (meta.status === "SETTLED") {
          return { ok: false, reason: "SETTLED" };
        }
        const match = findRelinkSeatStmt.get(code, relinkCode) as
          | { seat_number: number; player_id: string }
          | undefined;
        if (!match) {
          return { ok: false, reason: "INVALID_CODE" };
        }
        const update = redeemRelinkStmt.run(newSeatToken, code, match.seat_number, relinkCode);
        if (update.changes === 0) {
          return { ok: false, reason: "INVALID_CODE" };
        }
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during redeemRelinkCode`);
        }
        return {
          ok: true,
          session: updated,
          seatNumber: match.seat_number,
          playerId: match.player_id,
        };
      });
    },

    createBuyInRequest(rawCode, params): CreateBuyInRequestResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<CreateBuyInRequestResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const seat = selectSeatStmt.get(code, params.seatNumber) as unknown as
          | StoredSeatRow
          | undefined;
        if (!seat || seat.player_id !== params.playerId || seat.display_name === null) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Seat is not occupied by this Player.",
          };
        }
        const validation = validateFundingOperation(
          { kind: params.kind, amountChips: params.amountChips },
          {
            config: activeMeta.config,
            chips: seat.chips,
            totalBuyInChips: seat.total_buy_in_chips,
            handInProgress: hasActiveHand(code),
          },
        );
        if (!validation.ok) {
          return validation;
        }
        const now = new Date().toISOString();
        insertBuyInRequestStmt.run(
          params.id,
          code,
          params.seatNumber,
          seat.player_id,
          seat.display_name,
          validation.value.kind,
          validation.value.amountChips,
          now,
        );
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during createBuyInRequest`);
        }
        return {
          ok: true,
          request: {
            id: params.id,
            seatNumber: params.seatNumber,
            playerId: seat.player_id,
            displayName: seat.display_name,
            kind: validation.value.kind,
            amountChips: validation.value.amountChips,
            status: "PENDING",
            createdAt: now,
          },
          session: updated,
        };
      });
    },

    approveBuyInRequest(rawCode, requestId, ledgerEntryId): ApproveBuyInRequestResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<ApproveBuyInRequestResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const reqRow = selectRequestByIdStmt.get(code, requestId) as unknown as
          | StoredBuyInRequestRow
          | undefined;
        if (!reqRow) {
          return {
            ok: false,
            reason: "REQUEST_NOT_FOUND",
            error: "Buy-In request not found.",
          };
        }
        if (reqRow.status !== "PENDING") {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Buy-In request has already been resolved.",
          };
        }

        const now = new Date().toISOString();
        const applied = applyApprovedFunding({
          code,
          config: activeMeta.config,
          seatNumber: reqRow.seat_number,
          expectedPlayerId: reqRow.player_id,
          kind: reqRow.kind,
          amountChips: reqRow.amount_chips,
          ledgerEntryId,
          source: "REQUEST_APPROVAL",
          requestId: reqRow.id,
          now,
        });
        if (!applied.ok) {
          return { ok: false, reason: "CONFLICT", error: applied.error };
        }

        const resolved = resolveBuyInRequestStmt.run("APPROVED", now, code, reqRow.id);
        if (resolved.changes === 0) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Buy-In request has already been resolved.",
          };
        }

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during approveBuyInRequest`);
        }
        return {
          ok: true,
          request: { ...mapBuyInRequestRow(reqRow), status: "APPROVED" },
          ledgerEntry: applied.ledgerEntry,
          session: updated,
        };
      });
    },

    rejectBuyInRequest(rawCode, requestId): RejectBuyInRequestResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<RejectBuyInRequestResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const reqRow = selectRequestByIdStmt.get(code, requestId) as unknown as
          | StoredBuyInRequestRow
          | undefined;
        if (!reqRow) {
          return {
            ok: false,
            reason: "REQUEST_NOT_FOUND",
            error: "Buy-In request not found.",
          };
        }
        if (reqRow.status !== "PENDING") {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Buy-In request has already been resolved.",
          };
        }

        const now = new Date().toISOString();
        const resolved = resolveBuyInRequestStmt.run("REJECTED", now, code, reqRow.id);
        if (resolved.changes === 0) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Buy-In request has already been resolved.",
          };
        }

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during rejectBuyInRequest`);
        }
        return {
          ok: true,
          request: { ...mapBuyInRequestRow(reqRow), status: "REJECTED" },
          session: updated,
        };
      });
    },

    recordDirectLedgerEntry(rawCode, params): RecordDirectLedgerResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<RecordDirectLedgerResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const now = new Date().toISOString();
        const applied = applyApprovedFunding({
          code,
          config: activeMeta.config,
          seatNumber: params.seatNumber,
          expectedPlayerId: null,
          kind: params.kind,
          amountChips: params.amountChips,
          ledgerEntryId: params.ledgerEntryId,
          source: "HOST_DIRECT",
          requestId: null,
          now,
        });
        if (!applied.ok) {
          return applied;
        }
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during recordDirectLedgerEntry`);
        }
        return {
          ok: true,
          ledgerEntry: applied.ledgerEntry,
          session: updated,
        };
      });
    },

    createCashOutRequest(rawCode, params): CreateCashOutRequestResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<CreateCashOutRequestResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        if (hasActiveHand(code)) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Cash-Out can only be requested between Hands.",
          };
        }
        const seat = selectSeatStmt.get(code, params.seatNumber) as unknown as
          | StoredSeatRow
          | undefined;
        if (!seat || seat.player_id !== params.playerId || seat.display_name === null) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Seat is not occupied by this Player.",
          };
        }
        const existingPending = selectPendingCashOutForPlayerStmt.get(
          code,
          params.seatNumber,
          seat.player_id,
        ) as { id: string } | undefined;
        if (existingPending) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "A Cash-Out request is already pending for this Seat.",
          };
        }
        const now = new Date().toISOString();
        insertCashOutRequestStmt.run(
          params.id,
          code,
          params.seatNumber,
          seat.player_id,
          seat.display_name,
          seat.chips,
          seat.total_buy_in_chips,
          now,
        );
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during createCashOutRequest`);
        }
        return {
          ok: true,
          request: {
            id: params.id,
            seatNumber: params.seatNumber,
            playerId: seat.player_id,
            displayName: seat.display_name,
            chips: seat.chips,
            totalBuyInChips: seat.total_buy_in_chips,
            status: "PENDING",
            createdAt: now,
          },
          session: updated,
        };
      });
    },

    approveCashOutRequest(rawCode, requestId, cashOutId): ApproveCashOutRequestResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<ApproveCashOutRequestResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const reqRow = selectCashOutRequestByIdStmt.get(code, requestId) as unknown as
          | StoredCashOutRequestRow
          | undefined;
        if (!reqRow) {
          return {
            ok: false,
            reason: "REQUEST_NOT_FOUND",
            error: "Cash-Out request not found.",
          };
        }
        if (reqRow.status !== "PENDING") {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Cash-Out request has already been resolved.",
          };
        }

        const now = new Date().toISOString();
        const applied = executeSeatCashOut({
          code,
          seatNumber: reqRow.seat_number,
          expectedPlayerId: reqRow.player_id,
          cashOutId,
          source: "REQUEST_APPROVAL",
          requestId: reqRow.id,
          now,
        });
        if (!applied.ok) {
          return applied;
        }

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during approveCashOutRequest`);
        }
        return {
          ok: true,
          request: { ...mapCashOutRequestRow(reqRow), status: "APPROVED" },
          cashOut: applied.cashOut,
          session: updated,
        };
      });
    },

    rejectCashOutRequest(rawCode, requestId): RejectCashOutRequestResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<RejectCashOutRequestResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const reqRow = selectCashOutRequestByIdStmt.get(code, requestId) as unknown as
          | StoredCashOutRequestRow
          | undefined;
        if (!reqRow) {
          return {
            ok: false,
            reason: "REQUEST_NOT_FOUND",
            error: "Cash-Out request not found.",
          };
        }
        if (reqRow.status !== "PENDING") {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Cash-Out request has already been resolved.",
          };
        }

        const now = new Date().toISOString();
        const resolved = resolveCashOutRequestStmt.run("REJECTED", now, code, reqRow.id);
        if (resolved.changes === 0) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Cash-Out request has already been resolved.",
          };
        }

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during rejectCashOutRequest`);
        }
        return {
          ok: true,
          request: { ...mapCashOutRequestRow(reqRow), status: "REJECTED" },
          session: updated,
        };
      });
    },

    directCashOutSeat(rawCode, params): DirectCashOutResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<DirectCashOutResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        const now = new Date().toISOString();
        const applied = executeSeatCashOut({
          code,
          seatNumber: params.seatNumber,
          expectedPlayerId: null,
          cashOutId: params.cashOutId,
          source: "HOST_DIRECT",
          requestId: null,
          now,
        });
        if (!applied.ok) {
          return applied;
        }

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during directCashOutSeat`);
        }
        return {
          ok: true,
          cashOut: applied.cashOut,
          session: updated,
        };
      });
    },

    settleSession(rawCode): SettleSessionResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<SettleSessionResult>(() => {
        const activeMeta = requireActiveSessionMeta(code);
        if (!activeMeta.ok) {
          return activeMeta;
        }
        if (hasActiveHand(code)) {
          return {
            ok: false,
            reason: "CONFLICT",
            error: "Cannot settle the Session while a Hand is in progress.",
          };
        }

        const now = new Date().toISOString();
        const cashOutRows = selectCashOutsStmt.all(code) as unknown as StoredCashOutRow[];
        const seatRows = selectSeatsStmt.all(code) as unknown as StoredSeatRow[];

        const participants: SettlementParticipantInput[] = [];
        for (const row of cashOutRows) {
          participants.push({
            participantId: row.player_id,
            displayName: row.display_name,
            seatNumber: row.seat_number,
            totalBuyInChips: row.total_buy_in_chips,
            endingChips: row.ending_chips,
            status: "CASHED_OUT",
            cashedOutAt: row.cashed_out_at,
          });
        }
        for (const seat of seatRows) {
          if (
            seat.player_id !== null &&
            seat.display_name !== null &&
            (seat.total_buy_in_chips > 0 || seat.chips > 0)
          ) {
            participants.push({
              participantId: seat.player_id,
              displayName: seat.display_name,
              seatNumber: seat.seat_number,
              totalBuyInChips: seat.total_buy_in_chips,
              endingChips: seat.chips,
              status: "SETTLED",
              cashedOutAt: null,
            });
          }
        }

        const settlement = computeSettlement({
          participants,
          exchangeRateChips: activeMeta.config.exchangeRateChips,
          exchangeRateCashMinor: activeMeta.config.exchangeRateCashMinor,
          settledAt: now,
        });

        rejectAllPendingBuyInRequestsStmt.run(now, code);
        rejectAllPendingCashOutRequestsStmt.run(now, code);
        const settled = markSessionSettledStmt.run(JSON.stringify(settlement), code);
        if (settled.changes === 0) {
          return { ok: false, reason: "CONFLICT", error: "Session is already settled." };
        }

        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during settleSession`);
        }
        return { ok: true, settlement, session: updated };
      });
    },

    startHand(rawCode, params): HandMutationResult {
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
          postStraddle: params?.postStraddle,
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

    setRunItTwice(rawCode, params): HandMutationResult {
      return mutateLatestHand(
        rawCode,
        "SHOWDOWN",
        "No Hand is currently awaiting Showdown.",
        (hand, config) => setRunItTwiceEngine(hand, config, params.enabled),
        (prev, next) => prev.runItTwice === next.runItTwice,
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
 * Projects internal Seat and ledger records to a public snapshot without leaking secret tokens.
 */
export function toSessionSnapshot(
  stored: StoredSession,
  connectedPlayers: ReadonlySet<string> = new Set(),
): SessionSnapshot {
  const seats: SeatView[] = stored.seats.map((seat) => ({
    seatNumber: seat.seat_number,
    occupant:
      seat.player_id !== null && seat.display_name !== null
        ? {
            playerId: seat.player_id,
            displayName: seat.display_name,
            chips: seat.chips,
            totalBuyInChips: seat.total_buy_in_chips,
            isConnected: connectedPlayers.has(seat.player_id),
            hasPendingRelink: seat.relink_code !== null,
            isSittingOut: seat.is_sitting_out !== 0,
          }
        : null,
  }));

  return {
    code: stored.code,
    status: stored.status,
    config: stored.config,
    seats,
    pendingRequests: stored.pendingRequests,
    pendingCashOutRequests: stored.pendingCashOutRequests,
    cashOuts: stored.cashOuts,
    settlement: stored.settlement,
    ledgerEntries: stored.ledgerEntries,
    hand: stored.hand,
    handInProgress: isHandInProgress(stored.hand),
    canUndo: stored.canUndo,
    handHistory: stored.handHistory,
    sessionStats: stored.sessionStats,
  };
}
