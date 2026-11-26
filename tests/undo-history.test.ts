import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";
import { getLegalActions, type HandState } from "../src/shared/handEngine.ts";
import type {
  GetSessionHandsResponse,
  SessionSnapshot,
  SessionStats,
} from "../src/shared/session.ts";

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
      minBuyInChips: null,
      maxBuyInChips: null,
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
      const fundRes = await fetch(`${gatewayUrl}/api/sessions/${code}/seats/${p.seatNumber}/ledger`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-host-token": created.hostToken,
        },
        body: JSON.stringify({ kind: "BUY_IN", amountChips: p.chips }),
      });
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
  body?: Record<string, unknown>,
): Promise<{ hand: HandState; session: SessionSnapshot }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/start`, {
    method: "POST",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-host-token": hostToken,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { hand: HandState; session: SessionSnapshot };
}

async function act(
  gatewayUrl: string,
  code: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  expectedStatus = 200,
): Promise<{ hand?: HandState; session?: SessionSnapshot; error?: string }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, expectedStatus);
  return (await res.json()) as { hand?: HandState; session?: SessionSnapshot; error?: string };
}

async function undoStep(
  gatewayUrl: string,
  code: string,
  headers: Record<string, string>,
  expectedStatus = 200,
): Promise<{ hand?: HandState; session?: SessionSnapshot; error?: string }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/undo`, {
    method: "POST",
    headers,
  });
  assert.equal(res.status, expectedStatus);
  return (await res.json()) as { hand?: HandState; session?: SessionSnapshot; error?: string };
}

