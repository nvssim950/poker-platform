import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";
import {
  chipsToCashMinor,
  formatChipsAsCash,
  validateFundingOperation,
} from "../src/shared/session.ts";

interface SnapshotMessage {
  type: string;
  error?: string;
  viewer: { isHost: boolean; seatNumber: number | null; playerId: string | null };
  session: {
    code: string;
    config: {
      seatCount: number;
      smallBlind: number;
      bigBlind: number;
      smallestChipStep: number;
      currencySymbol: string;
      exchangeRateChips: number;
      exchangeRateCashMinor: number;
      minBuyInChips: number | null;
      maxBuyInChips: number | null;
    };
    seats: Array<{
      seatNumber: number;
      occupant: {
        playerId: string;
        displayName: string;
        chips: number;
        totalBuyInChips: number;
        isConnected: boolean;
        hasPendingRelink: boolean;
      } | null;
    }>;
    pendingRequests: Array<{
      id: string;
      seatNumber: number;
      playerId: string;
      displayName: string;
      kind: "BUY_IN" | "REBUY" | "TOP_UP";
      amountChips: number;
      status: "PENDING" | "APPROVED" | "REJECTED";
      createdAt: string;
    }>;
    ledgerEntries: Array<{
      id: string;
      seatNumber: number;
      playerId: string;
      displayName: string;
      kind: "BUY_IN" | "REBUY" | "TOP_UP";
      amountChips: number;
      source: "REQUEST_APPROVAL" | "HOST_DIRECT";
      requestId: string | null;
      createdAt: string;
    }>;
  };
}

async function createTestSession(
  gatewayUrl: string,
  overrides: Record<string, unknown> = {},
): Promise<{
  hostToken: string;
  session: SnapshotMessage["session"];
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
      minBuyInChips: 500,
      maxBuyInChips: 2000,
      ...overrides,
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { hostToken: string; session: SnapshotMessage["session"] };
}

async function claimSeat(
  gatewayUrl: string,
  code: string,
  seatNumber: number,
  displayName: string,
): Promise<{ seatToken: string; playerId: string; seatNumber: number }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/seats/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seatNumber, displayName }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { seatToken: string; playerId: string; seatNumber: number };
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

