import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeSessionCode,
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
}

export interface StoredSession {
  code: string;
  hostToken: string;
  config: SessionConfig;
  seats: StoredSeatRow[];
}

export type ClaimSeatResult =
  | { ok: true; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "OCCUPIED" };

export type SeatMutationResult =
  | { ok: true; session: StoredSession }
  | { ok: false; reason: "NOT_FOUND" | "EMPTY" };

export type RedeemRelinkResult =
  | { ok: true; session: StoredSession; seatNumber: number; playerId: string }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_CODE" };

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
  close(): void;
}

/**
 * Creates a SQLite-backed persistence adapter for Sessions and Seats.
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
      PRIMARY KEY (session_code, seat_number)
    );
  `);

  const insertSessionStmt = db.prepare(
    "INSERT INTO sessions (code, host_token, config_json, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertSeatStmt = db.prepare(
    "INSERT INTO seats (session_code, seat_number, player_id, display_name, seat_token, relink_code, chips) VALUES (?, ?, NULL, NULL, NULL, NULL, 0)",
  );
  const selectSessionStmt = db.prepare(
    "SELECT code, host_token, config_json FROM sessions WHERE code = ?",
  );
  const selectSeatsStmt = db.prepare(
    "SELECT session_code, seat_number, player_id, display_name, seat_token, relink_code, chips FROM seats WHERE session_code = ? ORDER BY seat_number ASC",
  );
  const claimSeatStmt = db.prepare(
    "UPDATE seats SET player_id = ?, display_name = ?, seat_token = ?, relink_code = NULL WHERE session_code = ? AND seat_number = ? AND player_id IS NULL",
  );
  const releaseSeatStmt = db.prepare(
    "UPDATE seats SET player_id = NULL, display_name = NULL, seat_token = NULL, relink_code = NULL, chips = 0 WHERE session_code = ? AND seat_number = ? AND player_id IS NOT NULL",
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

  function getSession(rawCode: string): StoredSession | null {
    const code = normalizeSessionCode(rawCode);
    const row = selectSessionStmt.get(code) as
      | { code: string; host_token: string; config_json: string }
      | undefined;
    if (!row) {
      return null;
    }
    const seats = selectSeatsStmt.all(code) as unknown as StoredSeatRow[];
    return {
      code: row.code,
      hostToken: row.host_token,
      config: JSON.parse(row.config_json) as SessionConfig,
      seats,
    };
  }

  function runSeatUpdate(
    rawCode: string,
    operation: string,
    execute: (code: string) => number | bigint,
  ): SeatMutationResult {
    const code = normalizeSessionCode(rawCode);
    if (!getSession(code)) {
      return { ok: false, reason: "NOT_FOUND" };
    }
    if (Number(execute(code)) === 0) {
      return { ok: false, reason: "EMPTY" };
    }
    const updated = getSession(code);
    if (!updated) {
      throw new Error(`Session ${code} disappeared during ${operation}`);
    }
    return { ok: true, session: updated };
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
      return runSeatUpdate(rawCode, "releaseSeat", (code) => releaseSeatStmt.run(code, seatNumber).changes);
    },

    issueRelinkCode(rawCode: string, seatNumber: number, relinkCode: string): SeatMutationResult {
      return runSeatUpdate(
        rawCode,
        "issueRelinkCode",
        (code) => issueRelinkStmt.run(relinkCode, code, seatNumber).changes,
      );
    },

    redeemRelinkCode(rawCode: string, relinkCode: string, newSeatToken: string): RedeemRelinkResult {
      const code = normalizeSessionCode(rawCode);
      if (!getSession(code)) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const match = findRelinkSeatStmt.get(code, relinkCode) as
          | { seat_number: number; player_id: string }
          | undefined;
        if (!match) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "INVALID_CODE" };
        }
        const update = redeemRelinkStmt.run(newSeatToken, code, match.seat_number, relinkCode);
        if (update.changes === 0) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "INVALID_CODE" };
        }
        db.exec("COMMIT");
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
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
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
 * Projects internal Seat records to a public snapshot without leaking secret tokens.
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
            isConnected: connectedPlayers.has(seat.player_id),
            hasPendingRelink: seat.relink_code !== null,
          }
        : null,
  }));

  return {
    code: stored.code,
    config: stored.config,
    seats,
  };
}
