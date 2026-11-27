import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve } from "node:path";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerWsMessage } from "../shared/protocol.ts";
import {
  normalizeSessionCode,
  validateClaimSeatInput,
  validateSessionConfig,
} from "../shared/session.ts";
import {
  createSessionStorage,
  resolveSessionViewer,
  safeTokenEqual,
  toSessionSnapshot,
  type StoredSession,
} from "./storage.ts";

export interface SessionGatewayOptions {
  dbPath: string;
  baseUrl?: string;
  staticDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function tryServeStatic(staticDir: string | undefined, pathname: string, res: ServerResponse): boolean {
  if (!staticDir || pathname.startsWith("/api/") || pathname === "/ws") {
    return false;
  }
  const root = resolve(staticDir);
  if (!existsSync(root)) {
    return false;
  }
  const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, relPath);
  if (candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()) {
    const mime = MIME_TYPES[extname(candidate)] ?? "application/octet-stream";
    const data = readFileSync(candidate);
    res.writeHead(200, { "content-type": mime, "content-length": data.length });
    res.end(data);
    return true;
  }
  const fallback = resolve(root, "index.html");
  if (existsSync(fallback)) {
    const data = readFileSync(fallback);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": data.length });
    res.end(data);
    return true;
  }
  return false;
}

export interface SessionGateway {
  readonly url: string;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateSessionCode(length = 6): string {
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? "A";
  }
  return code;
}

function generateSecretToken(): string {
  return randomBytes(24).toString("base64url");
}

