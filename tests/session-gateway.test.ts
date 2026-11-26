import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";

interface SnapshotMessage {
  type: string;
  error?: string;
  viewer: { isHost: boolean; seatNumber: number | null; playerId: string | null };
  session: {
    code: string;
    seats: Array<{
      seatNumber: number;
      occupant: {
        playerId: string;
        displayName: string;
        chips: number;
        isConnected: boolean;
        hasPendingRelink: boolean;
      } | null;
    }>;
  };
}

async function createTestSession(
  gatewayUrl: string,
  overrides: Record<string, unknown> = {},
): Promise<{
  hostToken: string;
  sharePath: string;
  shareUrl: string;
  qrCodeDataUrl: string;
  session: {
    code: string;
    config: Record<string, unknown>;
    seats: Array<{ seatNumber: number; occupant: unknown }>;
  };
}> {
  const response = await fetch(`${gatewayUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seatCount: 6,
      smallBlind: 10,
      bigBlind: 20,
      smallestChipStep: 5,
      currencySymbol: "$",
      exchangeRateChips: 100,
      exchangeRateCashMinor: 100,
      ...overrides,
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as Awaited<ReturnType<typeof createTestSession>>;
}

async function connectSubscribedWs(
  gatewayUrl: string,
  params: { code: string; hostToken?: string; seatToken?: string },
): Promise<{ ws: WebSocket; messages: SnapshotMessage[] }> {
  const wsUrl = `${gatewayUrl.replace("http://", "ws://")}/ws`;
  const ws = new WebSocket(wsUrl);
  const messages: SnapshotMessage[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", ...params }));
    });
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as SnapshotMessage);
      if (messages.length === 1) {
        resolve();
      }
    });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection error")));
  });

  return { ws, messages };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Authoritative Session Gateway", () => {
  let tmpDir: string;
  let dbPath: string;
  let gateway: SessionGateway;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "poker-gateway-"));
    dbPath = join(tmpDir, "poker.db");
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);
  });

  after(async () => {
    await gateway.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lets a Host create a Session (2-10 Seats) with stakes, exchange rate, share link, QR code, and Host token", async () => {
    const created = await createTestSession(gateway.url, {
      minBuyInChips: 500,
      maxBuyInChips: 2000,
    });

    assert.ok(created.hostToken.length >= 16);
    assert.match(created.session.code, /^[A-Z0-9]{6,10}$/);
    assert.equal(created.sharePath, `/s/${created.session.code}`);
    assert.equal(created.shareUrl, `${gateway.url}/s/${created.session.code}`);
    assert.match(created.qrCodeDataUrl, /^data:image\/png;base64,/);

    assert.deepEqual(created.session.config, {
      seatCount: 6,
      smallBlind: 10,
      bigBlind: 20,
      smallestChipStep: 5,
      currencySymbol: "$",
      exchangeRateChips: 100,
      exchangeRateCashMinor: 100,
      minBuyInChips: 500,
      maxBuyInChips: 2000,
      anteMode: "NONE",
      anteChips: 0,
      allowStraddle: false,
      allowRunItTwice: false,
    });
    assert.deepEqual(
      created.session.seats.map((s) => s.seatNumber),
      [1, 2, 3, 4, 5, 6],
    );
    assert.ok(created.session.seats.every((s) => s.occupant === null));
  });

  it("uses forwarded host headers for share URLs so LAN/proxy clients receive reachable links", async () => {
    const res = await fetch(`${gateway.url}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "192.168.1.42:5173",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({
        seatCount: 4,
        smallBlind: 5,
        bigBlind: 10,
        smallestChipStep: 5,
        currencySymbol: "$",
        exchangeRateChips: 100,
        exchangeRateCashMinor: 100,
      }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { shareUrl: string; session: { code: string } };
    assert.equal(created.shareUrl, `http://192.168.1.42:5173/s/${created.session.code}`);
  });

  it("rejects invalid Session config values", async () => {
    const res = await fetch(`${gateway.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seatCount: 1,
        smallBlind: 15,
        bigBlind: 10,
        smallestChipStep: 5,
        currencySymbol: "$",
        exchangeRateChips: 100,
        exchangeRateCashMinor: 100,
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0);
  });

  it("lets Players join via Session code and claim open Seats without exposing tokens", async () => {
    const created = await createTestSession(gateway.url, { seatCount: 4, currencySymbol: "€" });
    const code = created.session.code;

    const getBefore = await fetch(`${gateway.url}/api/sessions/${code}`);
    assert.equal(getBefore.status, 200);
    const beforeData = (await getBefore.json()) as {
      viewer: { isHost: boolean; seatNumber: number | null; playerId: string | null };
      shareUrl: string;
      qrCodeDataUrl: string;
    };
    assert.deepEqual(beforeData.viewer, { isHost: false, seatNumber: null, playerId: null });
    assert.equal(beforeData.shareUrl, `${gateway.url}/s/${code}`);
    assert.match(beforeData.qrCodeDataUrl, /^data:image\/png;base64,/);

    const claimRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 2, displayName: "  Alice  " }),
    });
    assert.equal(claimRes.status, 200);
    const claimed = (await claimRes.json()) as {
      seatToken: string;
      playerId: string;
      seatNumber: number;
      session: {
        seats: Array<{
          seatNumber: number;
          occupant: { playerId: string; displayName: string; chips: number; seatToken?: string } | null;
        }>;
      };
    };

    assert.ok(claimed.seatToken.length >= 16);
    assert.equal(claimed.seatNumber, 2);
    const seat2 = claimed.session.seats.find((s) => s.seatNumber === 2);
    assert.ok(seat2?.occupant);
    assert.equal(seat2.occupant.playerId, claimed.playerId);
    assert.equal(seat2.occupant.displayName, "Alice");
    assert.equal(seat2.occupant.chips, 0);
    assert.equal(seat2.occupant.seatToken, undefined);

    const conflictRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 2, displayName: "Bob" }),
    });
    assert.equal(conflictRes.status, 409);

    const hostClaimRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 1, displayName: "HostDave" }),
    });
    assert.equal(hostClaimRes.status, 200);
    const hostClaimed = (await hostClaimRes.json()) as { seatToken: string; playerId: string };

    const hostView = await fetch(`${gateway.url}/api/sessions/${code}`, {
      headers: {
        "x-host-token": created.hostToken,
        "x-seat-token": hostClaimed.seatToken,
      },
    });
    const hostData = (await hostView.json()) as {
      viewer: { isHost: boolean; seatNumber: number | null; playerId: string | null };
    };
    assert.deepEqual(hostData.viewer, {
      isHost: true,
      seatNumber: 1,
      playerId: hostClaimed.playerId,
    });
  });

  it("broadcasts live WebSocket snapshots, resists null frames, and preserves state across restarts", async () => {
    const created = await createTestSession(gateway.url, { seatCount: 5 });
    const code = created.session.code;

    const hostConn = await connectSubscribedWs(gateway.url, { code, hostToken: created.hostToken });
    assert.equal(hostConn.messages[0]?.type, "snapshot");
    assert.equal(hostConn.messages[0]?.viewer.isHost, true);

    // Sending JSON "null" over WebSocket returns an error frame without crashing
    hostConn.ws.send("null");
    await waitForCondition(() => hostConn.messages.some((m) => m.type === "error"));

    const claimRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 3, displayName: "Carol" }),
    });
    const claimed = (await claimRes.json()) as { seatToken: string; playerId: string };

    await waitForCondition(() =>
      hostConn.messages.some(
        (m) => m.session?.seats.find((s) => s.seatNumber === 3)?.occupant?.displayName === "Carol",
      ),
    );

    const carolConn = await connectSubscribedWs(gateway.url, { code, seatToken: claimed.seatToken });
    assert.equal(carolConn.messages[0]?.viewer.seatNumber, 3);
    await waitForCondition(() =>
      hostConn.messages.some(
        (m) => m.session?.seats.find((s) => s.seatNumber === 3)?.occupant?.isConnected === true,
      ),
    );

    hostConn.ws.close();
    carolConn.ws.close();

    // Restart server on the same SQLite database file
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    const restoredHost = await fetch(`${gateway.url}/api/sessions/${code}`, {
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(restoredHost.status, 200);
    const restoredHostJson = (await restoredHost.json()) as {
      viewer: { isHost: boolean };
      session: { seats: Array<{ seatNumber: number; occupant: { displayName: string } | null }> };
    };
    assert.equal(restoredHostJson.viewer.isHost, true);
    assert.equal(
      restoredHostJson.session.seats.find((s) => s.seatNumber === 3)?.occupant?.displayName,
      "Carol",
    );

    // WebSocket re-subscription after server restart restores both Host and Seat roles
    const restartedHostWs = await connectSubscribedWs(gateway.url, {
      code,
      hostToken: created.hostToken,
    });
    const restartedCarolWs = await connectSubscribedWs(gateway.url, {
      code,
      seatToken: claimed.seatToken,
    });
    assert.equal(restartedHostWs.messages[0]?.viewer.isHost, true);
    assert.deepEqual(restartedCarolWs.messages[0]?.viewer, {
      isHost: false,
      seatNumber: 3,
      playerId: claimed.playerId,
    });
    restartedHostWs.ws.close();
    restartedCarolWs.ws.close();
  });

  it("lets the Host relink or release a Seat while blocking unauthorized Players", async () => {
    const created = await createTestSession(gateway.url, { seatCount: 4 });
    const code = created.session.code;

    const alice = (await (
      await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatNumber: 2, displayName: "Alice" }),
      })
    ).json()) as { seatToken: string; playerId: string };

    const bob = (await (
      await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatNumber: 4, displayName: "Bob" }),
      })
    ).json()) as { seatToken: string; playerId: string };

    const unauthRelease = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/release`, {
      method: "POST",
      headers: { "x-seat-token": bob.seatToken },
    });
    assert.equal(unauthRelease.status, 403);

    const unauthRelink = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/relink`, {
      method: "POST",
      headers: { "x-seat-token": bob.seatToken, "x-host-token": "wrong-token" },
    });
    assert.equal(unauthRelink.status, 403);

    const aliceConn = await connectSubscribedWs(gateway.url, { code, seatToken: alice.seatToken });
    assert.equal(aliceConn.messages[0]?.viewer.seatNumber, 2);

    const relinkRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/relink`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(relinkRes.status, 200);
    const relink = (await relinkRes.json()) as {
      relinkCode: string;
      relinkPath: string;
      relinkUrl: string;
      qrCodeDataUrl: string;
      session: {
        seats: Array<{
          seatNumber: number;
          occupant: { displayName: string; hasPendingRelink: boolean } | null;
        }>;
      };
    };
    assert.ok(relink.relinkCode.length >= 12);
    assert.equal(relink.relinkPath, `/s/${code}?relink=${relink.relinkCode}`);
    assert.equal(relink.relinkUrl, `${gateway.url}/s/${code}?relink=${relink.relinkCode}`);
    assert.match(relink.qrCodeDataUrl, /^data:image\/png;base64,/);
    assert.equal(relink.session.seats.find((s) => s.seatNumber === 2)?.occupant?.hasPendingRelink, true);

    await waitForCondition(() => aliceConn.messages.some((m) => m.viewer.seatNumber === null));
    aliceConn.ws.close();

    const oldTokenCheck = await fetch(`${gateway.url}/api/sessions/${code}`, {
      headers: { "x-seat-token": alice.seatToken },
    });
    const oldTokenJson = (await oldTokenCheck.json()) as {
      viewer: { isHost: boolean; seatNumber: number | null; playerId: string | null };
    };
    assert.deepEqual(oldTokenJson.viewer, { isHost: false, seatNumber: null, playerId: null });

    const redeemRes = await fetch(`${gateway.url}/api/sessions/${code}/relink/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relinkCode: relink.relinkCode }),
    });
    assert.equal(redeemRes.status, 200);
    const redeemed = (await redeemRes.json()) as {
      seatToken: string;
      playerId: string;
      seatNumber: number;
      session: {
        seats: Array<{
          seatNumber: number;
          occupant: { displayName: string; hasPendingRelink: boolean } | null;
        }>;
      };
    };
    assert.notEqual(redeemed.seatToken, alice.seatToken);
    assert.equal(redeemed.playerId, alice.playerId);
    assert.equal(redeemed.seatNumber, 2);
    assert.equal(redeemed.session.seats.find((s) => s.seatNumber === 2)?.occupant?.displayName, "Alice");
    assert.equal(redeemed.session.seats.find((s) => s.seatNumber === 2)?.occupant?.hasPendingRelink, false);

    const reuseRes = await fetch(`${gateway.url}/api/sessions/${code}/relink/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relinkCode: relink.relinkCode }),
    });
    assert.equal(reuseRes.status, 404);

    const releaseRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/release`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(releaseRes.status, 200);
    const released = (await releaseRes.json()) as {
      session: { seats: Array<{ seatNumber: number; occupant: unknown }> };
    };
    assert.equal(released.session.seats.find((s) => s.seatNumber === 2)?.occupant, null);

    const afterReleaseView = await fetch(`${gateway.url}/api/sessions/${code}`, {
      headers: { "x-seat-token": redeemed.seatToken },
    });
    const afterReleaseJson = (await afterReleaseView.json()) as {
      viewer: { seatNumber: number | null };
    };
    assert.equal(afterReleaseJson.viewer.seatNumber, null);

    const danClaimRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 2, displayName: "Dan" }),
    });
    assert.equal(danClaimRes.status, 200);
  });
});