describe("Host-Approved Buy-Ins, Rebuys & Top-Ups Ledger", () => {
  let tmpDir: string;
  let dbPath: string;
  let gateway: SessionGateway;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "poker-ledger-"));
    dbPath = join(tmpDir, "poker.db");
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);
  });

  after(async () => {
    await gateway.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lets a seated Player request a Buy-In and the Host approve it, updating stacks and Cash obligations live", async () => {
    const created = await createTestSession(gateway.url);
    const code = created.session.code;

    assert.deepEqual(created.session.pendingRequests, []);
    assert.deepEqual(created.session.ledgerEntries, []);

    const alice = await claimSeat(gateway.url, code, 2, "Alice");
    const bob = await claimSeat(gateway.url, code, 4, "Bob");

    const hostWs = await connectSubscribedWs(gateway.url, { code, hostToken: created.hostToken });
    const aliceWs = await connectSubscribedWs(gateway.url, { code, seatToken: alice.seatToken });
    const bobWs = await connectSubscribedWs(gateway.url, { code, seatToken: bob.seatToken });

    const reqRes = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seat-token": alice.seatToken,
      },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1000 }),
    });
    assert.equal(reqRes.status, 201);
    const reqJson = (await reqRes.json()) as {
      request: SnapshotMessage["session"]["pendingRequests"][number];
      session: SnapshotMessage["session"];
    };
    assert.equal(reqJson.request.seatNumber, 2);
    assert.equal(reqJson.request.playerId, alice.playerId);
    assert.equal(reqJson.request.kind, "BUY_IN");
    assert.equal(reqJson.request.amountChips, 1000);
    assert.equal(reqJson.request.status, "PENDING");

    // Host and other connected phones receive pending request live before approval
    await waitForCondition(() =>
      hostWs.messages.some((m) => m.session.pendingRequests.length === 1),
    );
    await waitForCondition(() =>
      bobWs.messages.some((m) => m.session.pendingRequests.length === 1),
    );

    const seat2BeforeApproval = reqJson.session.seats.find((s) => s.seatNumber === 2)?.occupant;
    assert.equal(seat2BeforeApproval?.chips, 0);
    assert.equal(seat2BeforeApproval?.totalBuyInChips, 0);

    const approveRes = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${reqJson.request.id}/approve`,
      {
        method: "POST",
        headers: { "x-host-token": created.hostToken },
      },
    );
    assert.equal(approveRes.status, 200);
    const approvedJson = (await approveRes.json()) as {
      request: SnapshotMessage["session"]["pendingRequests"][number];
      ledgerEntry: SnapshotMessage["session"]["ledgerEntries"][number];
      session: SnapshotMessage["session"];
    };
    assert.equal(approvedJson.request.status, "APPROVED");
    assert.equal(approvedJson.ledgerEntry.kind, "BUY_IN");
    assert.equal(approvedJson.ledgerEntry.amountChips, 1000);
    assert.equal(approvedJson.ledgerEntry.source, "REQUEST_APPROVAL");
    assert.equal(approvedJson.ledgerEntry.requestId, reqJson.request.id);
    assert.deepEqual(approvedJson.session.pendingRequests, []);
    assert.equal(approvedJson.session.ledgerEntries.length, 1);

    const seat2After = approvedJson.session.seats.find((s) => s.seatNumber === 2)?.occupant;
    assert.equal(seat2After?.chips, 1000);
    assert.equal(seat2After?.totalBuyInChips, 1000);

    // All connected phones see updated stack, totalBuyInChips, and cleared pendingRequests
    await waitForCondition(() =>
      aliceWs.messages.some(
        (m) =>
          m.session.pendingRequests.length === 0 &&
          m.session.seats.find((s) => s.seatNumber === 2)?.occupant?.totalBuyInChips === 1000 &&
          m.session.seats.find((s) => s.seatNumber === 2)?.occupant?.chips === 1000,
      ),
    );
    await waitForCondition(() =>
      bobWs.messages.some(
        (m) =>
          m.session.ledgerEntries.length === 1 &&
          m.session.seats.find((s) => s.seatNumber === 2)?.occupant?.totalBuyInChips === 1000,
      ),
    );

    hostWs.ws.close();
    aliceWs.ws.close();
    bobWs.ws.close();
  });

  it("lets the Host reject pending requests and directly record Buy-Ins and Top-Ups for any Seat", async () => {
    const created = await createTestSession(gateway.url);
    const code = created.session.code;

    const alice = await claimSeat(gateway.url, code, 1, "Alice");
    const bob = await claimSeat(gateway.url, code, 3, "Bob");
    const aliceWs = await connectSubscribedWs(gateway.url, { code, seatToken: alice.seatToken });

    // Bob requests 1500, Host rejects it
    const reqRes = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seat-token": bob.seatToken,
      },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1500 }),
    });
    assert.equal(reqRes.status, 201);
    const reqJson = (await reqRes.json()) as { request: { id: string } };

    const rejectRes = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${reqJson.request.id}/reject`,
      {
        method: "POST",
        headers: { "x-host-token": created.hostToken },
      },
    );
    assert.equal(rejectRes.status, 200);
    const rejected = (await rejectRes.json()) as {
      request: { status: string };
      session: SnapshotMessage["session"];
    };
    assert.equal(rejected.request.status, "REJECTED");
    assert.deepEqual(rejected.session.pendingRequests, []);
    assert.equal(rejected.session.seats.find((s) => s.seatNumber === 3)?.occupant?.chips, 0);
    assert.equal(
      rejected.session.seats.find((s) => s.seatNumber === 3)?.occupant?.totalBuyInChips,
      0,
    );

    // Host directly records an initial Buy-In and a Top-Up for Bob
    const directBuyInRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/3/ledger`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-host-token": created.hostToken,
      },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 800 }),
    });
    assert.equal(directBuyInRes.status, 201);
    const directBuyIn = (await directBuyInRes.json()) as {
      ledgerEntry: SnapshotMessage["session"]["ledgerEntries"][number];
      session: SnapshotMessage["session"];
    };
    assert.equal(directBuyIn.ledgerEntry.source, "HOST_DIRECT");
    assert.equal(directBuyIn.ledgerEntry.requestId, null);
    assert.equal(directBuyIn.session.seats.find((s) => s.seatNumber === 3)?.occupant?.chips, 800);
    assert.equal(
      directBuyIn.session.seats.find((s) => s.seatNumber === 3)?.occupant?.totalBuyInChips,
      800,
    );

    const directTopUpRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/3/ledger`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-host-token": created.hostToken,
      },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 700 }),
    });
    assert.equal(directTopUpRes.status, 201);
    const directTopUp = (await directTopUpRes.json()) as {
      session: SnapshotMessage["session"];
    };
    assert.equal(directTopUp.session.seats.find((s) => s.seatNumber === 3)?.occupant?.chips, 1500);
    assert.equal(
      directTopUp.session.seats.find((s) => s.seatNumber === 3)?.occupant?.totalBuyInChips,
      1500,
    );
    assert.equal(directTopUp.session.ledgerEntries.length, 2);

    await waitForCondition(() =>
      aliceWs.messages.some(
        (m) =>
          m.session.seats.find((s) => s.seatNumber === 3)?.occupant?.totalBuyInChips === 1500 &&
          m.session.ledgerEntries.length === 2,
      ),
    );

    aliceWs.ws.close();
  });

  it("enforces min/max Buy-In bounds, smallest Chip step, and Buy-In / Rebuy / Top-Up eligibility", async () => {
    const created = await createTestSession(gateway.url, {
      minBuyInChips: 500,
      maxBuyInChips: 2000,
      smallestChipStep: 5,
    });
    const code = created.session.code;

    const alice = await claimSeat(gateway.url, code, 1, "Alice");

    // Step divisibility and bounds on BUY_IN
    const offStep = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 503 }),
    });
    assert.equal(offStep.status, 400);

    const belowMin = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 495 }),
    });
    assert.equal(belowMin.status, 400);

    const aboveMax = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 2005 }),
    });
    assert.equal(aboveMax.status, 400);

    // REBUY and TOP_UP rejected before initial BUY_IN
    const rebuyBeforeBuyIn = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "REBUY", amountChips: 500 }),
    });
    assert.equal(rebuyBeforeBuyIn.status, 409);

    const topUpAtZero = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 500 }),
    });
    assert.equal(topUpAtZero.status, 409);

    // Host directly funds Alice for 1000 Chips
    const initRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": created.hostToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1000 }),
    });
    assert.equal(initRes.status, 201);

    // Second BUY_IN and REBUY with non-zero stack are rejected
    const secondBuyIn = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 500 }),
    });
    assert.equal(secondBuyIn.status, 409);

    const rebuyNonZero = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "REBUY", amountChips: 500 }),
    });
    assert.equal(rebuyNonZero.status, 409);

    // TOP_UP exceeding maxBuyInChips (1000 + 1005 > 2000) is rejected
    const overMaxTopUp = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 1005 }),
    });
    assert.equal(overMaxTopUp.status, 409);

    // TOP_UP smaller than minBuyInChips (200 < 500) is allowed when step-aligned and <= max
    const validTopUp = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 200 }),
    });
    assert.equal(validTopUp.status, 201);
    const validTopUpJson = (await validTopUp.json()) as { request: { id: string } };
    const approveTopUp = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${validTopUpJson.request.id}/approve`,
      { method: "POST", headers: { "x-host-token": created.hostToken } },
    );
    assert.equal(approveTopUp.status, 200);

    // Simulate Alice busting to 0 Chips after a finished Hand (until Hand betting engine lands in #4-#5)
    await gateway.close();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE seats SET chips = 0 WHERE session_code = ? AND seat_number = 1").run(code);
    db.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    // At 0 Chips with totalBuyInChips = 1200: BUY_IN & TOP_UP are blocked, REBUY respects [min, max] & step
    const buyInAfterBust = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 500 }),
    });
    assert.equal(buyInAfterBust.status, 409);

    const rebuyTooSmall = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "REBUY", amountChips: 495 }),
    });
    assert.equal(rebuyTooSmall.status, 400);

    const rebuyOk = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "REBUY", amountChips: 600 }),
    });
    assert.equal(rebuyOk.status, 201);
    const rebuyReq = (await rebuyOk.json()) as { request: { id: string } };

    const approveRebuy = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${rebuyReq.request.id}/approve`,
      { method: "POST", headers: { "x-host-token": created.hostToken } },
    );
    assert.equal(approveRebuy.status, 200);
    const afterRebuy = (await approveRebuy.json()) as { session: SnapshotMessage["session"] };
    const seat1 = afterRebuy.session.seats.find((s) => s.seatNumber === 1)?.occupant;
    assert.equal(seat1?.chips, 600);
    assert.equal(seat1?.totalBuyInChips, 1800);
    assert.equal(afterRebuy.session.ledgerEntries.at(-1)?.kind, "REBUY");

    // Between-Hands rule guard in shared domain validator
    const midHandTopUp = validateFundingOperation(
      { kind: "TOP_UP", amountChips: 100 },
      { config: created.session.config, chips: 600, totalBuyInChips: 1800, handInProgress: true },
    );
    assert.equal(midHandTopUp.ok, false);
    const midHandRebuy = validateFundingOperation(
      { kind: "REBUY", amountChips: 500 },
      { config: created.session.config, chips: 0, totalBuyInChips: 1800, handInProgress: true },
    );
    assert.equal(midHandRebuy.ok, false);

    // Unbounded Session allows arbitrary step-aligned Buy-In and Top-Up
    const openBounds = await createTestSession(gateway.url, {
      minBuyInChips: null,
      maxBuyInChips: null,
      smallBlind: 25,
      bigBlind: 50,
      smallestChipStep: 25,
    });
    const openBob = await claimSeat(gateway.url, openBounds.session.code, 2, "Bob");
    const smallDirect = await fetch(
      `${gateway.url}/api/sessions/${openBounds.session.code}/seats/2/ledger`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-host-token": openBounds.hostToken },
        body: JSON.stringify({ kind: "BUY_IN", amountChips: 25 }),
      },
    );
    assert.equal(smallDirect.status, 201);
    const bigTopUp = await fetch(
      `${gateway.url}/api/sessions/${openBounds.session.code}/buy-in-requests`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-seat-token": openBob.seatToken },
        body: JSON.stringify({ kind: "TOP_UP", amountChips: 10000 }),
      },
    );
    assert.equal(bigTopUp.status, 201);
  });

  it("blocks unauthorized Player ledger edits, prevents double-approval past max, and protects Seat release integrity", async () => {
    const created = await createTestSession(gateway.url, {
      minBuyInChips: 500,
      maxBuyInChips: 2000,
      smallestChipStep: 5,
    });
    const code = created.session.code;

    const alice = await claimSeat(gateway.url, code, 2, "Alice");
    const bob = await claimSeat(gateway.url, code, 4, "Bob");

    // Unseated viewer cannot submit a Buy-In request
    const unseatedReq = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1000 }),
    });
    assert.equal(unseatedReq.status, 403);

    // Player cannot request Chips for another Seat
    const crossSeatReq = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1000, seatNumber: 4 }),
    });
    assert.equal(crossSeatReq.status, 403);

    // Non-Host Player cannot directly record Chips for any Seat
    const unauthDirect = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/ledger`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seat-token": alice.seatToken,
        "x-host-token": "forged-token",
      },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1000 }),
    });
    assert.equal(unauthDirect.status, 403);

    // Alice creates a valid Buy-In request
    const req1Res = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1200 }),
    });
    assert.equal(req1Res.status, 201);
    const req1 = (await req1Res.json()) as { request: { id: string } };

    // Non-Host Player cannot self-approve or reject
    const selfApprove = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${req1.request.id}/approve`,
      { method: "POST", headers: { "x-seat-token": alice.seatToken } },
    );
    assert.equal(selfApprove.status, 403);

    const peerReject = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${req1.request.id}/reject`,
      { method: "POST", headers: { "x-seat-token": bob.seatToken } },
    );
    assert.equal(peerReject.status, 403);

    // Host approves Alice's 1200 Buy-In
    const hostApprove1 = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${req1.request.id}/approve`,
      { method: "POST", headers: { "x-host-token": created.hostToken } },
    );
    assert.equal(hostApprove1.status, 200);

    // Re-approving an already approved request fails
    const repeatApprove = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${req1.request.id}/approve`,
      { method: "POST", headers: { "x-host-token": created.hostToken } },
    );
    assert.equal(repeatApprove.status, 409);

    // Alice submits two concurrent Top-Up requests of 500 Chips (1200 + 500 <= 2000, but 1200 + 1000 > 2000)
    const topUpA = (await (
      await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
        body: JSON.stringify({ kind: "TOP_UP", amountChips: 500 }),
      })
    ).json()) as { request: { id: string } };
    const topUpB = (await (
      await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
        body: JSON.stringify({ kind: "TOP_UP", amountChips: 500 }),
      })
    ).json()) as { request: { id: string } };

    const approveA = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${topUpA.request.id}/approve`,
      { method: "POST", headers: { "x-host-token": created.hostToken } },
    );
    assert.equal(approveA.status, 200);

    // Second approval re-checks stack atomically and refuses going past 2000 max
    const approveB = await fetch(
      `${gateway.url}/api/sessions/${code}/buy-in-requests/${topUpB.request.id}/approve`,
      { method: "POST", headers: { "x-host-token": created.hostToken } },
    );
    assert.equal(approveB.status, 409);

    // Releasing Seat 2 (which holds 1700 Chips and 1700 totalBuyInChips) is blocked to preserve ledger integrity
    const releaseFunded = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/release`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(releaseFunded.status, 409);

    // Releasing Seat 4 (0 Chips, 0 totalBuyInChips) succeeds and clears any pending request for Seat 4
    const bobReqRes = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": bob.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1000 }),
    });
    assert.equal(bobReqRes.status, 201);
    const bobReq = (await bobReqRes.json()) as { request: { id: string } };

    const releaseZero = await fetch(`${gateway.url}/api/sessions/${code}/seats/4/release`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(releaseZero.status, 200);
    const releasedJson = (await releaseZero.json()) as { session: SnapshotMessage["session"] };
    assert.equal(
      releasedJson.session.pendingRequests.some((r) => r.id === bobReq.request.id),
      false,
    );
  });

  it("persists ledger entries, pending requests, stacks, and Re-linked Seats across server restart and formats Cash obligations", async () => {
    const created = await createTestSession(gateway.url, {
      currencySymbol: "€",
      exchangeRateChips: 100,
      exchangeRateCashMinor: 250,
      minBuyInChips: 500,
      maxBuyInChips: 3000,
      smallestChipStep: 5,
    });
    const code = created.session.code;

    assert.equal(chipsToCashMinor(1250, created.session.config), 3125);
    assert.equal(formatChipsAsCash(1250, created.session.config), "€31.25");

    const alice = await claimSeat(gateway.url, code, 2, "Alice");
    const bob = await claimSeat(gateway.url, code, 5, "Bob");

    const directRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": created.hostToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 1250 }),
    });
    assert.equal(directRes.status, 201);

    const pendingBobRes = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": bob.seatToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 750 }),
    });
    assert.equal(pendingBobRes.status, 201);
    const pendingBob = (await pendingBobRes.json()) as { request: { id: string } };

    // Re-link Alice to a new device token and verify her stack + totalBuyInChips survive
    const relinkRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/relink`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(relinkRes.status, 200);
    const relink = (await relinkRes.json()) as { relinkCode: string };

    const redeemRes = await fetch(`${gateway.url}/api/sessions/${code}/relink/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relinkCode: relink.relinkCode }),
    });
    assert.equal(redeemRes.status, 200);
    const redeemedAlice = (await redeemRes.json()) as { seatToken: string };

    // Restart Gateway on the same SQLite DB
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    const restoredRes = await fetch(`${gateway.url}/api/sessions/${code}`, {
      headers: { "x-seat-token": redeemedAlice.seatToken },
    });
    assert.equal(restoredRes.status, 200);
    const restored = (await restoredRes.json()) as {
      viewer: { seatNumber: number | null; playerId: string | null };
      session: SnapshotMessage["session"];
    };
    assert.equal(restored.viewer.seatNumber, 2);
    assert.equal(restored.viewer.playerId, alice.playerId);

    const aliceSeat = restored.session.seats.find((s) => s.seatNumber === 2)?.occupant;
    assert.equal(aliceSeat?.chips, 1250);
    assert.equal(aliceSeat?.totalBuyInChips, 1250);
    assert.equal(restored.session.pendingRequests.length, 1);
    assert.equal(restored.session.pendingRequests[0]?.id, pendingBob.request.id);
    assert.equal(restored.session.ledgerEntries.length, 1);
    assert.equal(restored.session.ledgerEntries[0]?.amountChips, 1250);

    // Alice can still request a Top-Up on her new Seat token after server restart
    const aliceTopUpRes = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": redeemedAlice.seatToken },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 250 }),
    });
    assert.equal(aliceTopUpRes.status, 201);
  });
});