function readHeaderToken(req: IncomingMessage, headerName: string): string | null {
  const raw = req.headers[headerName];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

function resolveOrigin(
  req: IncomingMessage,
  explicitBaseUrl: string | undefined,
  boundFallbackUrl: string,
): string {
  if (explicitBaseUrl) {
    return explicitBaseUrl.replace(/\/$/, "");
  }
  const forwardedHost = readHeaderToken(req, "x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = forwardedHost ?? readHeaderToken(req, "host");
  if (hostHeader) {
    const forwardedProto = readHeaderToken(req, "x-forwarded-proto")?.split(",")[0]?.trim();
    const proto = forwardedProto || "http";
    return `${proto}://${hostHeader}`;
  }
  return boundFallbackUrl || "http://localhost:3000";
}

interface SessionSubscriber {
  ws: WebSocket;
  code: string;
  hostToken: string | null;
  seatToken: string | null;
}

/**
 * Creates the Authoritative Session Gateway (HTTP + WebSocket boundary backed by SQLite).
 */
export function createSessionGateway(options: SessionGatewayOptions): SessionGateway {
  const storage = createSessionStorage(options.dbPath);
  let boundUrl = options.baseUrl ? options.baseUrl.replace(/\/$/, "") : "";
  const roomSubscribers = new Map<string, Set<SessionSubscriber>>();

  function getConnectedPlayers(stored: StoredSession): Set<string> {
    const subs = roomSubscribers.get(stored.code);
    const connected = new Set<string>();
    if (!subs) {
      return connected;
    }
    for (const sub of subs) {
      if (sub.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      const viewer = resolveSessionViewer(stored, sub.hostToken, sub.seatToken);
      if (viewer.playerId !== null) {
        connected.add(viewer.playerId);
      }
    }
    return connected;
  }

  function sendWs(ws: WebSocket, payload: ServerWsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function broadcastSession(rawCode: string): void {
    const code = normalizeSessionCode(rawCode);
    const stored = storage.getSession(code);
    const subs = roomSubscribers.get(code);
    if (!stored || !subs || subs.size === 0) {
      return;
    }
    const snapshot = toSessionSnapshot(stored, getConnectedPlayers(stored));
    for (const sub of subs) {
      const viewer = resolveSessionViewer(stored, sub.hostToken, sub.seatToken);
      sendWs(sub.ws, {
        type: "snapshot",
        session: snapshot,
        viewer,
      });
    }
  }

  function removeSubscriber(sub: SessionSubscriber | null): void {
    if (!sub) {
      return;
    }
    const subs = roomSubscribers.get(sub.code);
    if (!subs) {
      return;
    }
    subs.delete(sub);
    if (subs.size === 0) {
      roomSubscribers.delete(sub.code);
    } else {
      broadcastSession(sub.code);
    }
  }

  function requireHostForSession(
    req: IncomingMessage,
    res: ServerResponse,
    rawCode: string,
    actionDescription: string,
  ): { code: string; stored: StoredSession } | null {
    const code = normalizeSessionCode(rawCode);
    const stored = storage.getSession(code);
    if (!stored) {
      sendJson(res, 404, { error: "Session not found." });
      return null;
    }
    const hostToken = readHeaderToken(req, "x-host-token");
    if (!safeTokenEqual(hostToken, stored.hostToken)) {
      sendJson(res, 403, { error: `Host authority is required to ${actionDescription}.` });
      return null;
    }
    return { code, stored };
  }

  function requireHostForSeat(
    req: IncomingMessage,
    res: ServerResponse,
    rawCode: string,
    rawSeat: string | undefined,
    actionDescription: string,
  ): { code: string; seatNumber: number } | null {
    const sessionCtx = requireHostForSession(req, res, rawCode, actionDescription);
    if (!sessionCtx) {
      return null;
    }
    const seatNumber = Number(rawSeat);
    if (
      !Number.isInteger(seatNumber) ||
      seatNumber < 1 ||
      seatNumber > sessionCtx.stored.config.seatCount
    ) {
      sendJson(res, 400, {
        error: `Seat number must be between 1 and ${sessionCtx.stored.config.seatCount}.`,
      });
      return null;
    }
    return { code: sessionCtx.code, seatNumber };
  }

  async function readJsonBodyOr400(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    try {
      return await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON request body." });
      return undefined;
    }
  }

  function requireHostOrOwnSeat(
    req: IncomingMessage,
    res: ServerResponse,
    rawCode: string,
    rawSeat: string | undefined,
    options: { allowHost: boolean; actionDescription: string },
  ): { code: string; seatNumber: number } | null {
    const code = normalizeSessionCode(rawCode);
    const stored = storage.getSession(code);
    if (!stored) {
      sendJson(res, 404, { error: "Session not found." });
      return null;
    }

    const hostToken = readHeaderToken(req, "x-host-token");
    const seatToken = readHeaderToken(req, "x-seat-token");
    const viewer = resolveSessionViewer(stored, hostToken, seatToken);
    if ((!options.allowHost || !viewer.isHost) && viewer.seatNumber === null) {
      sendJson(res, 403, {
        error: options.allowHost
          ? `Host authority or a seated Player token is required to ${options.actionDescription}.`
          : `Seated Player token is required to ${options.actionDescription}.`,
      });
      return null;
    }

    const seatNumber = Number(rawSeat);
    if (
      !Number.isInteger(seatNumber) ||
      seatNumber < 1 ||
      seatNumber > stored.config.seatCount
    ) {
      sendJson(res, 400, {
        error: `Seat number must be between 1 and ${stored.config.seatCount}.`,
      });
      return null;
    }

    if (!(options.allowHost && viewer.isHost) && viewer.seatNumber !== seatNumber) {
      sendJson(res, 403, {
        error: `Players can only ${options.actionDescription} for their own Seat.`,
      });
      return null;
    }

    return { code, seatNumber };
  }

  function sendStorageFailure(
    res: ServerResponse,
    reason: "NOT_FOUND" | "VALIDATION" | "CONFLICT" | "EMPTY",
    error: string,
  ): void {
    const status =
      reason === "NOT_FOUND"
        ? 404
        : reason === "VALIDATION"
          ? 400
          : 409;
    sendJson(res, status, { error });
  }

  async function handleHandActionRequest(
    req: IncomingMessage,
    res: ServerResponse,
    rawCode: string,
  ): Promise<void> {
    const code = normalizeSessionCode(rawCode);
    const stored = storage.getSession(code);
    if (!stored) {
      sendJson(res, 404, { error: "Session not found." });
      return;
    }

    const hostToken = readHeaderToken(req, "x-host-token");
    const seatToken = readHeaderToken(req, "x-seat-token");
    const viewer = resolveSessionViewer(stored, hostToken, seatToken);
    if (!viewer.isHost && viewer.seatNumber === null) {
      sendJson(res, 403, { error: "Seat or Host token is required to submit a Hand Action." });
      return;
    }

    const body = await readJsonBodyOr400(req, res);
    if (body === undefined) {
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendJson(res, 400, { error: "Action payload must be an object." });
      return;
    }
    const payload = body as Record<string, unknown>;

    let targetSeatNumber: number;
    let byHostProxy = false;

    if (viewer.isHost) {
      if (payload.seatNumber !== undefined) {
        if (
          typeof payload.seatNumber !== "number" ||
          !Number.isInteger(payload.seatNumber) ||
          payload.seatNumber < 1 ||
          payload.seatNumber > stored.config.seatCount
        ) {
          sendJson(res, 400, {
            error: `Seat number must be between 1 and ${stored.config.seatCount}.`,
          });
          return;
        }
        targetSeatNumber = payload.seatNumber;
        byHostProxy = viewer.seatNumber !== targetSeatNumber;
      } else if (viewer.seatNumber !== null) {
        targetSeatNumber = viewer.seatNumber;
      } else {
        sendJson(res, 400, { error: "Seat number is required for Host proxy Action." });
        return;
      }
    } else {
      if (payload.seatNumber !== undefined && payload.seatNumber !== viewer.seatNumber) {
        sendJson(res, 403, { error: "Players can only submit Actions for their own Seat." });
        return;
      }
      targetSeatNumber = viewer.seatNumber!;
    }

    const result = storage.applyHandAction(code, {
      seatNumber: targetSeatNumber,
      action: payload.action,
      amountChips: payload.amountChips,
      byHostProxy,
    });
    if (!result.ok) {
      sendStorageFailure(res, result.reason, result.error);
      return;
    }

    broadcastSession(code);
    sendJson(res, 200, {
      hand: result.hand,
      session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (method === "POST" && pathname === "/api/sessions") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON request body." });
          return;
        }

        const validation = validateSessionConfig(body);
        if (!validation.ok) {
          sendJson(res, 400, { error: validation.error });
          return;
        }

        let code = generateSessionCode();
        while (storage.getSession(code) !== null) {
          code = generateSessionCode();
        }

        const hostToken = generateSecretToken();
        const stored = storage.createSession(code, hostToken, validation.value);
        const sharePath = `/s/${code}`;
        const shareUrl = `${resolveOrigin(req, options.baseUrl, boundUrl)}${sharePath}`;
        const qrCodeDataUrl = await QRCode.toDataURL(shareUrl, { margin: 1, width: 256 });

        sendJson(res, 201, {
          hostToken,
          sharePath,
          shareUrl,
          qrCodeDataUrl,
          session: toSessionSnapshot(stored),
        });
        return;
      }

      const getMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)$/);
      if (method === "GET" && getMatch) {
        const code = normalizeSessionCode(getMatch[1] ?? "");
        const stored = storage.getSession(code);
        if (!stored) {
          sendJson(res, 404, { error: "Session not found." });
          return;
        }
        const hostToken = readHeaderToken(req, "x-host-token");
        const seatToken = readHeaderToken(req, "x-seat-token");
        const sharePath = `/s/${code}`;
        const shareUrl = `${resolveOrigin(req, options.baseUrl, boundUrl)}${sharePath}`;
        const qrCodeDataUrl = await QRCode.toDataURL(shareUrl, { margin: 1, width: 256 });

        sendJson(res, 200, {
          sharePath,
          shareUrl,
          qrCodeDataUrl,
          session: toSessionSnapshot(stored, getConnectedPlayers(stored)),
          viewer: resolveSessionViewer(stored, hostToken, seatToken),
        });
        return;
      }

      const handsMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/hands$/);
      if (method === "GET" && handsMatch) {
        const code = normalizeSessionCode(handsMatch[1] ?? "");
        const result = storage.getSessionHands(code);
        if (!result) {
          sendJson(res, 404, { error: "Session not found." });
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      const claimMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/seats\/claim$/);
      if (method === "POST" && claimMatch) {
        const code = normalizeSessionCode(claimMatch[1] ?? "");
        const stored = storage.getSession(code);
        if (!stored) {
          sendJson(res, 404, { error: "Session not found." });
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON request body." });
          return;
        }

        const validation = validateClaimSeatInput(body, stored.config.seatCount);
        if (!validation.ok) {
          sendJson(res, 400, { error: validation.error });
          return;
        }

        const playerId = randomUUID();
        const seatToken = generateSecretToken();
        const result = storage.claimSeat(
          code,
          validation.value.seatNumber,
          playerId,
          validation.value.displayName,
          seatToken,
        );
        if (!result.ok) {
          sendJson(
            res,
            result.reason === "NOT_FOUND" ? 404 : 409,
            {
              error:
                result.reason === "NOT_FOUND"
                  ? "Session not found."
                  : result.reason === "SETTLED"
                    ? "Session has already ended."
                    : "Seat is already occupied.",
            },
          );
          return;
        }

        broadcastSession(code);
        sendJson(res, 200, {
          seatToken,
          playerId,
          seatNumber: validation.value.seatNumber,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const releaseMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/seats\/(\d+)\/release$/);
      if (method === "POST" && releaseMatch) {
        const ctx = requireHostForSeat(req, res, releaseMatch[1] ?? "", releaseMatch[2], "release a Seat");
        if (!ctx) {
          return;
        }

        const result = storage.releaseSeat(ctx.code, ctx.seatNumber);
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 200, {
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const rebuyMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/seats\/(\d+)\/rebuy$/);
      if (method === "POST" && rebuyMatch) {
        const ctx = requireHostOrOwnSeat(req, res, rebuyMatch[1] ?? "", rebuyMatch[2], {
          allowHost: true,
          actionDescription: "rebuy",
        });
        if (!ctx) {
          return;
        }

        const result = storage.rebuySeat(ctx.code, ctx.seatNumber);
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 200, {
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const leaveMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/seats\/(\d+)\/leave$/);
      if (method === "POST" && leaveMatch) {
        const ctx = requireHostOrOwnSeat(req, res, leaveMatch[1] ?? "", leaveMatch[2], {
          allowHost: false,
          actionDescription: "leave a Seat",
        });
        if (!ctx) {
          return;
        }

        const result = storage.leaveSeat(ctx.code, ctx.seatNumber);
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 200, {
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const sitOutMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/seats\/(\d+)\/sit-out$/);
      if (method === "POST" && sitOutMatch) {
        const ctx = requireHostOrOwnSeat(req, res, sitOutMatch[1] ?? "", sitOutMatch[2], {
          allowHost: true,
          actionDescription: "update Sit Out status",
        });
        if (!ctx) {
          return;
        }

        const body = await readJsonBodyOr400(req, res);
        if (body === undefined) {
          return;
        }
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          typeof (body as Record<string, unknown>).isSittingOut !== "boolean"
        ) {
          sendJson(res, 400, { error: "isSittingOut must be a boolean." });
          return;
        }

        const result = storage.setSeatSittingOut(
          ctx.code,
          ctx.seatNumber,
          (body as { isSittingOut: boolean }).isSittingOut,
        );
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 200, {
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const endGameMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/end$/);
      if (method === "POST" && endGameMatch) {
        const ctx = requireHostForSession(req, res, endGameMatch[1] ?? "", "end the game");
        if (!ctx) {
          return;
        }

        const result = storage.endGame(ctx.code);
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 200, {
          leaderboard: result.leaderboard,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const startHandMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/hand\/start$/);
      if (method === "POST" && startHandMatch) {
        const ctx = requireHostForSession(req, res, startHandMatch[1] ?? "", "start a Hand");
        if (!ctx) {
          return;
        }

        const result = storage.startHand(ctx.code);
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 201, {
          hand: result.hand,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const handActionMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/hand\/actions$/);
      if (method === "POST" && handActionMatch) {
        await handleHandActionRequest(req, res, handActionMatch[1] ?? "");
        return;
      }

      const showdownMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/hand\/showdown$/);
      if (method === "POST" && showdownMatch) {
        const ctx = requireHostForSession(req, res, showdownMatch[1] ?? "", "resolve Showdown");
        if (!ctx) {
          return;
        }

        const body = await readJsonBodyOr400(req, res);
        if (body === undefined) {
          return;
        }
        const payload = (typeof body === "object" && body !== null ? body : {}) as Record<
          string,
          unknown
        >;
        const result = storage.resolveShowdown(ctx.code, {
          winnerSeatNumbers: payload.winnerSeatNumbers,
          potId: typeof payload.potId === "string" ? payload.potId : undefined,
        });
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 200, {
          hand: result.hand,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const undoHandMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/hand\/undo$/);
      if (method === "POST" && undoHandMatch) {
        const ctx = requireHostForSession(req, res, undoHandMatch[1] ?? "", "undo a Hand step");
        if (!ctx) {
          return;
        }

        const result = storage.undoHandStep(ctx.code);
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 200, {
          hand: result.hand,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && tryServeStatic(options.staticDir, pathname, res)) {
        return;
      }

      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      sendJson(res, 500, { error: message });
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    let activeSub: SessionSubscriber | null = null;

    ws.on("message", (rawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData.toString()) as unknown;
      } catch {
        sendWs(ws, { type: "error", error: "Invalid WebSocket JSON payload." });
        return;
      }

      if (typeof parsed !== "object" || parsed === null) {
        sendWs(ws, { type: "error", error: "WebSocket payload must be a JSON object." });
        return;
      }

      const msg = parsed as Record<string, unknown>;
      if (msg.type === "subscribe" && typeof msg.code === "string") {
        const code = normalizeSessionCode(msg.code);
        const stored = storage.getSession(code);
        if (!stored) {
          sendWs(ws, { type: "error", error: "Session not found." });
          ws.close();
          return;
        }

        if (activeSub && activeSub.code !== code) {
          removeSubscriber(activeSub);
          activeSub = null;
        }

        const hostToken = typeof msg.hostToken === "string" ? msg.hostToken : null;
        const seatToken = typeof msg.seatToken === "string" ? msg.seatToken : null;

        if (!activeSub) {
          activeSub = {
            ws,
            code,
            hostToken,
            seatToken,
          };
          let subs = roomSubscribers.get(code);
          if (!subs) {
            subs = new Set();
            roomSubscribers.set(code, subs);
          }
          subs.add(activeSub);
        } else {
          activeSub.hostToken = hostToken;
          activeSub.seatToken = seatToken;
        }

        broadcastSession(code);
        return;
      }

      sendWs(ws, { type: "error", error: "Unsupported message type." });
    });

    ws.on("close", () => {
      removeSubscriber(activeSub);
      activeSub = null;
    });
  });

  return {
    get url(): string {
      return boundUrl;
    },

    async listen(port = 0, host = "127.0.0.1"): Promise<string> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo | null;
      if (!address) {
        throw new Error("Failed to determine bound server address");
      }
      if (!options.baseUrl) {
        boundUrl = `http://${host === "0.0.0.0" ? "localhost" : host}:${address.port}`;
      }
      return boundUrl;
    },

    async close(): Promise<void> {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      storage.close();
    },
  };
}
