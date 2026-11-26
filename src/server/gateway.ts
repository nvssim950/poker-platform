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

  function sendStorageFailure(
    res: ServerResponse,
    reason: "NOT_FOUND" | "REQUEST_NOT_FOUND" | "VALIDATION" | "CONFLICT" | "EMPTY" | "HAS_LEDGER_ACTIVITY",
    error: string,
  ): void {
    const status =
      reason === "NOT_FOUND" || reason === "REQUEST_NOT_FOUND"
        ? 404
        : reason === "VALIDATION"
          ? 400
          : 409;
    sendJson(res, status, { error });
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
            { error: result.reason === "NOT_FOUND" ? "Session not found." : "Seat is already occupied." },
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

      const relinkMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/seats\/(\d+)\/relink$/);
      if (method === "POST" && relinkMatch) {
        const ctx = requireHostForSeat(req, res, relinkMatch[1] ?? "", relinkMatch[2], "re-link a Seat");
        if (!ctx) {
          return;
        }

        const relinkCode = generateSecretToken();
        const result = storage.issueRelinkCode(ctx.code, ctx.seatNumber, relinkCode);
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        const relinkPath = `/s/${ctx.code}?relink=${relinkCode}`;
        const relinkUrl = `${resolveOrigin(req, options.baseUrl, boundUrl)}${relinkPath}`;
        const qrCodeDataUrl = await QRCode.toDataURL(relinkUrl, { margin: 1, width: 256 });

        broadcastSession(ctx.code);
        sendJson(res, 200, {
          relinkCode,
          relinkPath,
          relinkUrl,
          qrCodeDataUrl,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const redeemMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/relink\/redeem$/);
      if (method === "POST" && redeemMatch) {
        const code = normalizeSessionCode(redeemMatch[1] ?? "");
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON request body." });
          return;
        }

        const relinkCode =
          typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).relinkCode === "string"
            ? ((body as Record<string, unknown>).relinkCode as string).trim()
            : "";
        if (!relinkCode) {
          sendJson(res, 400, { error: "Relink code is required." });
          return;
        }

        const newSeatToken = generateSecretToken();
        const result = storage.redeemRelinkCode(code, relinkCode, newSeatToken);
        if (!result.ok) {
          sendJson(
            res,
            404,
            { error: result.reason === "NOT_FOUND" ? "Session not found." : "Relink code is invalid or expired." },
          );
          return;
        }

        broadcastSession(code);
        sendJson(res, 200, {
          seatToken: newSeatToken,
          playerId: result.playerId,
          seatNumber: result.seatNumber,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const buyInReqMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/buy-in-requests$/);
      if (method === "POST" && buyInReqMatch) {
        const code = normalizeSessionCode(buyInReqMatch[1] ?? "");
        const stored = storage.getSession(code);
        if (!stored) {
          sendJson(res, 404, { error: "Session not found." });
          return;
        }

        const hostToken = readHeaderToken(req, "x-host-token");
        const seatToken = readHeaderToken(req, "x-seat-token");
        const viewer = resolveSessionViewer(stored, hostToken, seatToken);
        if (viewer.seatNumber === null || viewer.playerId === null) {
          sendJson(res, 403, { error: "A seated Player token is required to request Chips." });
          return;
        }

        const body = await readJsonBodyOr400(req, res);
        if (body === undefined) {
          return;
        }
        if (typeof body === "object" && body !== null && "seatNumber" in body) {
          const requestedSeat = (body as Record<string, unknown>).seatNumber;
          if (requestedSeat !== undefined && requestedSeat !== viewer.seatNumber) {
            sendJson(res, 403, { error: "Players can only request Chips for their own Seat." });
            return;
          }
        }

        const payload = (typeof body === "object" && body !== null ? body : {}) as Record<
          string,
          unknown
        >;
        const result = storage.createBuyInRequest(code, {
          id: randomUUID(),
          seatNumber: viewer.seatNumber,
          playerId: viewer.playerId,
          kind: payload.kind,
          amountChips: payload.amountChips,
        });
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(code);
        sendJson(res, 201, {
          request: result.request,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const resolveReqMatch = pathname.match(
        /^\/api\/sessions\/([A-Za-z0-9]+)\/buy-in-requests\/([A-Za-z0-9-]+)\/(approve|reject)$/,
      );
      if (method === "POST" && resolveReqMatch) {
        const action = resolveReqMatch[3] as "approve" | "reject";
        const ctx = requireHostForSession(
          req,
          res,
          resolveReqMatch[1] ?? "",
          `${action} a Buy-In request`,
        );
        if (!ctx) {
          return;
        }

        const requestId = resolveReqMatch[2] ?? "";
        if (action === "approve") {
          const result = storage.approveBuyInRequest(ctx.code, requestId, randomUUID());
          if (!result.ok) {
            sendStorageFailure(res, result.reason, result.error);
            return;
          }
          broadcastSession(ctx.code);
          sendJson(res, 200, {
            request: result.request,
            ledgerEntry: result.ledgerEntry,
            session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
          });
          return;
        }

        const result = storage.rejectBuyInRequest(ctx.code, requestId);
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }
        broadcastSession(ctx.code);
        sendJson(res, 200, {
          request: result.request,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
        return;
      }

      const directLedgerMatch = pathname.match(
        /^\/api\/sessions\/([A-Za-z0-9]+)\/seats\/(\d+)\/ledger$/,
      );
      if (method === "POST" && directLedgerMatch) {
        const ctx = requireHostForSeat(
          req,
          res,
          directLedgerMatch[1] ?? "",
          directLedgerMatch[2],
          "record Chips on the ledger",
        );
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
        const result = storage.recordDirectLedgerEntry(ctx.code, {
          ledgerEntryId: randomUUID(),
          seatNumber: ctx.seatNumber,
          kind: payload.kind,
          amountChips: payload.amountChips,
        });
        if (!result.ok) {
          sendStorageFailure(res, result.reason, result.error);
          return;
        }

        broadcastSession(ctx.code);
        sendJson(res, 201, {
          ledgerEntry: result.ledgerEntry,
          session: toSessionSnapshot(result.session, getConnectedPlayers(result.session)),
        });
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
