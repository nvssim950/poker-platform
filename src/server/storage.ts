import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeSessionCode,
  validateFundingOperation,
  type BuyInRequestView,
  type FundingKind,
  type LedgerEntrySource,
  type LedgerEntryView,
  type SeatView,
  type SessionConfig,
  type SessionSnapshot,
  type ViewerIdentity,
} from "../shared/session.ts";

export interface StoredSeatRow {
  session_code: string;
  seat_number: number;
  player_id: string | null;
  display_name: string | null;
  seat_token: string | null;
  relink_code: string | null;
  chips: number;
  total_buy_in_chips: number;
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
  config: SessionConfig;
  seats: StoredSeatRow[];
  pendingRequests: BuyInRequestView[];
  ledgerEntries: LedgerEntryView[];
}

export type ClaimSeatResult =
  | { ok: true; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "OCCUPIED" };

export type SeatMutationResult =
  | { ok: true; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "EMPTY" | "HAS_LEDGER_ACTIVITY"; error: string };

export type RedeemRelinkResult =
  | { ok: true; session: StoredSession; seatNumber: number; playerId: string }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_CODE" };

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
  `);

  const seatColumns = db.prepare("PRAGMA table_info(seats)").all() as Array<{ name: string }>;
  if (!seatColumns.some((col) => col.name === "total_buy_in_chips")) {
    db.exec("ALTER TABLE seats ADD COLUMN total_buy_in_chips INTEGER NOT NULL DEFAULT 0;");
  }

  const insertSessionStmt = db.prepare(
    "INSERT INTO sessions (code, host_token, config_json, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertSeatStmt = db.prepare(
    "INSERT INTO seats (session_code, seat_number, player_id, display_name, seat_token, relink_code, chips, total_buy_in_chips) VALUES (?, ?, NULL, NULL, NULL, NULL, 0, 0)",
  );
  const selectSessionStmt = db.prepare(
    "SELECT code, host_token, config_json FROM sessions WHERE code = ?",
  );
  const selectSeatsStmt = db.prepare(
    "SELECT session_code, seat_number, player_id, display_name, seat_token, relink_code, chips, total_buy_in_chips FROM seats WHERE session_code = ? ORDER BY seat_number ASC",
  );
  const selectSeatStmt = db.prepare(
    "SELECT session_code, seat_number, player_id, display_name, seat_token, relink_code, chips, total_buy_in_chips FROM seats WHERE session_code = ? AND seat_number = ?",
  );
  const selectPendingRequestsStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, kind, amount_chips, status, created_at, resolved_at FROM buy_in_requests WHERE session_code = ? AND status = 'PENDING' ORDER BY created_at ASC, rowid ASC",
  );
  const selectRequestByIdStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, kind, amount_chips, status, created_at, resolved_at FROM buy_in_requests WHERE session_code = ? AND id = ?",
  );
  const selectLedgerEntriesStmt = db.prepare(
    "SELECT id, session_code, seat_number, player_id, display_name, kind, amount_chips, source, request_id, created_at FROM ledger_entries WHERE session_code = ? ORDER BY created_at ASC, rowid ASC",
  );
  const claimSeatStmt = db.prepare(
    "UPDATE seats SET player_id = ?, display_name = ?, seat_token = ?, relink_code = NULL WHERE session_code = ? AND seat_number = ? AND player_id IS NULL",
  );
  const releaseSeatStmt = db.prepare(
    "UPDATE seats SET player_id = NULL, display_name = NULL, seat_token = NULL, relink_code = NULL, chips = 0, total_buy_in_chips = 0 WHERE session_code = ? AND seat_number = ? AND player_id IS NOT NULL",
  );
  const rejectPendingSeatRequestsStmt = db.prepare(
    "UPDATE buy_in_requests SET status = 'REJECTED', resolved_at = ? WHERE session_code = ? AND seat_number = ? AND status = 'PENDING'",
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

  function getSession(rawCode: string): StoredSession | null {
    const code = normalizeSessionCode(rawCode);
    const row = selectSessionStmt.get(code) as
      | { code: string; host_token: string; config_json: string }
      | undefined;
    if (!row) {
      return null;
    }
    const seats = selectSeatsStmt.all(code) as unknown as StoredSeatRow[];
    const pendingRows = selectPendingRequestsStmt.all(code) as unknown as StoredBuyInRequestRow[];
    const ledgerRows = selectLedgerEntriesStmt.all(code) as unknown as StoredLedgerEntryRow[];
    return {
      code: row.code,
      hostToken: row.host_token,
      config: JSON.parse(row.config_json) as SessionConfig,
      seats,
      pendingRequests: pendingRows.map(mapBuyInRequestRow),
      ledgerEntries: ledgerRows.map(mapLedgerEntryRow),
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

  function getSessionMeta(code: string): SessionConfig | null {
    const row = selectSessionStmt.get(code) as { config_json: string } | undefined;
    return row ? (JSON.parse(row.config_json) as SessionConfig) : null;
  }

  function hasActiveHand(_code: string): boolean {
    // Forward-compatibility hook for Hand lifecycle (#4+): no active Hand table exists yet.
    return false;
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
      if (!getSession(code)) {
        return { ok: false, reason: "NOT_FOUND" };
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
    },

    releaseSeat(rawCode: string, seatNumber: number): SeatMutationResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<SeatMutationResult>(() => {
        if (!getSessionMeta(code)) {
          return { ok: false, reason: "NOT_FOUND", error: "Session not found." };
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
        releaseSeatStmt.run(code, seatNumber);
        rejectPendingSeatRequestsStmt.run(new Date().toISOString(), code, seatNumber);
        const updated = getSession(code);
        if (!updated) {
          throw new Error(`Session ${code} disappeared during releaseSeat`);
        }
        return { ok: true, session: updated };
      });
    },

    issueRelinkCode(rawCode: string, seatNumber: number, relinkCode: string): SeatMutationResult {
      const code = normalizeSessionCode(rawCode);
      if (!getSessionMeta(code)) {
        return { ok: false, reason: "NOT_FOUND", error: "Session not found." };
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
    },

    redeemRelinkCode(rawCode: string, relinkCode: string, newSeatToken: string): RedeemRelinkResult {
      const code = normalizeSessionCode(rawCode);
      return runInTransaction<RedeemRelinkResult>(() => {
        if (!getSessionMeta(code)) {
          return { ok: false, reason: "NOT_FOUND" };
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
        const config = getSessionMeta(code);
        if (!config) {
          return { ok: false, reason: "NOT_FOUND", error: "Session not found." };
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
            config,
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
        const config = getSessionMeta(code);
        if (!config) {
          return { ok: false, reason: "NOT_FOUND", error: "Session not found." };
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
          config,
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
        if (!getSessionMeta(code)) {
          return { ok: false, reason: "NOT_FOUND", error: "Session not found." };
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
        const config = getSessionMeta(code);
        if (!config) {
          return { ok: false, reason: "NOT_FOUND", error: "Session not found." };
        }
        const now = new Date().toISOString();
        const applied = applyApprovedFunding({
          code,
          config,
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
          }
        : null,
  }));

  return {
    code: stored.code,
    config: stored.config,
    seats,
    pendingRequests: stored.pendingRequests,
    ledgerEntries: stored.ledgerEntries,
  };
}
