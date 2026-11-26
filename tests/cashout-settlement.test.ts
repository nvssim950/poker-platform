import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";
import type { HandState } from "../src/shared/handEngine.ts";
import type { SessionSnapshot } from "../src/shared/session.ts";
import { computeSettlement, formatSettlementTransfer } from "../src/shared/settlement.ts";

interface SnapshotMessage {
  type: string;
  error?: string;
  viewer: { isHost: boolean; seatNumber: number | null; playerId: string | null };
  session: SessionSnapshot;
}

async function createFundedSession(
  gatewayUrl: string,
  configOverrides: Record<string, unknown> = {},
  players: Array<{ seatNumber: number; displayName: string; chips: number }> = [],
): Promise<{
  code: string;
  hostToken: string;
  seats: Record<number, { seatToken: string; playerId: string; seatNumber: number }>;
  session: SessionSnapshot;
}> {
  const createRes = await fetch(`${gatewayUrl}/api/sessions`, {
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
      minBuyInChips: 100,
      maxBuyInChips: 5000,
      ...configOverrides,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as {
    hostToken: string;
    session: SessionSnapshot;
  };
  const code = created.session.code;

  const seats: Record<number, { seatToken: string; playerId: string; seatNumber: number }> = {};
  let latestSession = created.session;

  for (const p of players) {
    const claimRes = await fetch(`${gatewayUrl}/api/sessions/${code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: p.seatNumber, displayName: p.displayName }),
    });
    assert.equal(claimRes.status, 200);
    const claimed = (await claimRes.json()) as {
      seatToken: string;
      playerId: string;
      seatNumber: number;
      session: SessionSnapshot;
    };
    seats[p.seatNumber] = {
      seatToken: claimed.seatToken,
      playerId: claimed.playerId,
      seatNumber: claimed.seatNumber,
    };
    latestSession = claimed.session;

    if (p.chips > 0) {
      const fundRes = await fetch(
        `${gatewayUrl}/api/sessions/${code}/seats/${p.seatNumber}/ledger`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-host-token": created.hostToken,
          },
          body: JSON.stringify({ kind: "BUY_IN", amountChips: p.chips }),
        },
      );
      assert.equal(fundRes.status, 201);
      const funded = (await fundRes.json()) as { session: SessionSnapshot };
      latestSession = funded.session;
    }
  }

  return { code, hostToken: created.hostToken, seats, session: latestSession };
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

async function startHand(
  gatewayUrl: string,
  code: string,
  hostToken: string,
): Promise<{ hand: HandState; session: SessionSnapshot }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/start`, {
    method: "POST",
    headers: { "x-host-token": hostToken },
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { hand: HandState; session: SessionSnapshot };
}

async function submitAction(
  gatewayUrl: string,
  code: string,
  tokenHeaders: Record<string, string>,
  payload: { seatNumber?: number; action: string; amountChips?: number },
): Promise<{ hand: HandState; session: SessionSnapshot }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...tokenHeaders,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { hand: HandState; session: SessionSnapshot };
}

describe("Sitting Out, Early Cash-Out, Re-Entry & Cash Settlement", () => {
  let tmpDir: string;
  let dbPath: string;
  let gateway: SessionGateway;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "poker-settlement-"));
    dbPath = join(tmpDir, "sessions.sqlite");
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0, "127.0.0.1");
  });

  after(async () => {
    await gateway.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes deterministic zero-sum cent rounding and minimum transfers on awkward exchange rates", () => {
    // 300 Chips = $1.00 (100 minor units): +66.666..., -33.333..., -33.333... -> raw sum = +1 cent
    const summaryPosResidual = computeSettlement({
      exchangeRateChips: 300,
      exchangeRateCashMinor: 100,
      participants: [
        {
          participantId: "p-c",
          displayName: "Carol",
          seatNumber: 3,
          totalBuyInChips: 300,
          endingChips: 200,
          status: "SETTLED",
        },
        {
          participantId: "p-a",
          displayName: "Alice",
          seatNumber: 1,
          totalBuyInChips: 300,
          endingChips: 500,
          status: "SETTLED",
        },
        {
          participantId: "p-b",
          displayName: "Bob",
          seatNumber: 2,
          totalBuyInChips: 300,
          endingChips: 200,
          status: "SETTLED",
        },
      ],
    });

    assert.equal(summaryPosResidual.totalBuyInChips, 900);
    assert.equal(summaryPosResidual.totalEndingChips, 900);
    assert.equal(summaryPosResidual.chipDiscrepancy, 0);
    assert.equal(summaryPosResidual.totalNetCashMinor, 0);
    assert.equal(summaryPosResidual.isBalanced, true);

    const byId = new Map(summaryPosResidual.participants.map((p) => [p.participantId, p]));
    // All three rounded up by +1/3 cent; deterministic tie-break by participantId ('p-a' first) absorbs -1
    assert.equal(byId.get("p-a")?.netCashMinor, 66);
    assert.equal(byId.get("p-b")?.netCashMinor, -33);
    assert.equal(byId.get("p-c")?.netCashMinor, -33);
    assert.ok(summaryPosResidual.transfers.length <= 2);
    assert.deepEqual(summaryPosResidual.transfers, [
      {
        fromParticipantId: "p-b",
        fromDisplayName: "Bob",
        toParticipantId: "p-a",
        toDisplayName: "Alice",
        amountCashMinor: 33,
      },
      {
        fromParticipantId: "p-c",
        fromDisplayName: "Carol",
        toParticipantId: "p-a",
        toDisplayName: "Alice",
        amountCashMinor: 33,
      },
    ]);
    assert.equal(
      formatSettlementTransfer(summaryPosResidual.transfers[0]!, "$"),
      "Bob pays Alice $0.33",
    );

    // Reverse scenario: +33.33, +33.33, -66.67 -> raw sum = -1 cent; deterministic tie-break adds +1 cent
    const summaryNegResidual = computeSettlement({
      exchangeRateChips: 300,
      exchangeRateCashMinor: 100,
      participants: [
        {
          participantId: "p-2",
          displayName: "Bob",
          seatNumber: 2,
          totalBuyInChips: 300,
          endingChips: 400,
          status: "SETTLED",
        },
        {
          participantId: "p-1",
          displayName: "Alice",
          seatNumber: 1,
          totalBuyInChips: 300,
          endingChips: 400,
          status: "CASHED_OUT",
        },
        {
          participantId: "p-3",
          displayName: "Carol",
          seatNumber: 3,
          totalBuyInChips: 300,
          endingChips: 100,
          status: "SETTLED",
        },
      ],
    });
    const byIdNeg = new Map(summaryNegResidual.participants.map((p) => [p.participantId, p]));
    assert.equal(summaryNegResidual.totalNetCashMinor, 0);
    assert.equal(byIdNeg.get("p-1")?.netCashMinor, 34);
    assert.equal(byIdNeg.get("p-2")?.netCashMinor, 33);
    assert.equal(byIdNeg.get("p-3")?.netCashMinor, -67);
    assert.ok(summaryNegResidual.transfers.length <= 2);

    // 700 Chips = $1.00 with mixed rounding signs: directional largest error wins
    const sevenRate = computeSettlement({
      exchangeRateChips: 700,
      exchangeRateCashMinor: 100,
      participants: [
        {
          participantId: "a",
          displayName: "A",
          seatNumber: 1,
          totalBuyInChips: 1000,
          endingChips: 1250, // +250 -> +35.7143 -> 36 (rounded UP by 0.2857)
          status: "SETTLED",
        },
        {
          participantId: "b",
          displayName: "B",
          seatNumber: 2,
          totalBuyInChips: 1000,
          endingChips: 1150, // +150 -> +21.4286 -> 21 (rounded DOWN by 0.4286)
          status: "SETTLED",
        },
        {
          participantId: "c",
          displayName: "C",
          seatNumber: 3,
          totalBuyInChips: 1000,
          endingChips: 1150, // +150 -> +21.4286 -> 21 (rounded DOWN by 0.4286)
          status: "SETTLED",
        },
        {
          participantId: "d",
          displayName: "D",
          seatNumber: 4,
          totalBuyInChips: 1000,
          endingChips: 450, // -550 -> -78.5714 -> -79 (rounded DOWN by 0.4286)
          status: "SETTLED",
        },
      ],
    });
    assert.equal(sevenRate.totalNetCashMinor, 0);
    // 'b' is first alphabetically among the three rounded-down participants (+0.4286) -> 22
    const sevenById = new Map(sevenRate.participants.map((p) => [p.participantId, p]));
    assert.equal(sevenById.get("a")?.netCashMinor, 36);
    assert.equal(sevenById.get("b")?.netCashMinor, 22);
    assert.equal(sevenById.get("c")?.netCashMinor, 21);
    assert.equal(sevenById.get("d")?.netCashMinor, -79);
    assert.ok(sevenRate.transfers.length <= 3);

    // Zero-transfer case when everyone breaks even
    const even = computeSettlement({
      exchangeRateChips: 100,
      exchangeRateCashMinor: 100,
      participants: [
        {
          participantId: "x",
          displayName: "X",
          seatNumber: 1,
          totalBuyInChips: 500,
          endingChips: 500,
          status: "SETTLED",
        },
        {
          participantId: "y",
          displayName: "Y",
          seatNumber: 2,
          totalBuyInChips: 500,
          endingChips: 500,
          status: "SETTLED",
        },
      ],
    });
    assert.deepEqual(even.transfers, []);
    assert.equal(even.totalNetCashMinor, 0);
  });

  it("lets Players or Host toggle Sit Out between Hands and skips sitting-out Seats for blinds and Moving Button", async () => {
    const { code, hostToken, seats } = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 1000 },
        { seatNumber: 2, displayName: "Bob", chips: 1000 },
        { seatNumber: 3, displayName: "Carol", chips: 1000 },
      ],
    );

    const hostWs = await connectSubscribedWs(gateway.url, { code, hostToken });

    try {
      // Hand 1: Button=1, SB=2, BB=3
      const h1 = await startHand(gateway.url, code, hostToken);
      assert.equal(h1.hand.buttonSeatNumber, 1);
      assert.equal(h1.hand.sbSeatNumber, 2);
      assert.equal(h1.hand.bbSeatNumber, 3);

      // Cannot toggle Sit Out during active Hand
      const midHandSitOutRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/sit-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-seat-token": seats[2]!.seatToken,
        },
        body: JSON.stringify({ isSittingOut: true }),
      });
      assert.equal(midHandSitOutRes.status, 409);

      // Finish Hand 1 quickly (Seat 1 folds, Seat 2 folds -> Seat 3 wins)
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[1]!.seatToken },
        { action: "FOLD" },
      );
      const h1Done = await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[2]!.seatToken },
        { action: "FOLD" },
      );
      assert.equal(h1Done.hand.status, "COMPLETE");

      const bobStackBeforeSitOut = h1Done.session.seats.find((s) => s.seatNumber === 2)?.occupant
        ?.chips;
      assert.equal(bobStackBeforeSitOut, 990);

      // Unauthorized Player cannot toggle another Seat's Sit Out
      const forbiddenRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/sit-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-seat-token": seats[1]!.seatToken,
        },
        body: JSON.stringify({ isSittingOut: true }),
      });
      assert.equal(forbiddenRes.status, 403);

      // Invalid payload rejected
      const badBodyRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/sit-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-seat-token": seats[2]!.seatToken,
        },
        body: JSON.stringify({ isSittingOut: "yes" }),
      });
      assert.equal(badBodyRes.status, 400);

      // Seat 2 Player toggles Sit Out between Hands
      const sitOutRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/sit-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-seat-token": seats[2]!.seatToken,
        },
        body: JSON.stringify({ isSittingOut: true }),
      });
      assert.equal(sitOutRes.status, 200);
      const sitOutData = (await sitOutRes.json()) as { session: SessionSnapshot };
      assert.equal(
        sitOutData.session.seats.find((s) => s.seatNumber === 2)?.occupant?.isSittingOut,
        true,
      );

      await waitForCondition(() =>
        hostWs.messages.some(
          (m) => m.session.seats.find((s) => s.seatNumber === 2)?.occupant?.isSittingOut === true,
        ),
      );

      // Also verify sitting out Seat 1 too leaves < 2 active seats and blocks startHand
      const sitOut1Res = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/sit-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-host-token": hostToken,
        },
        body: JSON.stringify({ isSittingOut: true }),
      });
      assert.equal(sitOut1Res.status, 200);
      const blockedStartRes = await fetch(`${gateway.url}/api/sessions/${code}/hand/start`, {
        method: "POST",
        headers: { "x-host-token": hostToken },
      });
      assert.equal(blockedStartRes.status, 409);

      // Return Seat 1 to active play; keep Seat 2 sitting out
      const sitIn1Res = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/sit-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-host-token": hostToken,
        },
        body: JSON.stringify({ isSittingOut: false }),
      });
      assert.equal(sitIn1Res.status, 200);

      // Hand 2: Moving Button skips Seat 2 (sitting out) and goes 1 -> 3!
      // Only Seats 1 and 3 are active -> Heads-Up (Button=SB=3, BB=1)
      const h2 = await startHand(gateway.url, code, hostToken);
      assert.equal(h2.hand.buttonSeatNumber, 3);
      assert.equal(h2.hand.sbSeatNumber, 3);
      assert.equal(h2.hand.bbSeatNumber, 1);
      assert.equal(h2.hand.isHeadsUp, true);
      assert.deepEqual(
        h2.hand.seats.map((s) => s.seatNumber),
        [1, 3],
      );
      assert.equal(
        h2.session.seats.find((s) => s.seatNumber === 2)?.occupant?.chips,
        bobStackBeforeSitOut,
      );

      // Finish Hand 2 (Seat 3 folds)
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[3]!.seatToken },
        { action: "FOLD" },
      );

      // Host returns Seat 2 back into play
      const returnRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/sit-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-host-token": hostToken,
        },
        body: JSON.stringify({ isSittingOut: false }),
      });
      assert.equal(returnRes.status, 200);
      assert.equal(
        ((await returnRes.json()) as { session: SessionSnapshot }).session.seats.find(
          (s) => s.seatNumber === 2,
        )?.occupant?.isSittingOut,
        false,
      );

      // Hand 3: Moving Button moves clockwise from 3 -> 1, Seat 2 posts SB
      const h3 = await startHand(gateway.url, code, hostToken);
      assert.equal(h3.hand.buttonSeatNumber, 1);
      assert.equal(h3.hand.sbSeatNumber, 2);
      assert.equal(h3.hand.bbSeatNumber, 3);
      assert.deepEqual(
        h3.hand.seats.map((s) => s.seatNumber),
        [1, 2, 3],
      );
    } finally {
      hostWs.ws.close();
    }
  });

  it("handles early Cash-Out requests, Host approvals/rejections, busted Cash-Out, and Re-Entry with ledger conservation", async () => {
    const { code, hostToken, seats } = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, minBuyInChips: 200, maxBuyInChips: 2000 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
      ],
    );

    const bobWs = await connectSubscribedWs(gateway.url, {
      code,
      seatToken: seats[2]!.seatToken,
    });

    try {
      // Hand 1: Alice pushes All-In (500), Bob folds (loses 10 SB -> 490), Carol calls All-In (500)
      await startHand(gateway.url, code, hostToken);

      // Mid-hand Cash-Out request rejected
      const midHandCashOutReq = await fetch(`${gateway.url}/api/sessions/${code}/cash-out-requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-seat-token": seats[2]!.seatToken,
        },
        body: JSON.stringify({}),
      });
      assert.equal(midHandCashOutReq.status, 409);

      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[1]!.seatToken },
        { action: "ALL_IN" },
      );
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[2]!.seatToken },
        { action: "FOLD" },
      );
      const showdownState = await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[3]!.seatToken },
        { action: "CALL" },
      );
      assert.equal(showdownState.hand.status, "SHOWDOWN");

      // Alice wins Showdown -> Carol busts to 0 Chips!
      const resolvedShowdownRes = await fetch(
        `${gateway.url}/api/sessions/${code}/hand/showdown`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-host-token": hostToken,
          },
          body: JSON.stringify({ winnerSeatNumbers: [1] }),
        },
      );
      assert.equal(resolvedShowdownRes.status, 200);
      const afterHand1 = (await resolvedShowdownRes.json()) as { session: SessionSnapshot };
      assert.equal(afterHand1.session.seats.find((s) => s.seatNumber === 1)?.occupant?.chips, 1010);
      assert.equal(afterHand1.session.seats.find((s) => s.seatNumber === 2)?.occupant?.chips, 490);
      assert.equal(afterHand1.session.seats.find((s) => s.seatNumber === 3)?.occupant?.chips, 0);

      // Non-seated caller cannot request Cash-Out
      const noAuthCashOut = await fetch(`${gateway.url}/api/sessions/${code}/cash-out-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(noAuthCashOut.status, 403);

      // Bob cannot request Cash-Out for Seat 1
      const wrongSeatCashOut = await fetch(
        `${gateway.url}/api/sessions/${code}/cash-out-requests`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-seat-token": seats[2]!.seatToken,
          },
          body: JSON.stringify({ seatNumber: 1 }),
        },
      );
      assert.equal(wrongSeatCashOut.status, 403);

      // Bob also has a pending Top-Up request on Seat 2 (should be rejected on Cash-Out)
      const topUpReqRes = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-seat-token": seats[2]!.seatToken,
        },
        body: JSON.stringify({ kind: "TOP_UP", amountChips: 100 }),
      });
      assert.equal(topUpReqRes.status, 201);

      // Bob requests Cash-Out for Seat 2
      const cashOutReq1Res = await fetch(`${gateway.url}/api/sessions/${code}/cash-out-requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-seat-token": seats[2]!.seatToken,
        },
        body: JSON.stringify({}),
      });
      assert.equal(cashOutReq1Res.status, 201);
      const cashOutReq1 = (await cashOutReq1Res.json()) as {
        request: { id: string; seatNumber: number; chips: number; status: string };
        session: SessionSnapshot;
      };
      assert.equal(cashOutReq1.request.seatNumber, 2);
      assert.equal(cashOutReq1.request.chips, 490);
      assert.equal(cashOutReq1.request.status, "PENDING");
      assert.equal(cashOutReq1.session.pendingCashOutRequests.length, 1);

      // Duplicate pending Cash-Out request rejected
      const dupCashOutReqRes = await fetch(
        `${gateway.url}/api/sessions/${code}/cash-out-requests`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-seat-token": seats[2]!.seatToken,
          },
          body: JSON.stringify({}),
        },
      );
      assert.equal(dupCashOutReqRes.status, 409);

      // Host rejects the first Cash-Out request
      const rejectRes = await fetch(
        `${gateway.url}/api/sessions/${code}/cash-out-requests/${cashOutReq1.request.id}/reject`,
        {
          method: "POST",
          headers: { "x-host-token": hostToken },
        },
      );
      assert.equal(rejectRes.status, 200);
      const rejected = (await rejectRes.json()) as { session: SessionSnapshot };
      assert.equal(rejected.session.pendingCashOutRequests.length, 0);
      assert.equal(rejected.session.seats.find((s) => s.seatNumber === 2)?.occupant?.chips, 490);

      // Bob requests Cash-Out again, and Host approves
      const cashOutReq2Res = await fetch(`${gateway.url}/api/sessions/${code}/cash-out-requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-seat-token": seats[2]!.seatToken,
        },
        body: JSON.stringify({}),
      });
      assert.equal(cashOutReq2Res.status, 201);
      const cashOutReq2 = (await cashOutReq2Res.json()) as { request: { id: string } };

      const approveRes = await fetch(
        `${gateway.url}/api/sessions/${code}/cash-out-requests/${cashOutReq2.request.id}/approve`,
        {
          method: "POST",
          headers: { "x-host-token": hostToken },
        },
      );
      assert.equal(approveRes.status, 200);
      const approved = (await approveRes.json()) as {
        cashOut: {
          playerId: string;
          displayName: string;
          seatNumber: number;
          totalBuyInChips: number;
          endingChips: number;
          source: string;
        };
        session: SessionSnapshot;
      };
      assert.equal(approved.cashOut.playerId, seats[2]!.playerId);
      assert.equal(approved.cashOut.displayName, "Bob");
      assert.equal(approved.cashOut.seatNumber, 2);
      assert.equal(approved.cashOut.totalBuyInChips, 500);
      assert.equal(approved.cashOut.endingChips, 490);
      assert.equal(approved.cashOut.source, "REQUEST_APPROVAL");

      // Seat 2 is vacated and Bob's pending Top-Up request was rejected
      assert.equal(approved.session.seats.find((s) => s.seatNumber === 2)?.occupant, null);
      assert.equal(approved.session.pendingRequests.length, 0);
      assert.equal(approved.session.pendingCashOutRequests.length, 0);
      assert.equal(approved.session.cashOuts.length, 1);

      // Double approval returns 409
      const doubleApprove = await fetch(
        `${gateway.url}/api/sessions/${code}/cash-out-requests/${cashOutReq2.request.id}/approve`,
        {
          method: "POST",
          headers: { "x-host-token": hostToken },
        },
      );
      assert.equal(doubleApprove.status, 409);

      // Bob's old seat token is revoked via HTTP & live WS viewer update
      const bobGetAfter = await fetch(`${gateway.url}/api/sessions/${code}`, {
        headers: { "x-seat-token": seats[2]!.seatToken },
      });
      assert.equal(bobGetAfter.status, 200);
      const bobViewerAfter = (await bobGetAfter.json()) as {
        viewer: { seatNumber: number | null; playerId: string | null };
      };
      assert.equal(bobViewerAfter.viewer.seatNumber, null);
      assert.equal(bobViewerAfter.viewer.playerId, null);

      await waitForCondition(() =>
        bobWs.messages.some(
          (m) => m.session.cashOuts.length === 1 && m.viewer.seatNumber === null,
        ),
      );

      // Busted Player Carol (chips === 0, totalBuyInChips === 500) MUST be allowed to Cash-Out!
      const bustedCashOutRes = await fetch(
        `${gateway.url}/api/sessions/${code}/seats/3/cash-out`,
        {
          method: "POST",
          headers: { "x-host-token": hostToken },
        },
      );
      assert.equal(bustedCashOutRes.status, 200);
      const bustedCashOut = (await bustedCashOutRes.json()) as {
        cashOut: { totalBuyInChips: number; endingChips: number; source: string };
        session: SessionSnapshot;
      };
      assert.equal(bustedCashOut.cashOut.totalBuyInChips, 500);
      assert.equal(bustedCashOut.cashOut.endingChips, 0);
      assert.equal(bustedCashOut.cashOut.source, "HOST_DIRECT");
      assert.equal(bustedCashOut.session.seats.find((s) => s.seatNumber === 3)?.occupant, null);

      // Re-Entry: Bob claims Seat 4 and buys in again via normal BUY_IN rules (below minBuyIn fails)
      const reentryClaimRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatNumber: 4, displayName: "Bob" }),
      });
      assert.equal(reentryClaimRes.status, 200);
      const reentryClaim = (await reentryClaimRes.json()) as {
        seatToken: string;
        playerId: string;
      };
      assert.notEqual(reentryClaim.playerId, seats[2]!.playerId);

      // Rebuy is rejected for fresh seat; must use BUY_IN within bounds
      const badRebuyRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/4/ledger`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-host-token": hostToken,
        },
        body: JSON.stringify({ kind: "REBUY", amountChips: 300 }),
      });
      assert.equal(badRebuyRes.status, 409);

      const belowMinBuyInRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/4/ledger`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-host-token": hostToken,
        },
        body: JSON.stringify({ kind: "BUY_IN", amountChips: 100 }),
      });
      assert.equal(belowMinBuyInRes.status, 400);

      const validReentryBuyInRes = await fetch(
        `${gateway.url}/api/sessions/${code}/seats/4/ledger`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-host-token": hostToken,
          },
          body: JSON.stringify({ kind: "BUY_IN", amountChips: 400 }),
        },
      );
      assert.equal(validReentryBuyInRes.status, 201);

      // Verify 0/0 unoccupied-ledger seat direct cash-out also works cleanly
      const zeroSeatClaim = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatNumber: 5, displayName: "Temp" }),
      });
      assert.equal(zeroSeatClaim.status, 200);
      const zeroCashOutRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/5/cash-out`, {
        method: "POST",
        headers: { "x-host-token": hostToken },
      });
      assert.equal(zeroCashOutRes.status, 200);

      // Verify chip conservation across table + cashOuts vs total ledger buy-ins
      const snapRes = await fetch(`${gateway.url}/api/sessions/${code}`);
      const snapJson = (await snapRes.json()) as { session: SessionSnapshot };
      const totalBuyIns = snapJson.session.ledgerEntries.reduce((s, e) => s + e.amountChips, 0);
      const tableChips = snapJson.session.seats.reduce(
        (s, seat) => s + (seat.occupant?.chips ?? 0),
        0,
      );
      const cashedOutChips = snapJson.session.cashOuts.reduce((s, c) => s + c.endingChips, 0);
      assert.equal(totalBuyIns, 1900);
      assert.equal(tableChips + cashedOutChips, totalBuyIns);
    } finally {
      bobWs.ws.close();
    }
  });

  it("settles Session between Hands with awkward rate cent balancing, locks mutations, and persists across restart", async () => {
    // 300 Chips = $1.00 (100 minor units)
    const { code, hostToken, seats } = await createFundedSession(
      gateway.url,
      {
        seatCount: 6,
        smallBlind: 10,
        bigBlind: 20,
        smallestChipStep: 5,
        exchangeRateChips: 300,
        exchangeRateCashMinor: 100,
        minBuyInChips: 100,
        maxBuyInChips: 1000,
      },
      [
        { seatNumber: 1, displayName: "Alice", chips: 300 },
        { seatNumber: 2, displayName: "Bob", chips: 300 },
        { seatNumber: 3, displayName: "Carol", chips: 300 },
        { seatNumber: 4, displayName: "Observer", chips: 0 }, // 0/0 seat should not enter settlement
      ],
    );

    const hostWs = await connectSubscribedWs(gateway.url, { code, hostToken });

    try {
      // Hand 1: Button=1, SB=2 (10), BB=3 (20).
      // Alice raises to 100, Bob calls 100 (added 90), Carol calls 100 (added 80) -> pot 300!
      // On Flop: Alice bets 100, Bob folds, Carol folds -> Alice wins 300 pot!
      // Actually let's check exact chip counts:
      // Alice starts 300, puts 100 preflop + 100 flop, wins 300 pot (+ 100 uncalled returned) -> 500!
      // Bob starts 300, puts 100 preflop, folds flop -> 200!
      // Carol starts 300, puts 100 preflop, folds flop -> 200!
      await startHand(gateway.url, code, hostToken);

      // Non-Host cannot settle
      const nonHostSettle = await fetch(`${gateway.url}/api/sessions/${code}/settle`, {
        method: "POST",
        headers: { "x-seat-token": seats[1]!.seatToken },
      });
      assert.equal(nonHostSettle.status, 403);

      // Host cannot settle during active Hand
      const midHandSettle = await fetch(`${gateway.url}/api/sessions/${code}/settle`, {
        method: "POST",
        headers: { "x-host-token": hostToken },
      });
      assert.equal(midHandSettle.status, 409);

      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[1]!.seatToken },
        { action: "RAISE", amountChips: 100 },
      );
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[2]!.seatToken },
        { action: "CALL" },
      );
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[3]!.seatToken },
        { action: "CALL" },
      );

      // Flop: SB (Seat 2) acts first -> Check; Seat 3 -> Check; Seat 1 -> Bet 100; Seat 2 -> Fold; Seat 3 -> Fold
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[2]!.seatToken },
        { action: "CHECK" },
      );
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[3]!.seatToken },
        { action: "CHECK" },
      );
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[1]!.seatToken },
        { action: "BET", amountChips: 100 },
      );
      await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[2]!.seatToken },
        { action: "FOLD" },
      );
      const finished = await submitAction(
        gateway.url,
        code,
        { "x-seat-token": seats[3]!.seatToken },
        { action: "FOLD" },
      );
      assert.equal(finished.hand.status, "COMPLETE");
      assert.equal(finished.session.seats.find((s) => s.seatNumber === 1)?.occupant?.chips, 500);
      assert.equal(finished.session.seats.find((s) => s.seatNumber === 2)?.occupant?.chips, 200);
      assert.equal(finished.session.seats.find((s) => s.seatNumber === 3)?.occupant?.chips, 200);

      // Also test Seat 4 (0/0) sitting out doesn't break settlement; Seat 4 is excluded from SettlementSummary
      const settleRes = await fetch(`${gateway.url}/api/sessions/${code}/settle`, {
        method: "POST",
        headers: { "x-host-token": hostToken },
      });
      assert.equal(settleRes.status, 200);
      const settled = (await settleRes.json()) as {
        settlement: NonNullable<SessionSnapshot["settlement"]>;
        session: SessionSnapshot;
      };
      assert.equal(settled.session.status, "SETTLED");
      assert.ok(settled.session.settlement);
      assert.equal(settled.settlement.participants.length, 3);
      assert.equal(settled.settlement.totalBuyInChips, 900);
      assert.equal(settled.settlement.totalEndingChips, 900);
      assert.equal(settled.settlement.chipDiscrepancy, 0);
      assert.equal(settled.settlement.totalNetCashMinor, 0);
      assert.equal(settled.settlement.isBalanced, true);

      const sumCash = settled.settlement.participants.reduce((s, p) => s + p.netCashMinor, 0);
      assert.equal(sumCash, 0);
      assert.ok(settled.settlement.transfers.length <= 2);

      // Verify transfer totals match netCashMinor exactly
      const netByParticipant = new Map<string, number>();
      for (const p of settled.settlement.participants) {
        netByParticipant.set(p.participantId, 0);
      }
      for (const t of settled.settlement.transfers) {
        assert.ok(t.amountCashMinor > 0);
        netByParticipant.set(
          t.fromParticipantId,
          (netByParticipant.get(t.fromParticipantId) ?? 0) - t.amountCashMinor,
        );
        netByParticipant.set(
          t.toParticipantId,
          (netByParticipant.get(t.toParticipantId) ?? 0) + t.amountCashMinor,
        );
      }
      for (const p of settled.settlement.participants) {
        assert.equal(netByParticipant.get(p.participantId), p.netCashMinor);
      }

      // Live WS broadcast of SETTLED status
      await waitForCondition(() =>
        hostWs.messages.some(
          (m) => m.session.status === "SETTLED" && m.session.settlement !== null,
        ),
      );

      // All mutations rejected with 409 once SETTLED
      const blockedEndpoints: Array<{ path: string; body?: unknown; headers?: Record<string, string> }> = [
        { path: `/api/sessions/${code}/hand/start`, headers: { "x-host-token": hostToken } },
        {
          path: `/api/sessions/${code}/seats/claim`,
          body: { seatNumber: 5, displayName: "Late" },
        },
        {
          path: `/api/sessions/${code}/buy-in-requests`,
          headers: { "x-seat-token": seats[1]!.seatToken },
          body: { kind: "TOP_UP", amountChips: 100 },
        },
        {
          path: `/api/sessions/${code}/seats/1/ledger`,
          headers: { "x-host-token": hostToken },
          body: { kind: "TOP_UP", amountChips: 100 },
        },
        {
          path: `/api/sessions/${code}/seats/1/sit-out`,
          headers: { "x-seat-token": seats[1]!.seatToken },
          body: { isSittingOut: true },
        },
        {
          path: `/api/sessions/${code}/cash-out-requests`,
          headers: { "x-seat-token": seats[1]!.seatToken },
          body: {},
        },
        {
          path: `/api/sessions/${code}/seats/1/cash-out`,
          headers: { "x-host-token": hostToken },
        },
        {
          path: `/api/sessions/${code}/seats/4/release`,
          headers: { "x-host-token": hostToken },
        },
        {
          path: `/api/sessions/${code}/settle`,
          headers: { "x-host-token": hostToken },
        },
      ];

      for (const ep of blockedEndpoints) {
        const res = await fetch(`${gateway.url}${ep.path}`, {
          method: "POST",
          headers: {
            ...(ep.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(ep.headers ?? {}),
          },
          ...(ep.body !== undefined ? { body: JSON.stringify(ep.body) } : {}),
        });
        assert.equal(res.status, 409, `Expected 409 on ${ep.path}, got ${res.status}`);
      }
    } finally {
      hostWs.ws.close();
    }

    // Restart gateway against same SQLite DB and verify SETTLED state & Settlement persist
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0, "127.0.0.1");

    const reloadRes = await fetch(`${gateway.url}/api/sessions/${code}`, {
      headers: { "x-host-token": hostToken },
    });
    assert.equal(reloadRes.status, 200);
    const reloaded = (await reloadRes.json()) as { session: SessionSnapshot };
    assert.equal(reloaded.session.status, "SETTLED");
    assert.ok(reloaded.session.settlement);
    assert.equal(reloaded.session.settlement.isBalanced, true);
    assert.equal(reloaded.session.settlement.totalNetCashMinor, 0);
    assert.equal(reloaded.session.settlement.participants.length, 3);
  });

  it("migrates legacy SQLite databases missing sessions.status, settlement_json, and seats.is_sitting_out", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "poker-legacy-"));
    const legacyDbPath = join(legacyDir, "legacy.sqlite");
    const rawDb = new DatabaseSync(legacyDbPath);
    rawDb.exec(`
      CREATE TABLE sessions (
        code TEXT PRIMARY KEY,
        host_token TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE seats (
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
    `);
    rawDb
      .prepare("INSERT INTO sessions (code, host_token, config_json, created_at) VALUES (?, ?, ?, ?)")
      .run(
        "LEG123",
        "legacy-host-token",
        JSON.stringify({
          seatCount: 2,
          smallBlind: 10,
          bigBlind: 20,
          smallestChipStep: 5,
          currencySymbol: "$",
          exchangeRateChips: 100,
          exchangeRateCashMinor: 100,
          minBuyInChips: null,
          maxBuyInChips: null,
        }),
        new Date().toISOString(),
      );
    rawDb
      .prepare(
        "INSERT INTO seats (session_code, seat_number, player_id, display_name, seat_token, relink_code, chips, total_buy_in_chips) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run("LEG123", 1, "p1", "Alice", "t1", 500, 500);
    rawDb
      .prepare(
        "INSERT INTO seats (session_code, seat_number, player_id, display_name, seat_token, relink_code, chips, total_buy_in_chips) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run("LEG123", 2, "p2", "Bob", "t2", 500, 500);
    rawDb.close();

    const legacyGateway = createSessionGateway({ dbPath: legacyDbPath });
    try {
      const baseUrl = await legacyGateway.listen(0, "127.0.0.1");
      const res = await fetch(`${baseUrl}/api/sessions/LEG123`, {
        headers: { "x-host-token": "legacy-host-token" },
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as { session: SessionSnapshot };
      assert.equal(data.session.status, "ACTIVE");
      assert.equal(data.session.settlement, null);
      assert.equal(data.session.seats[0]?.occupant?.isSittingOut, false);
    } finally {
      await legacyGateway.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("reconciles early Cash-Outs, busted Cash-Outs, Sit Out Cash-Outs, and Re-Entry together in final Settlement", async () => {
    const { code, hostToken, seats } = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, minBuyInChips: 100, maxBuyInChips: 2000 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 400 },
        { seatNumber: 2, displayName: "Bob", chips: 400 },
        { seatNumber: 3, displayName: "Carol", chips: 400 },
      ],
    );

    // Hand 1: Alice All-In (400), Bob folds (390 left), Carol calls All-In (400).
    // Alice wins 810 -> Alice=810, Bob=390, Carol=0 (busted).
    await startHand(gateway.url, code, hostToken);
    await submitAction(
      gateway.url,
      code,
      { "x-seat-token": seats[1]!.seatToken },
      { action: "ALL_IN" },
    );
    await submitAction(
      gateway.url,
      code,
      { "x-seat-token": seats[2]!.seatToken },
      { action: "FOLD" },
    );
    await submitAction(
      gateway.url,
      code,
      { "x-seat-token": seats[3]!.seatToken },
      { action: "CALL" },
    );
    const showdownRes = await fetch(`${gateway.url}/api/sessions/${code}/hand/showdown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": hostToken },
      body: JSON.stringify({ winnerSeatNumbers: [1] }),
    });
    assert.equal(showdownRes.status, 200);

    // Bob sits out, then cashes out while sitting out
    const bobSitOut = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/sit-out`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": seats[2]!.seatToken },
      body: JSON.stringify({ isSittingOut: true }),
    });
    assert.equal(bobSitOut.status, 200);
    const bobCashOut = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/cash-out`, {
      method: "POST",
      headers: { "x-host-token": hostToken },
    });
    assert.equal(bobCashOut.status, 200);

    // Busted Carol requests Cash-Out (0 chips, 400 buy-in) and Host approves
    const carolReqRes = await fetch(`${gateway.url}/api/sessions/${code}/cash-out-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": seats[3]!.seatToken },
      body: JSON.stringify({}),
    });
    assert.equal(carolReqRes.status, 201);
    const carolReq = (await carolReqRes.json()) as { request: { id: string } };
    const carolApprove = await fetch(
      `${gateway.url}/api/sessions/${code}/cash-out-requests/${carolReq.request.id}/approve`,
      {
        method: "POST",
        headers: { "x-host-token": hostToken },
      },
    );
    assert.equal(carolApprove.status, 200);

    // Bob re-enters on Seat 2 (isSittingOut resets to false!) and buys in 300 Chips
    const bobReclaim = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 2, displayName: "Bob" }),
    });
    assert.equal(bobReclaim.status, 200);
    const bobReclaimed = (await bobReclaim.json()) as {
      seatToken: string;
      playerId: string;
      session: SessionSnapshot;
    };
    assert.equal(
      bobReclaimed.session.seats.find((s) => s.seatNumber === 2)?.occupant?.isSittingOut,
      false,
    );
    const bobRebuyIn = await fetch(`${gateway.url}/api/sessions/${code}/seats/2/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": hostToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 300 }),
    });
    assert.equal(bobRebuyIn.status, 201);

    // Leave a pending Buy-In request on Seat 2 and a pending Cash-Out request on Seat 1 before settling
    const pendingTopUp = await fetch(`${gateway.url}/api/sessions/${code}/buy-in-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": bobReclaimed.seatToken },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 100 }),
    });
    assert.equal(pendingTopUp.status, 201);
    const pendingCashOut = await fetch(`${gateway.url}/api/sessions/${code}/cash-out-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": seats[1]!.seatToken },
      body: JSON.stringify({}),
    });
    assert.equal(pendingCashOut.status, 201);

    // Settle Session: includes Bob leg 1 (-10), Carol (-400), Alice (+410), Bob leg 2 (0)
    const settleRes = await fetch(`${gateway.url}/api/sessions/${code}/settle`, {
      method: "POST",
      headers: { "x-host-token": hostToken },
    });
    assert.equal(settleRes.status, 200);
    const settled = (await settleRes.json()) as {
      settlement: NonNullable<SessionSnapshot["settlement"]>;
      session: SessionSnapshot;
    };

    assert.equal(settled.session.status, "SETTLED");
    assert.deepEqual(settled.session.pendingRequests, []);
    assert.deepEqual(settled.session.pendingCashOutRequests, []);
    assert.equal(settled.settlement.participants.length, 4);
    assert.equal(settled.settlement.totalBuyInChips, 1500);
    assert.equal(settled.settlement.totalEndingChips, 1500);
    assert.equal(settled.settlement.chipDiscrepancy, 0);
    assert.equal(settled.settlement.totalNetCashMinor, 0);
    assert.equal(settled.settlement.isBalanced, true);

    const cashedOutIds = settled.settlement.participants
      .filter((p) => p.status === "CASHED_OUT")
      .map((p) => p.participantId);
    assert.deepEqual(cashedOutIds, [seats[2]!.playerId, seats[3]!.playerId]);

    const carolSummary = settled.settlement.participants.find(
      (p) => p.participantId === seats[3]!.playerId,
    );
    assert.equal(carolSummary?.endingChips, 0);
    assert.equal(carolSummary?.netCashMinor, -400);
  });
});