async function resolveShowdownPot(
  gatewayUrl: string,
  code: string,
  hostToken: string,
  winnerSeatNumbers: number[],
  potId?: string,
): Promise<{ hand: HandState; session: SessionSnapshot }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/showdown`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-host-token": hostToken,
    },
    body: JSON.stringify({ winnerSeatNumbers, ...(potId ? { potId } : {}) }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { hand: HandState; session: SessionSnapshot };
}

function getSeatChips(session: SessionSnapshot, seatNumber: number): number {
  const seat = session.seats.find((s) => s.seatNumber === seatNumber);
  assert.ok(seat?.occupant, `Expected occupied Seat ${seatNumber}`);
  return seat.occupant.chips;
}

describe("Multi-Step Host Undo & Durable Hand History", () => {
  let tempDir: string;
  let dbPath: string;
  let gateway: SessionGateway;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "poker-undo-history-"));
    dbPath = join(tempDir, "test.sqlite");
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0, "127.0.0.1");
  });

  after(async () => {
    await gateway.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enforces Host-only authority, 404s, and 409 boundary rejections for Undo (including Straddle & Settled)", async () => {
    const missingUndo = await undoStep(gateway.url, "NOPE99", { "x-host-token": "anything" }, 404);
    assert.ok(missingUndo.error);
    const missingHands = await fetch(`${gateway.url}/api/sessions/NOPE99/hands`);
    assert.equal(missingHands.status, 404);

    const setup = await createFundedSession(
      gateway.url,
      { allowStraddle: true },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
      ],
    );

    // Before first Hand starts
    assert.equal(setup.session.canUndo, false);
    assert.deepEqual(setup.session.handHistory, []);
    assert.deepEqual(setup.session.sessionStats, {
      handsPlayed: 0,
      biggestPotChips: 0,
      biggestHandNumber: null,
    } satisfies SessionStats);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);

    // Start Hand 1 (BTN=1, SB=2, BB=3, UTG=1)
    const started = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(started.session.canUndo, false);
    assert.equal(started.hand.actingSeatNumber, 1);
    const atStartErr = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);
    assert.match(atStartErr.error ?? "", /start of current Hand/i);

    // Post UTG Straddle via /hand/straddle
    const straddleRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/hand/straddle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seat-token": setup.seats[1]!.seatToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(straddleRes.status, 200);
    const afterStraddle = (await straddleRes.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(afterStraddle.hand.straddleSeatNumber, 1);
    assert.equal(afterStraddle.hand.actingSeatNumber, 2);
    assert.equal(afterStraddle.session.canUndo, true);
    assert.equal(getSeatChips(afterStraddle.session, 1), 460);

    // Non-Host cannot Undo (unauthenticated and seated Player)
    await undoStep(gateway.url, setup.code, {}, 403);
    await undoStep(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, 403);
    await undoStep(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, 403);

    // Host Undoes Straddle back to step 0
    const undoneStraddle = await undoStep(
      gateway.url,
      setup.code,
      { "x-host-token": setup.hostToken },
      200,
    );
    assert.equal(undoneStraddle.hand?.straddleSeatNumber, null);
    assert.equal(undoneStraddle.hand?.actingSeatNumber, 1);
    assert.equal(undoneStraddle.hand?.currentBet, 20);
    assert.equal(undoneStraddle.hand?.actionHistory.length, 0);
    assert.equal(undoneStraddle.session?.canUndo, false);
    assert.equal(getSeatChips(undoneStraddle.session!, 1), 500);

    // Further Undo rejected at step 0
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);

    // Finish Hand 1 via Fold-Win and Settle Session -> Undo rejected with 409
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "FOLD" });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "FOLD" });
    const settleRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/settle`, {
      method: "POST",
      headers: { "x-host-token": setup.hostToken },
    });
    assert.equal(settleRes.status, 200);
    const settled = (await settleRes.json()) as { session: SessionSnapshot };
    assert.equal(settled.session.canUndo, false);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);
  });

  it("steps Undo backward across Street transitions, restores exact stacks, Pots, raising rights, and broadcasts via WebSocket", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { anteMode: "BIG_BLIND_ANTE", anteChips: 10 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 1000 },
        { seatNumber: 2, displayName: "Bob", chips: 1000 },
        { seatNumber: 3, displayName: "Carol", chips: 160 },
      ],
    );

    const hostWs = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      hostToken: setup.hostToken,
    });
    const bobWs = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      seatToken: setup.seats[2]!.seatToken,
    });

    try {
      // Hand 1: BTN=1, SB=2 (posts 10), BB=3 (posts 20 + 10 BB Ante = 30 -> 130 left)
      await startHand(gateway.url, setup.code, setup.hostToken);

      // Preflop: 1 raises to 60, 2 calls 60, 3 calls 60 (Carol has 90 left) -> FLOP
      await act(
        gateway.url,
        setup.code,
        { "x-seat-token": setup.seats[1]!.seatToken },
        { action: "RAISE", amountChips: 60 },
      );
      await act(
        gateway.url,
        setup.code,
        { "x-seat-token": setup.seats[2]!.seatToken },
        { action: "CALL" },
      );
      const flopReached = await act(
        gateway.url,
        setup.code,
        { "x-seat-token": setup.seats[3]!.seatToken },
        { action: "CALL" },
      );
      assert.equal(flopReached.hand?.street, "FLOP");
      assert.equal(flopReached.hand?.potChips, 180);
      assert.equal(flopReached.hand?.deadPotChips, 10);
      assert.equal(flopReached.hand?.actingSeatNumber, 2);

      // Flop: 2 bets 60, 3 pushes short All-In to 90 (increment 30 < 60!), 1 calls 90
      await act(
        gateway.url,
        setup.code,
        { "x-seat-token": setup.seats[2]!.seatToken },
        { action: "BET", amountChips: 60 },
      );
      await act(
        gateway.url,
        setup.code,
        { "x-seat-token": setup.seats[3]!.seatToken },
        { action: "ALL_IN" },
      );
      const beforeBobCall = await act(
        gateway.url,
        setup.code,
        { "x-seat-token": setup.seats[1]!.seatToken },
        { action: "CALL" },
      );
      assert.equal(beforeBobCall.hand?.actingSeatNumber, 2);
      assert.equal(
        getLegalActions(beforeBobCall.hand!, setup.session.config, 2)?.canRaise,
        false,
        "Short All-In should lock Seat 2 from re-raising",
      );

      // Seat 2 calls 30 -> TURN
      const turnReached = await act(
        gateway.url,
        setup.code,
        { "x-seat-token": setup.seats[2]!.seatToken },
        { action: "CALL" },
      );
      assert.equal(turnReached.hand?.street, "TURN");
      assert.equal(turnReached.hand?.potChips, 450);
      assert.equal(turnReached.hand?.deadPotChips, 10);
      assert.equal(turnReached.hand?.actingSeatNumber, 2);

      // Turn: Seat 2 bets 100
      const afterTurnBet = await act(
        gateway.url,
        setup.code,
        { "x-seat-token": setup.seats[2]!.seatToken },
        { action: "BET", amountChips: 100 },
      );
      assert.equal(afterTurnBet.hand?.actingSeatNumber, 1);
      assert.equal(getSeatChips(afterTurnBet.session!, 2), 750);

      // Step 1 Undo: Turn bet 100 -> back to start of TURN
      const u1 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(u1.hand?.street, "TURN");
      assert.equal(u1.hand?.currentBet, 0);
      assert.equal(u1.hand?.actingSeatNumber, 2);
      assert.equal(getSeatChips(u1.session!, 2), 850);

      // Step 2 Undo: TURN -> FLOP transition, restoring short All-In raising-rights state!
      const u2 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(u2.hand?.street, "FLOP");
      assert.equal(u2.hand?.actingSeatNumber, 2);
      assert.equal(u2.hand?.potChips, 180);
      assert.equal(u2.hand?.deadPotChips, 10);
      assert.equal(u2.hand?.currentBet, 90);
      assert.equal(u2.hand?.lastFullRaiseBet, 60);
      assert.equal(u2.hand?.lastFullRaiseIncrement, 60);
      assert.equal(getSeatChips(u2.session!, 2), 880);
      assert.equal(getLegalActions(u2.hand!, setup.session.config, 2)?.canRaise, false);

      // Step 3 Undo: Alice's Call 90 on Flop
      const u3 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(u3.hand?.street, "FLOP");
      assert.equal(u3.hand?.actingSeatNumber, 1);
      assert.equal(getSeatChips(u3.session!, 1), 940);

      // Step 4 Undo: Carol's short All-In to 90 -> restores Carol's non-All-In stack and Seat 1 raising rights!
      const u4 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(u4.hand?.street, "FLOP");
      assert.equal(u4.hand?.actingSeatNumber, 3);
      assert.equal(u4.hand?.currentBet, 60);
      assert.equal(getSeatChips(u4.session!, 3), 90);
      assert.equal(u4.hand?.seats.find((s) => s.seatNumber === 3)?.isAllIn, false);
      assert.equal(getLegalActions(u4.hand!, setup.session.config, 1)?.canRaise, true);

      // Step 5 Undo: Bob's Flop Bet 60
      const u5 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(u5.hand?.street, "FLOP");
      assert.equal(u5.hand?.actingSeatNumber, 2);
      assert.equal(u5.hand?.currentBet, 0);
      assert.equal(getSeatChips(u5.session!, 2), 940);

      // Step 6 Undo: FLOP -> PREFLOP Street transition!
      const u6 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(u6.hand?.street, "PREFLOP");
      assert.equal(u6.hand?.actingSeatNumber, 3);
      assert.equal(u6.hand?.potChips, 0);
      assert.equal(u6.hand?.deadPotChips, 10);
      assert.equal(u6.hand?.currentBet, 60);
      assert.equal(u6.hand?.actionHistory.length, 2);
      assert.equal(getSeatChips(u6.session!, 3), 130);
      assert.equal(u6.hand?.seats.find((s) => s.seatNumber === 3)?.streetCommittedChips, 20);

      // Verify both Host & Bob WebSocket phones received live Undo state
      await waitForCondition(() => {
        const latestHost = hostWs.messages.at(-1)?.session;
        const latestBob = bobWs.messages.at(-1)?.session;
        return (
          latestHost?.hand?.street === "PREFLOP" &&
          latestHost.hand.actingSeatNumber === 3 &&
          latestBob?.hand?.street === "PREFLOP" &&
          latestBob.hand.actingSeatNumber === 3 &&
          latestBob.seats.find((s) => s.seatNumber === 2)?.occupant?.chips === 940
        );
      });
    } finally {
      hostWs.ws.close();
      bobWs.ws.close();
    }
  });

  it("rewinds just-resolved Fold-Win (with uncalled return), Showdown, and Run It Twice partial pots before next Hand starts", async () => {
    // Part A: Fold-Win rewind
    const foldSetup = await createFundedSession(
      gateway.url,
      {},
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
      ],
    );

    await startHand(gateway.url, foldSetup.code, foldSetup.hostToken);
    await act(
      gateway.url,
      foldSetup.code,
      { "x-seat-token": foldSetup.seats[1]!.seatToken },
      { action: "RAISE", amountChips: 80 },
    );
    await act(
      gateway.url,
      foldSetup.code,
      { "x-seat-token": foldSetup.seats[2]!.seatToken },
      { action: "FOLD" },
    );
    const foldWin = await act(
      gateway.url,
      foldSetup.code,
      { "x-seat-token": foldSetup.seats[3]!.seatToken },
      { action: "FOLD" },
    );
    assert.equal(foldWin.hand?.status, "COMPLETE");
    assert.equal(foldWin.hand?.result?.reason, "FOLD_WIN");
    assert.equal(foldWin.hand?.result?.uncalledReturned?.amountChips, 60);
    assert.equal(foldWin.session?.canUndo, true);
    assert.equal(foldWin.session?.handHistory.length, 1);
    assert.equal(foldWin.session?.sessionStats.handsPlayed, 1);
    assert.equal(getSeatChips(foldWin.session!, 1), 530);

    // Undo Fold-Win -> back to Carol facing 80 Preflop with uncalled chips back in street pot
    const rewoundFold = await undoStep(gateway.url, foldSetup.code, {
      "x-host-token": foldSetup.hostToken,
    });
    assert.equal(rewoundFold.hand?.status, "BETTING");
    assert.equal(rewoundFold.hand?.street, "PREFLOP");
    assert.equal(rewoundFold.hand?.actingSeatNumber, 3);
    assert.equal(rewoundFold.hand?.result, null);
    assert.equal(rewoundFold.hand?.lastUncalledReturned, null);
    assert.equal(rewoundFold.session?.handInProgress, true);
    assert.equal(rewoundFold.session?.handHistory.length, 0);
    assert.equal(rewoundFold.session?.sessionStats.handsPlayed, 0);
    assert.equal(getSeatChips(rewoundFold.session!, 1), 420);
    assert.equal(rewoundFold.hand?.seats.find((s) => s.seatNumber === 1)?.streetCommittedChips, 80);

    // Carol can now Call instead of Fold
    const carolCalled = await act(
      gateway.url,
      foldSetup.code,
      { "x-seat-token": foldSetup.seats[3]!.seatToken },
      { action: "CALL" },
    );
    assert.equal(carolCalled.hand?.street, "FLOP");

    // Part B: Showdown + Run It Twice partial-pot Undo
    const ritSetup = await createFundedSession(
      gateway.url,
      { allowRunItTwice: true },
      [
        { seatNumber: 1, displayName: "Alice", chips: 200 },
        { seatNumber: 2, displayName: "Bob", chips: 400 },
        { seatNumber: 3, displayName: "Carol", chips: 400 },
      ],
    );

    await startHand(gateway.url, ritSetup.code, ritSetup.hostToken);
    await act(
      gateway.url,
      ritSetup.code,
      { "x-seat-token": ritSetup.seats[1]!.seatToken },
      { action: "ALL_IN" },
    );
    await act(
      gateway.url,
      ritSetup.code,
      { "x-seat-token": ritSetup.seats[2]!.seatToken },
      { action: "ALL_IN" },
    );
    const showdownReady = await act(
      gateway.url,
      ritSetup.code,
      { "x-seat-token": ritSetup.seats[3]!.seatToken },
      { action: "CALL" },
    );
    assert.equal(showdownReady.hand?.status, "SHOWDOWN");
    assert.equal(showdownReady.hand?.pots.length, 2);

    // Enable Run It Twice (and verify idempotent second call doesn't add a phantom Undo checkpoint)
    const ritRes = await fetch(`${gateway.url}/api/sessions/${ritSetup.code}/hand/run-it-twice`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-host-token": ritSetup.hostToken,
      },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(ritRes.status, 200);
    const ritOn = (await ritRes.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(ritOn.hand.runItTwice, true);
    assert.equal(ritOn.hand.pots.length, 4);

    const ritNoOpRes = await fetch(`${gateway.url}/api/sessions/${ritSetup.code}/hand/run-it-twice`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-host-token": ritSetup.hostToken,
      },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(ritNoOpRes.status, 200);

    // Resolve all 4 Run It Twice pots
    await resolveShowdownPot(gateway.url, ritSetup.code, ritSetup.hostToken, [1], "main-run-1");
    await resolveShowdownPot(gateway.url, ritSetup.code, ritSetup.hostToken, [2], "main-run-2");
    await resolveShowdownPot(gateway.url, ritSetup.code, ritSetup.hostToken, [2], "side-1-run-1");
    const completedRit = await resolveShowdownPot(
      gateway.url,
      ritSetup.code,
      ritSetup.hostToken,
      [3],
      "side-1-run-2",
    );
    assert.equal(completedRit.hand.status, "COMPLETE");
    assert.equal(getSeatChips(completedRit.session, 1), 300);
    assert.equal(getSeatChips(completedRit.session, 2), 500);
    assert.equal(getSeatChips(completedRit.session, 3), 200);
    assert.equal(completedRit.session.handHistory.length, 1);

    // Undo final pot -> COMPLETE -> SHOWDOWN with only side-1-run-2 unresolved
    const undoSide2 = await undoStep(gateway.url, ritSetup.code, { "x-host-token": ritSetup.hostToken });
    assert.equal(undoSide2.hand?.status, "SHOWDOWN");
    assert.equal(undoSide2.session?.handHistory.length, 0);
    assert.equal(getSeatChips(undoSide2.session!, 3), 0);
    assert.equal(
      undoSide2.hand?.pots.find((p) => p.id === "side-1-run-2")?.winnerSeatNumbers,
      null,
    );
    assert.deepEqual(
      undoSide2.hand?.pots.find((p) => p.id === "side-1-run-1")?.winnerSeatNumbers,
      [2],
    );

    // Undo partial pots all the way back to Run It Twice OFF
    const undoSide1 = await undoStep(gateway.url, ritSetup.code, { "x-host-token": ritSetup.hostToken });
    assert.equal(getSeatChips(undoSide1.session!, 2), 300);

    const undoMain2 = await undoStep(gateway.url, ritSetup.code, { "x-host-token": ritSetup.hostToken });
    assert.equal(getSeatChips(undoMain2.session!, 2), 0);

    const undoMain1 = await undoStep(gateway.url, ritSetup.code, { "x-host-token": ritSetup.hostToken });
    assert.equal(getSeatChips(undoMain1.session!, 1), 0);
    assert.equal(undoMain1.hand?.runItTwice, true);

    const undoRitOff = await undoStep(gateway.url, ritSetup.code, { "x-host-token": ritSetup.hostToken });
    assert.equal(undoRitOff.hand?.runItTwice, false);
    assert.equal(undoRitOff.hand?.pots.length, 2);

    // Re-resolve with corrected single-run winners
    await resolveShowdownPot(gateway.url, ritSetup.code, ritSetup.hostToken, [1], "main");
    const finalRit = await resolveShowdownPot(
      gateway.url,
      ritSetup.code,
      ritSetup.hostToken,
      [2],
      "side-1",
    );
    assert.equal(finalRit.hand.status, "COMPLETE");
    assert.equal(getSeatChips(finalRit.session, 1), 600);
    assert.equal(getSeatChips(finalRit.session, 2), 400);
    assert.equal(getSeatChips(finalRit.session, 3), 0);
    assert.equal(finalRit.session.handHistory.length, 1);
  });

  it("locks prior Hands once a new Hand starts and recovers Undo checkpoints across server restart", async () => {
    const setup = await createFundedSession(
      gateway.url,
      {},
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
      ],
    );

    // Hand 1: Heads-Up (BTN/SB=1, BB=2). Seat 1 folds -> Bob wins 20 Pot (Alice 490, Bob 510)
    await startHand(gateway.url, setup.code, setup.hostToken);
    const h1Done = await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "FOLD" },
    );
    assert.equal(h1Done.hand?.status, "COMPLETE");
    assert.equal(h1Done.session?.canUndo, true);
    assert.equal(h1Done.session?.handHistory.length, 1);

    // Start Hand 2 -> Hand 1 locks permanently
    const h2Start = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(h2Start.hand.handNumber, 2);
    assert.equal(h2Start.session.canUndo, false);
    assert.equal(h2Start.session.handHistory.length, 1);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);

    // Hand 2 (BTN/SB=2, BB=1): Seat 2 raises to 60, Seat 1 calls -> FLOP
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[2]!.seatToken },
      { action: "RAISE", amountChips: 60 },
    );
    const h2Flop = await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "CALL" },
    );
    assert.equal(h2Flop.hand?.street, "FLOP");
    assert.equal(h2Flop.session?.canUndo, true);

    // Restart gateway against same SQLite DB
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0, "127.0.0.1");

    const reloadRes = await fetch(`${gateway.url}/api/sessions/${setup.code}`, {
      headers: { "x-host-token": setup.hostToken },
    });
    assert.equal(reloadRes.status, 200);
    const reloaded = (await reloadRes.json()) as { session: SessionSnapshot };
    assert.equal(reloaded.session.canUndo, true);
    assert.equal(reloaded.session.hand?.handNumber, 2);
    assert.equal(reloaded.session.hand?.street, "FLOP");
    assert.equal(reloaded.session.handHistory.length, 1);

    // Undo across server restart: FLOP -> PREFLOP in Hand 2
    const u1 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
    assert.equal(u1.hand?.handNumber, 2);
    assert.equal(u1.hand?.street, "PREFLOP");
    assert.equal(u1.hand?.actingSeatNumber, 1);
    assert.equal(getSeatChips(u1.session!, 1), 470);

    // Undo Seat 2's raise -> step 0 of Hand 2
    const u2 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
    assert.equal(u2.hand?.handNumber, 2);
    assert.equal(u2.hand?.actingSeatNumber, 2);
    assert.equal(u2.session?.canUndo, false);
    assert.equal(getSeatChips(u2.session!, 2), 500);

    // Cannot undo into Hand 1
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);
  });

  it("guards completed Hand rewind against post-Hand Top-Up, Rebuy, and Cash-Out while allowing safe mid-Hand newcomer Buy-In", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { minBuyInChips: 100, maxBuyInChips: 1000 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 300 },
        { seatNumber: 2, displayName: "Bob", chips: 300 },
      ],
    );

    // Hand 1: All-In Showdown -> Alice wins 600, Bob busted (0)
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "ALL_IN" },
    );
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[2]!.seatToken },
      { action: "CALL" },
    );
    const h1Complete = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1]);
    assert.equal(h1Complete.session.canUndo, true);

    // Bob takes a Rebuy of 300 between Hands -> must lock Undo of Hand 1!
    const rebuyRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/2/ledger`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-host-token": setup.hostToken,
      },
      body: JSON.stringify({ kind: "REBUY", amountChips: 300 }),
    });
    assert.equal(rebuyRes.status, 201);
    const afterRebuy = (await rebuyRes.json()) as { session: SessionSnapshot };
    assert.equal(afterRebuy.session.canUndo, false);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);
    assert.equal(getSeatChips(afterRebuy.session, 2), 300);

    // Hand 2: Bob wins small Fold-Win -> Alice takes Top-Up -> locks Undo
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[2]!.seatToken },
      { action: "FOLD" },
    );
    const topUpRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/1/ledger`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-host-token": setup.hostToken,
      },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 100 }),
    });
    assert.equal(topUpRes.status, 201);
    const afterTopUp = (await topUpRes.json()) as { session: SessionSnapshot };
    assert.equal(afterTopUp.session.canUndo, false);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);

    // Hand 3: Completed -> Seat 2 Cashes Out -> locks Undo
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "FOLD" },
    );
    const cashOutRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/2/cash-out`, {
      method: "POST",
      headers: { "x-host-token": setup.hostToken },
    });
    assert.equal(cashOutRes.status, 200);
    const afterCashOut = (await cashOutRes.json()) as { session: SessionSnapshot };
    assert.equal(afterCashOut.session.canUndo, false);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);

    // Newcomer Seat 3 claims & buys in so we can play Hand 4, then Seat 4 joins mid-Hand 4
    const claim3 = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 3, displayName: "Carol" }),
    });
    assert.equal(claim3.status, 200);
    const seat3 = (await claim3.json()) as { seatToken: string };
    await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/3/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": setup.hostToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 300 }),
    });

    // Start Hand 4 (Seat 1 vs Seat 3)
    const h4 = await startHand(gateway.url, setup.code, setup.hostToken);
    const firstActor = h4.hand.actingSeatNumber!;
    const actorToken = firstActor === 1 ? setup.seats[1]!.seatToken : seat3.seatToken;
    await act(gateway.url, setup.code, { "x-seat-token": actorToken }, { action: "RAISE", amountChips: 60 });

    // Seat 4 claims & gets initial BUY_IN mid-Hand 4
    const claim4 = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 4, displayName: "Dave" }),
    });
    assert.equal(claim4.status, 200);
    const buyIn4 = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/4/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": setup.hostToken },
      body: JSON.stringify({ kind: "BUY_IN", amountChips: 300 }),
    });
    assert.equal(buyIn4.status, 201);

    // Active Hand 4 Undo still works and preserves Dave's mid-Hand Buy-In!
    const undoMidHand = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
    assert.equal(undoMidHand.hand?.actionHistory.length, 0);
    assert.equal(getSeatChips(undoMidHand.session!, 4), 300);
  });

  it("exposes GET /api/sessions/:code/hands and accurate Hand history / Session stats across multiple Hands", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { allowStraddle: true },
      [
        { seatNumber: 1, displayName: "Alice", chips: 300 },
        { seatNumber: 2, displayName: "Bob", chips: 100 },
        { seatNumber: 3, displayName: "Carol", chips: 300 },
      ],
    );

    // Hand 1: Small Fold-Win (Pot = 30)
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "FOLD" },
    );
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[2]!.seatToken },
      { action: "FOLD" },
    );

    // Hand 2: Side-Pot Showdown with Host proxy action (Main Pot = 270, Side Pot 1 = 420 -> Total 690)
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[2]!.seatToken },
      { action: "ALL_IN" },
    );
    await act(
      gateway.url,
      setup.code,
      { "x-host-token": setup.hostToken },
      { seatNumber: 3, action: "ALL_IN" },
    );
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "CALL" },
    );
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [2], "main");
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1], "side-1");

    // Top-Up Carol (10 -> 300) for Hand 3 with UTG Straddle
    const topUp3 = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/3/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": setup.hostToken },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 290 }),
    });
    assert.equal(topUp3.status, 201);
    await startHand(gateway.url, setup.code, setup.hostToken, { postStraddle: true });
    // BTN=3, SB=1 (10), BB=2 (20), UTG=3 (Straddle 40) -> acting Seat 1 calls 30 (to 40), Seat 2 folds, Seat 3 checks -> FLOP
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "CALL" },
    );
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[2]!.seatToken },
      { action: "FOLD" },
    );
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[3]!.seatToken },
      { action: "CHECK" },
    );
    // Flop: Seat 1 bets 50, Seat 3 folds -> Fold-Win pot 100
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "BET", amountChips: 50 },
    );
    await act(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[3]!.seatToken },
      { action: "FOLD" },
    );

    // Player queries GET /api/sessions/:code/hands (no host token required)
    const handsRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/hands`);
    assert.equal(handsRes.status, 200);
    const handsData = (await handsRes.json()) as GetSessionHandsResponse;

    assert.equal(handsData.hands.length, 3);
    assert.deepEqual(
      handsData.hands.map((h) => h.handNumber),
      [3, 2, 1],
    );
    assert.deepEqual(handsData.sessionStats, {
      handsPlayed: 3,
      biggestPotChips: 690,
      biggestHandNumber: 2,
    });

    const hand2 = handsData.hands.find((h) => h.handNumber === 2)!;
    assert.equal(hand2.result?.reason, "SHOWDOWN");
    assert.equal(hand2.pots.length, 2);
    assert.equal(hand2.actionHistory.some((a) => a.seatNumber === 3 && a.byHostProxy), true);
    assert.equal(hand2.result?.awards.length, 2);

    const hand3 = handsData.hands.find((h) => h.handNumber === 3)!;
    assert.equal(hand3.straddleSeatNumber, 3);

    // Matches SessionSnapshot handHistory & sessionStats
    const sessionRes = await fetch(`${gateway.url}/api/sessions/${setup.code}`);
    assert.equal(sessionRes.status, 200);
    const sessionData = (await sessionRes.json()) as { session: SessionSnapshot };
    assert.deepEqual(sessionData.session.handHistory, handsData.hands);
    assert.deepEqual(sessionData.session.sessionStats, handsData.sessionStats);
  });
});
