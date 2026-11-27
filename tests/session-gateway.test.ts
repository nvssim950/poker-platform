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
      startingStackChips: 1000,
      smallBlind: 10,
      bigBlind: 20,
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

  it("lets a Host create a Session (2-10 Seats) with Starting Stack, Blinds, share link, QR code, and Host token", async () => {
    const created = await createTestSession(gateway.url, {
      startingStackChips: 1500,
    });

    assert.ok(created.hostToken.length >= 16);
    assert.match(created.session.code, /^[A-Z0-9]{6,10}$/);
    assert.equal(created.sharePath, `/s/${created.session.code}`);
    assert.equal(created.shareUrl, `${gateway.url}/s/${created.session.code}`);
    assert.match(created.qrCodeDataUrl, /^data:image\/png;base64,/);

    assert.deepEqual(created.session.config, {
      seatCount: 6,
      startingStackChips: 1500,
      smallBlind: 10,
      bigBlind: 20,
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
        startingStackChips: 500,
        smallBlind: 5,
        bigBlind: 10,
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
        startingStackChips: 0,
        smallBlind: 15,
        bigBlind: 10,
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0);
  });

  it("applies default Session config values when fields are omitted", async () => {
    const res = await fetch(`${gateway.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as {
      session: { config: Record<string, unknown>; seats: Array<unknown> };
    };
    assert.deepEqual(created.session.config, {
      seatCount: 8,
      startingStackChips: 1000,
      smallBlind: 10,
      bigBlind: 20,
    });
    assert.equal(created.session.seats.length, 8);
  });

  it("lets Players join via Session code and claim open Seats with automatic Starting Stack", async () => {
    const created = await createTestSession(gateway.url, { seatCount: 4, startingStackChips: 1200 });
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
          occupant: {
            playerId: string;
            displayName: string;
            chips: number;
            totalBuyInChips: number;
            seatToken?: string;
          } | null;
        }>;
      };
    };

    assert.ok(claimed.seatToken.length >= 16);
    assert.equal(claimed.seatNumber, 2);
    const seat2 = claimed.session.seats.find((s) => s.seatNumber === 2);
    assert.ok(seat2?.occupant);
    assert.equal(seat2.occupant.playerId, claimed.playerId);
    assert.equal(seat2.occupant.displayName, "Alice");
    assert.equal(seat2.occupant.chips, 1200);
    assert.equal(seat2.occupant.totalBuyInChips, 1200);
    assert.equal(seat2.occupant.seatToken, undefined);

    const buyInRes = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": claimed.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 500 }),
    });
    assert.equal(buyInRes.status, 404);

    const directLedgerRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": created.hostToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 500 }),
    });
    assert.equal(directLedgerRes.status, 404);

    const cashOutReqRes = await fetch(`${gateway.url}/api/sessions/${code}/cash-out-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": claimed.seatToken },
      body: JSON.stringify({}),
    });
    assert.equal(cashOutReqRes.status, 404);

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

  it("supports instant self-service Rebuy at 0 Chips, Leave Seat, Host Release with departed snapshot, and removes Relink", async () => {
    const created = await createTestSession(gateway.url, {
      seatCount: 4,
      startingStackChips: 100,
      smallBlind: 10,
      bigBlind: 20,
    });
    const code = created.session.code;

    const alice = (await (
      await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatNumber: 1, displayName: "Alice" }),
      })
    ).json()) as { seatToken: string; playerId: string };

    const bob = (await (
      await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatNumber: 2, displayName: "Bob" }),
      })
    ).json()) as { seatToken: string; playerId: string };

    // Relink endpoints are removed (404)
    const relinkRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/relink`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(relinkRes.status, 404);

    // Rebuy rejected when chips > 0 (409)
    const earlyRebuy = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/rebuy`, {
      method: "POST",
      headers: { "x-seat-token": alice.seatToken },
    });
    assert.equal(earlyRebuy.status, 409);

    // Play a Hand so Alice busts to 0 Chips and Bob goes to 200 Chips
    const startRes = await fetch(`${gateway.url}/api/sessions/${code}/hand/start`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    const started = (await startRes.json()) as { hand: Record<string, unknown> };
    assert.equal("dealPrompt" in started.hand, false);
    assert.equal("straddleSeatNumber" in started.hand, false);
    assert.equal("runItTwice" in started.hand, false);

    // Removed house-rule Hand endpoints return 404
    const straddleRes = await fetch(`${gateway.url}/api/sessions/${code}/hand/straddle`, {
      method: "POST",
      headers: { "x-seat-token": alice.seatToken },
    });
    assert.equal(straddleRes.status, 404);

    const ritRes = await fetch(`${gateway.url}/api/sessions/${code}/hand/run-it-twice`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": created.hostToken },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(ritRes.status, 404);

    // Leave/Release/Rebuy blocked during active Hand (409)
    const midHandLeave = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/leave`, {
      method: "POST",
      headers: { "x-seat-token": alice.seatToken },
    });
    assert.equal(midHandLeave.status, 409);

    await fetch(`${gateway.url}/api/sessions/${code}/hand/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ action: "ALL_IN" }),
    });
    await fetch(`${gateway.url}/api/sessions/${code}/hand/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": bob.seatToken },
      body: JSON.stringify({ action: "CALL" }),
    });
    await fetch(`${gateway.url}/api/sessions/${code}/hand/showdown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": created.hostToken },
      body: JSON.stringify({ winnerSeatNumbers: [2] }),
    });

    // Bob cannot rebuy for Alice (403)
    const unauthRebuy = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/rebuy`, {
      method: "POST",
      headers: { "x-seat-token": bob.seatToken },
    });
    assert.equal(unauthRebuy.status, 403);

    // Alice self-rebuy succeeds without Host approval!
    const aliceRebuyRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/rebuy`, {
      method: "POST",
      headers: { "x-seat-token": alice.seatToken },
    });
    assert.equal(aliceRebuyRes.status, 200);
    const afterRebuy = (await aliceRebuyRes.json()) as {
      session: {
        canUndo: boolean;
        seats: Array<{
          seatNumber: number;
          occupant: { chips: number; totalBuyInChips: number; rebuyCount: number } | null;
        }>;
      };
    };
    assert.equal(afterRebuy.session.canUndo, false);
    const aliceOcc = afterRebuy.session.seats.find((s) => s.seatNumber === 1)?.occupant;
    assert.equal(aliceOcc?.chips, 100);
    assert.equal(aliceOcc?.totalBuyInChips, 200);
    assert.equal(aliceOcc?.rebuyCount, 1);

    // Bob cannot leave Alice's seat (403)
    const unauthLeave = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/leave`, {
      method: "POST",
      headers: { "x-seat-token": bob.seatToken },
    });
    assert.equal(unauthLeave.status, 403);

    // Bob leaves Seat 2 voluntarily -> Seat 2 opens, token revoked, departed snapshot preserved
    const bobLeaveRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/leave`, {
      method: "POST",
      headers: { "x-seat-token": bob.seatToken },
    });
    assert.equal(bobLeaveRes.status, 200);
    const afterBobLeave = (await bobLeaveRes.json()) as {
      session: {
        seats: Array<{ seatNumber: number; occupant: unknown }>;
        departedPlayers: Array<{
          seatNumber: number;
          displayName: string;
          endingChips: number;
          totalIssuedChips: number;
          rebuyCount: number;
        }>;
      };
    };
    assert.equal(afterBobLeave.session.seats.find((s) => s.seatNumber === 2)?.occupant, null);
    assert.equal(afterBobLeave.session.departedPlayers.length, 1);
    assert.equal(afterBobLeave.session.departedPlayers[0]?.displayName, "Bob");
    assert.equal(afterBobLeave.session.departedPlayers[0]?.endingChips, 200);
    assert.equal(afterBobLeave.session.departedPlayers[0]?.totalIssuedChips, 100);
    assert.equal(afterBobLeave.session.departedPlayers[0]?.rebuyCount, 0);

    // Bob's old token is now invalid
    const bobView = await fetch(`${gateway.url}/api/sessions/${code}`, {
      headers: { "x-seat-token": bob.seatToken },
    });
    const bobViewer = (await bobView.json()) as { viewer: { seatNumber: number | null } };
    assert.equal(bobViewer.viewer.seatNumber, null);

    // Host removes (Releases) Alice from Seat 1 -> snapshot preserved too
    const hostRemoveRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/release`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(hostRemoveRes.status, 200);
    const afterHostRemove = (await hostRemoveRes.json()) as {
      session: {
        seats: Array<{ seatNumber: number; occupant: unknown }>;
        departedPlayers: Array<{
          seatNumber: number;
          displayName: string;
          endingChips: number;
          totalIssuedChips: number;
          rebuyCount: number;
        }>;
      };
    };
    assert.equal(afterHostRemove.session.seats.find((s) => s.seatNumber === 1)?.occupant, null);
    assert.equal(afterHostRemove.session.departedPlayers.length, 2);
    assert.equal(afterHostRemove.session.departedPlayers[1]?.displayName, "Alice");
    assert.equal(afterHostRemove.session.departedPlayers[1]?.totalIssuedChips, 200);
    assert.equal(afterHostRemove.session.departedPlayers[1]?.rebuyCount, 1);
  });
});
