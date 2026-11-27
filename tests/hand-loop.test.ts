import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";
import { getLegalActions, type HandState } from "../src/shared/handEngine.ts";
import type { SessionSnapshot } from "../src/shared/session.ts";

interface SnapshotMessage {
  type: string;
  error?: string;
  viewer: { isHost: boolean; seatNumber: number | null; playerId: string | null };
  session: SessionSnapshot;
}

async function createFundedSession(
  gatewayUrl: string,
  configOverrides: Record<string, unknown> = {},
  players: Array<{ seatNumber: number; displayName: string; chips?: number }> = [],
): Promise<{
  code: string;
  hostToken: string;
  seats: Record<number, { seatToken: string; playerId: string; seatNumber: number }>;
  session: SessionSnapshot;
}> {
  const startingStackChips =
    typeof configOverrides.startingStackChips === "number"
      ? configOverrides.startingStackChips
      : 1000;
  const createRes = await fetch(`${gatewayUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seatCount: 6,
      startingStackChips,
      smallBlind: 10,
      bigBlind: 20,
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

async function startHand(gatewayUrl: string, code: string, hostToken: string): Promise<Response> {
  return fetch(`${gatewayUrl}/api/sessions/${code}/hand/start`, {
    method: "POST",
    headers: { "x-host-token": hostToken },
  });
}

async function submitAction(
  gatewayUrl: string,
  code: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${gatewayUrl}/api/sessions/${code}/hand/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function resolveShowdownReq(
  gatewayUrl: string,
  code: string,
  hostToken: string,
  winnerSeatNumbers: number[],
): Promise<Response> {
  return fetch(`${gatewayUrl}/api/sessions/${code}/hand/showdown`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-host-token": hostToken,
    },
    body: JSON.stringify({ winnerSeatNumbers }),
  });
}

function getSeatChips(session: SessionSnapshot, seatNumber: number): number {
  const occ = session.seats.find((s) => s.seatNumber === seatNumber)?.occupant;
  assert.ok(occ, `Expected Seat ${seatNumber} to be occupied`);
  return occ.chips;
}

describe("Core No-Limit Hold'em Hand Loop & Single-Pot Showdown", () => {
  let tmpDir: string;
  let dbPath: string;
  let gateway: SessionGateway;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "poker-hand-loop-"));
    dbPath = join(tmpDir, "poker.db");
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);
  });

  after(async () => {
    await gateway.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enforces Start Hand readiness, Heads-Up Button=SB and acting order, street auto-advancement, and Moving Button rotation", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 1000, smallBlind: 10, bigBlind: 20 },
      [{ seatNumber: 2, displayName: "Alice" }],
    );
    const seat2 = setup.seats[2]!;

    assert.equal(setup.session.hand, null);
    assert.equal(setup.session.handInProgress, false);

    // Non-Host cannot start a Hand
    const unauthStart = await fetch(`${gateway.url}/api/sessions/${setup.code}/hand/start`, {
      method: "POST",
      headers: { "x-seat-token": seat2.seatToken },
    });
    assert.equal(unauthStart.status, 403);

    // Cannot start a Hand with only 1 funded Seat
    const oneFundedStart = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(oneFundedStart.status, 409);

    // Bob claims Seat 5 and is auto-funded with 1000 Chips so 2 funded Seats are ready
    const claimBob = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 5, displayName: "Bob" }),
    });
    assert.equal(claimBob.status, 200);
    const seat5 = (await claimBob.json()) as { seatToken: string; playerId: string; seatNumber: number };

    const aliceWs = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      seatToken: seat2.seatToken,
    });
    const bobWs = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      seatToken: seat5.seatToken,
    });

    // Start Hand 1 (Heads-Up: Seat 2 = Button/SB, Seat 5 = BB)
    const start1Res = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(start1Res.status, 201);
    const start1 = (await start1Res.json()) as { hand: HandState; session: SessionSnapshot };

    assert.equal(start1.session.handInProgress, true);
    assert.equal(start1.hand.handNumber, 1);
    assert.equal(start1.hand.status, "BETTING");
    assert.equal(start1.hand.street, "PREFLOP");
    assert.equal(start1.hand.isHeadsUp, true);
    assert.equal(start1.hand.buttonSeatNumber, 2);
    assert.equal(start1.hand.sbSeatNumber, 2);
    assert.equal(start1.hand.bbSeatNumber, 5);
    // In Heads-Up Preflop, Button/SB acts first
    assert.equal(start1.hand.actingSeatNumber, 2);
    assert.equal(getSeatChips(start1.session, 2), 990);
    assert.equal(getSeatChips(start1.session, 5), 980);

    // Cannot start another Hand while Hand 1 is in progress
    const duplicateStart = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(duplicateStart.status, 409);

    // Live WebSocket sync delivers active Hand state
    await waitForCondition(() =>
      bobWs.messages.some((m) => m.session.handInProgress && m.session.hand?.actingSeatNumber === 2),
    );

    // Preflop: Alice (Seat 2) Calls 10 -> Bob (Seat 5) Checks -> advances automatically to FLOP with BB acting first!
    const callRes = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": seat2.seatToken },
      { action: "CALL" },
    );
    assert.equal(callRes.status, 200);
    const afterCall = (await callRes.json()) as { hand: HandState };
    assert.equal(afterCall.hand.street, "PREFLOP");
    assert.equal(afterCall.hand.actingSeatNumber, 5);

    const checkPreflopRes = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": seat5.seatToken },
      { action: "CHECK" },
    );
    assert.equal(checkPreflopRes.status, 200);
    const flopState = (await checkPreflopRes.json()) as { hand: HandState };
    assert.equal(flopState.hand.street, "FLOP");
    assert.equal(flopState.hand.potChips, 40);
    assert.equal(flopState.hand.actingSeatNumber, 5); // BB (left of Button) acts first postflop

    // Flop: Check -> Check -> advances to TURN
    assert.equal(
      (await submitAction(gateway.url, setup.code, { "x-seat-token": seat5.seatToken }, { action: "CHECK" }))
        .status,
      200,
    );
    const turnRes = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": seat2.seatToken },
      { action: "CHECK" },
    );
    assert.equal(turnRes.status, 200);
    const turnState = (await turnRes.json()) as { hand: HandState };
    assert.equal(turnState.hand.street, "TURN");
    assert.equal(turnState.hand.actingSeatNumber, 5);

    // Turn: Check -> Check -> advances to RIVER
    assert.equal(
      (await submitAction(gateway.url, setup.code, { "x-seat-token": seat5.seatToken }, { action: "CHECK" }))
        .status,
      200,
    );
    const riverRes = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": seat2.seatToken },
      { action: "CHECK" },
    );
    assert.equal(riverRes.status, 200);
    const riverState = (await riverRes.json()) as { hand: HandState };
    assert.equal(riverState.hand.street, "RIVER");
    assert.equal(riverState.hand.actingSeatNumber, 5);

    // River: Check -> Check -> advances to SHOWDOWN
    assert.equal(
      (await submitAction(gateway.url, setup.code, { "x-seat-token": seat5.seatToken }, { action: "CHECK" }))
        .status,
      200,
    );
    const showdownEnterRes = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": seat2.seatToken },
      { action: "CHECK" },
    );
    assert.equal(showdownEnterRes.status, 200);
    const showdownEnter = (await showdownEnterRes.json()) as { hand: HandState };
    assert.equal(showdownEnter.hand.status, "SHOWDOWN");
    assert.equal(showdownEnter.hand.actingSeatNumber, null);
    assert.equal(showdownEnter.hand.potChips, 40);

    // Host awards Showdown pot to Seat 2 (Alice)
    const resolveRes = await resolveShowdownReq(gateway.url, setup.code, setup.hostToken, [2]);
    assert.equal(resolveRes.status, 200);
    const resolved = (await resolveRes.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(resolved.hand.status, "COMPLETE");
    assert.equal(resolved.session.handInProgress, false);
    assert.equal(getSeatChips(resolved.session, 2), 1020);
    assert.equal(getSeatChips(resolved.session, 5), 980);

    // Start Hand 2: Button rotates clockwise to Seat 5!
    const start2Res = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(start2Res.status, 201);
    const start2 = (await start2Res.json()) as { hand: HandState };
    assert.equal(start2.hand.handNumber, 2);
    assert.equal(start2.hand.buttonSeatNumber, 5);
    assert.equal(start2.hand.sbSeatNumber, 5);
    assert.equal(start2.hand.bbSeatNumber, 2);
    assert.equal(start2.hand.actingSeatNumber, 5);

    await waitForCondition(() =>
      aliceWs.messages.some((m) => m.session.hand?.handNumber === 2 && m.session.hand.buttonSeatNumber === 5),
    );
    aliceWs.ws.close();
    bobWs.ws.close();
  });

  it("enforces multi-way turn order, min-bet/min-raise/step validation, and short All-In non-reopening rules", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 1000 },
        { seatNumber: 2, displayName: "Bob", chips: 1000 },
        { seatNumber: 4, displayName: "Carol", chips: 1000 },
        { seatNumber: 6, displayName: "Dan", chips: 1000 },
      ],
    );

    const startRes = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(startRes.status, 201);
    const started = (await startRes.json()) as { hand: HandState };

    // Multi-way order: Button=1, SB=2, BB=4, UTG=6
    assert.equal(started.hand.isHeadsUp, false);
    assert.equal(started.hand.buttonSeatNumber, 1);
    assert.equal(started.hand.sbSeatNumber, 2);
    assert.equal(started.hand.bbSeatNumber, 4);
    assert.equal(started.hand.actingSeatNumber, 6);

    // Wrong seat acting out of turn -> 409
    const outOfTurn = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "CALL" },
    );
    assert.equal(outOfTurn.status, 409);

    // Player trying to spoof seatNumber -> 403
    const spoofSeat = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { seatNumber: 6, action: "CALL" },
    );
    assert.equal(spoofSeat.status, 403);

    // Seat 6 (UTG) cannot Check when facing BB=20
    const badCheck = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[6]!.seatToken },
      { action: "CHECK" },
    );
    assert.equal(badCheck.status, 409);

    // Fractional raise rejected (400)
    const fractionalRaise = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[6]!.seatToken },
      { action: "RAISE", amountChips: 42.5 },
    );
    assert.equal(fractionalRaise.status, 400);

    // Below min-raise rejected (400): currentBet=20, minRaiseTo=40
    const belowMinRaise = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[6]!.seatToken },
      { action: "RAISE", amountChips: 35 },
    );
    assert.equal(belowMinRaise.status, 400);

    // Seat 6 raises to 60 (+40 increment -> next min-raise is 60 + 40 = 100)
    const raise60 = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[6]!.seatToken },
      { action: "RAISE", amountChips: 60 },
    );
    assert.equal(raise60.status, 200);
    const afterRaise60 = (await raise60.json()) as { hand: HandState };
    assert.equal(afterRaise60.hand.actingSeatNumber, 1);
    assert.equal(afterRaise60.hand.currentBet, 60);
    assert.equal(afterRaise60.hand.lastFullRaiseIncrement, 40);

    // Seat 1 (Button) tries re-raising to 80 (< 100) -> rejected (400)
    const belowMinReraise = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "RAISE", amountChips: 80 },
    );
    assert.equal(belowMinReraise.status, 400);

    // Seat 1 calls 60; Seat 2 (SB) folds; Seat 4 (BB) calls 40 more (total 60) -> FLOP
    assert.equal(
      (await submitAction(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "CALL" }))
        .status,
      200,
    );
    assert.equal(
      (await submitAction(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "FOLD" }))
        .status,
      200,
    );
    const bbCallRes = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[4]!.seatToken },
      { action: "CALL" },
    );
    assert.equal(bbCallRes.status, 200);
    const flop = (await bbCallRes.json()) as { hand: HandState };
    assert.equal(flop.hand.street, "FLOP");
    assert.equal(flop.hand.potChips, 190); // 10 (SB fold) + 60*3
    // Seat 2 folded, so first active seat left of Button (1) is Seat 4!
    assert.equal(flop.hand.actingSeatNumber, 4);

    // On Flop, CALL when toCall=0 is rejected
    const badCall = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[4]!.seatToken },
      { action: "CALL" },
    );
    assert.equal(badCall.status, 409);

    // Flop min-bet is Big Blind (20): betting 15 is rejected (400)
    const badMinBet = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[4]!.seatToken },
      { action: "BET", amountChips: 15 },
    );
    assert.equal(badMinBet.status, 400);

    // Seat 4 bets 50 -> Seat 6 calls 50 -> Seat 1 folds -> Turn starts with Seat 4 acting
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setup.code,
          { "x-seat-token": setup.seats[4]!.seatToken },
          { action: "BET", amountChips: 50 },
        )
      ).status,
      200,
    );
    assert.equal(
      (await submitAction(gateway.url, setup.code, { "x-seat-token": setup.seats[6]!.seatToken }, { action: "CALL" }))
        .status,
      200,
    );
    const foldToTurnRes = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "FOLD" },
    );
    assert.equal(foldToTurnRes.status, 200);
    const turn = (await foldToTurnRes.json()) as { hand: HandState };
    assert.equal(turn.hand.street, "TURN");
    assert.equal(turn.hand.potChips, 290);
    assert.equal(turn.hand.actingSeatNumber, 4);
  });

  it("supports Host proxy Actions, safe mid-Hand Seat claiming, and new Players entering next Hand without dead-blind penalties", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 500, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 4, displayName: "Bob" },
      ],
    );

    const start1Res = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(start1Res.status, 201);
    const start1 = (await start1Res.json()) as { hand: HandState };
    assert.equal(start1.hand.buttonSeatNumber, 1);
    assert.equal(start1.hand.actingSeatNumber, 1);

    // New Player Carol claims open Seat 2 mid-Hand (auto-funded 500 Chips) without entering Hand 1
    const carolClaimRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 2, displayName: "Carol" }),
    });
    assert.equal(carolClaimRes.status, 200);
    const carolClaim = (await carolClaimRes.json()) as { session: SessionSnapshot };
    assert.equal(carolClaim.session.hand?.seats.length, 2);
    assert.equal(carolClaim.session.hand?.seats.some((s) => s.seatNumber === 2), false);

    // Host proxies Seat 1 raise to 60, then proxies Seat 4 Fold -> immediate Fold-Win!
    const proxyRaise = await submitAction(
      gateway.url,
      setup.code,
      { "x-host-token": setup.hostToken },
      { seatNumber: 1, action: "RAISE", amountChips: 60 },
    );
    assert.equal(proxyRaise.status, 200);
    const afterProxyRaise = (await proxyRaise.json()) as { hand: HandState };
    assert.equal(afterProxyRaise.hand.actionHistory.at(-1)?.byHostProxy, true);
    assert.equal(afterProxyRaise.hand.actingSeatNumber, 4);

    const proxyFold = await submitAction(
      gateway.url,
      setup.code,
      { "x-host-token": setup.hostToken },
      { seatNumber: 4, action: "FOLD" },
    );
    assert.equal(proxyFold.status, 200);
    const foldWin = (await proxyFold.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(foldWin.hand.status, "COMPLETE");
    assert.equal(foldWin.session.handInProgress, false);
    assert.equal(foldWin.hand.result?.reason, "FOLD_WIN");
    assert.equal(getSeatChips(foldWin.session, 1), 520); // Won Bob's 20 BB
    assert.equal(getSeatChips(foldWin.session, 4), 480);
    assert.equal(getSeatChips(foldWin.session, 2), 500); // Untouched mid-hand joiner

    // Hand 2 starts: Moving Button advances clockwise from 1 -> Seat 2 (Carol)!
    // Carol enters with zero dead-blind penalty (SB=4, BB=1, BTN=2 acts first preflop)
    const start2Res = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(start2Res.status, 201);
    const start2 = (await start2Res.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(start2.hand.handNumber, 2);
    assert.equal(start2.hand.seats.length, 3);
    assert.equal(start2.hand.buttonSeatNumber, 2);
    assert.equal(start2.hand.sbSeatNumber, 4);
    assert.equal(start2.hand.bbSeatNumber, 1);
    assert.equal(start2.hand.actingSeatNumber, 2);
    assert.equal(getSeatChips(start2.session, 2), 500); // No dead blind deducted
    assert.equal(getSeatChips(start2.session, 4), 470); // Posted 10 SB
    assert.equal(getSeatChips(start2.session, 1), 500); // Posted 20 BB (520 - 20)
  });

  it("handles All-In uncalled excess return, short All-In non-reopening, and odd-Chip Showdown splits left of Button", async () => {
    // 1. Short All-In non-reopening test: start with 500 each, drop Carol (Seat 5) to 70 via Hand 1
    const setupShort = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 500, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 3, displayName: "Bob" },
        { seatNumber: 5, displayName: "Carol" },
      ],
    );
    await startHand(gateway.url, setupShort.code, setupShort.hostToken);
    // Hand 1 (Button=1, SB=3, BB=5): Alice(1) raises to 430, Bob(3) folds, Carol(5) calls 430 -> Flop: Carol checks, Alice bets 20, Carol folds -> Carol=70!
    await submitAction(gateway.url, setupShort.code, { "x-seat-token": setupShort.seats[1]!.seatToken }, { action: "RAISE", amountChips: 430 });
    await submitAction(gateway.url, setupShort.code, { "x-seat-token": setupShort.seats[3]!.seatToken }, { action: "FOLD" });
    await submitAction(gateway.url, setupShort.code, { "x-seat-token": setupShort.seats[5]!.seatToken }, { action: "CALL" });
    await submitAction(gateway.url, setupShort.code, { "x-seat-token": setupShort.seats[5]!.seatToken }, { action: "CHECK" });
    await submitAction(gateway.url, setupShort.code, { "x-seat-token": setupShort.seats[1]!.seatToken }, { action: "BET", amountChips: 20 });
    await submitAction(gateway.url, setupShort.code, { "x-seat-token": setupShort.seats[5]!.seatToken }, { action: "FOLD" });

    // Hand 2: Button=3 (Bob), SB=5 (Carol=70 total), BB=1 (Alice)
    await startHand(gateway.url, setupShort.code, setupShort.hostToken);
    // Seat 3 (Button) raises to 60 (+40 increment)
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setupShort.code,
          { "x-seat-token": setupShort.seats[3]!.seatToken },
          { action: "RAISE", amountChips: 60 },
        )
      ).status,
      200,
    );
    // Seat 5 (SB, 70 total) goes All-In for 70 (+10 short all-in < 40 min increment!)
    const shortAllInRes = await submitAction(
      gateway.url,
      setupShort.code,
      { "x-seat-token": setupShort.seats[5]!.seatToken },
      { action: "ALL_IN" },
    );
    assert.equal(shortAllInRes.status, 200);
    const afterShort = (await shortAllInRes.json()) as { hand: HandState };
    assert.equal(afterShort.hand.currentBet, 70);
    assert.equal(afterShort.hand.actingSeatNumber, 1);

    // Seat 1 calls 70 -> returns to Seat 3 (who already acted on the 60 raise; +10 short all-in does NOT reopen raising for Seat 3!)
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setupShort.code,
          { "x-seat-token": setupShort.seats[1]!.seatToken },
          { action: "CALL" },
        )
      ).status,
      200,
    );
    const blockedReopen = await submitAction(
      gateway.url,
      setupShort.code,
      { "x-seat-token": setupShort.seats[3]!.seatToken },
      { action: "RAISE", amountChips: 120 },
    );
    assert.equal(blockedReopen.status, 409);

    // Seat 3 calls 10 -> Flop (Pot = 210)
    const callShort2 = await submitAction(
      gateway.url,
      setupShort.code,
      { "x-seat-token": setupShort.seats[3]!.seatToken },
      { action: "CALL" },
    );
    assert.equal(callShort2.status, 200);
    assert.equal(((await callShort2.json()) as { hand: HandState }).hand.street, "FLOP");

    // 2. Heads-Up All-In unequal stacks + odd-Chip Showdown split (odd Pot=101)
    const setupOdd = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 300, smallBlind: 1, bigBlind: 2 },
      [
        { seatNumber: 2, displayName: "Alice" },
        { seatNumber: 5, displayName: "Bob" },
      ],
    );
    // Drop Alice (Seat 2) from 300 -> 100 in Hand 1 (Bob=500)
    await startHand(gateway.url, setupOdd.code, setupOdd.hostToken);
    await submitAction(gateway.url, setupOdd.code, { "x-seat-token": setupOdd.seats[2]!.seatToken }, { action: "RAISE", amountChips: 200 });
    await submitAction(gateway.url, setupOdd.code, { "x-seat-token": setupOdd.seats[5]!.seatToken }, { action: "CALL" });
    await submitAction(gateway.url, setupOdd.code, { "x-seat-token": setupOdd.seats[5]!.seatToken }, { action: "BET", amountChips: 10 });
    await submitAction(gateway.url, setupOdd.code, { "x-seat-token": setupOdd.seats[2]!.seatToken }, { action: "FOLD" });

    // Play a quick Fold-Win Hand 2 (Button=5 folds -> Seat 2=101, Seat 5=499) -> wait, let's just test uncalled excess from Hand 2 (Button=5, BB=2, 100 vs 500)!
    // Actually on Hand 2 Button=5(499), BB=2(101): Seat 5 calls 2, Seat 2 checks? No: Seat 5 ALL_IN (499), Seat 2 CALL (101)! Uncalled 398 returned!
    const setupOdd3 = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 200, smallBlind: 1, bigBlind: 2 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 3, displayName: "Bob" },
        { seatNumber: 5, displayName: "Carol" },
      ],
    );
    // Button=1, SB=3 (posts 1), BB=5 (posts 2)
    await startHand(gateway.url, setupOdd3.code, setupOdd3.hostToken);
    // Seat 1 raises to 50 -> Seat 3 (SB) folds (1 dead chip!) -> Seat 5 (BB) calls 50 -> Pot = 101!
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setupOdd3.code,
          { "x-seat-token": setupOdd3.seats[1]!.seatToken },
          { action: "RAISE", amountChips: 50 },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setupOdd3.code,
          { "x-seat-token": setupOdd3.seats[3]!.seatToken },
          { action: "FOLD" },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setupOdd3.code,
          { "x-seat-token": setupOdd3.seats[5]!.seatToken },
          { action: "CALL" },
        )
      ).status,
      200,
    );
    // Flop, Turn, River check-down (Seat 5 acts first, then Seat 1)
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        (
          await submitAction(
            gateway.url,
            setupOdd3.code,
            { "x-seat-token": setupOdd3.seats[5]!.seatToken },
            { action: "CHECK" },
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await submitAction(
            gateway.url,
            setupOdd3.code,
            { "x-seat-token": setupOdd3.seats[1]!.seatToken },
            { action: "CHECK" },
          )
        ).status,
        200,
      );
    }

    // Non-Host cannot resolve Showdown
    const unauthShowdown = await fetch(`${gateway.url}/api/sessions/${setupOdd3.code}/hand/showdown`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seat-token": setupOdd3.seats[1]!.seatToken,
      },
      body: JSON.stringify({ winnerSeatNumbers: [1, 5] }),
    });
    assert.equal(unauthShowdown.status, 403);

    // Selecting folded Seat 3 as winner is rejected (400)
    const foldedWinner = await resolveShowdownReq(gateway.url, setupOdd3.code, setupOdd3.hostToken, [3]);
    assert.equal(foldedWinner.status, 400);

    // Split Pot 101 between Seat 1 (Button) and Seat 5 (left of Button):
    // Clockwise left of Button (1) -> Seat 5 gets 51, Seat 1 gets 50!
    const splitRes = await resolveShowdownReq(gateway.url, setupOdd3.code, setupOdd3.hostToken, [1, 5]);
    assert.equal(splitRes.status, 200);
    const split = (await splitRes.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(split.hand.status, "COMPLETE");
    assert.equal(getSeatChips(split.session, 5), 201); // 200 - 50 + 51
    assert.equal(getSeatChips(split.session, 1), 200); // 200 - 50 + 50
    assert.equal(getSeatChips(split.session, 3), 199); // 200 - 1

    // 3. Heads-Up unequal All-In returns uncalled excess (Alice=100, Bob=500, Button=5)
    await startHand(gateway.url, setupOdd.code, setupOdd.hostToken);
    await submitAction(
      gateway.url,
      setupOdd.code,
      { "x-seat-token": setupOdd.seats[5]!.seatToken },
      { action: "ALL_IN" },
    );
    const callAllInRes = await submitAction(
      gateway.url,
      setupOdd.code,
      { "x-seat-token": setupOdd.seats[2]!.seatToken },
      { action: "CALL" },
    );
    assert.equal(callAllInRes.status, 200);
    const allInShowdown = (await callAllInRes.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(allInShowdown.hand.status, "SHOWDOWN");
    assert.equal(allInShowdown.hand.potChips, 200); // Uncalled 400 returned to Seat 5!
    assert.equal(getSeatChips(allInShowdown.session, 5), 400);
    assert.equal(getSeatChips(allInShowdown.session, 2), 0);

    const winShort = await resolveShowdownReq(gateway.url, setupOdd.code, setupOdd.hostToken, [2]);
    assert.equal(winShort.status, 200);
    const afterWinShort = (await winShort.json()) as { session: SessionSnapshot };
    assert.equal(getSeatChips(afterWinShort.session, 2), 200);
    assert.equal(getSeatChips(afterWinShort.session, 5), 400);
  });

  it("persists mid-Hand SQLite state, turn, pot, and Button history across gateway restarts", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 1000 },
        { seatNumber: 3, displayName: "Bob", chips: 1000 },
        { seatNumber: 5, displayName: "Carol", chips: 1000 },
      ],
    );

    await startHand(gateway.url, setup.code, setup.hostToken);
    // Button=1, SB=3, BB=5, UTG/first=1
    // Seat 1 raises to 60, Seat 3 calls 60, Seat 5 calls 60 -> FLOP (Pot 180), Seat 3 acts first
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setup.code,
          { "x-seat-token": setup.seats[1]!.seatToken },
          { action: "RAISE", amountChips: 60 },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setup.code,
          { "x-seat-token": setup.seats[3]!.seatToken },
          { action: "CALL" },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setup.code,
          { "x-seat-token": setup.seats[5]!.seatToken },
          { action: "CALL" },
        )
      ).status,
      200,
    );
    // On Flop, Seat 3 bets 100, Seat 5's turn
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setup.code,
          { "x-seat-token": setup.seats[3]!.seatToken },
          { action: "BET", amountChips: 100 },
        )
      ).status,
      200,
    );

    // Restart server mid-Hand on the same SQLite DB
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    const restoredRes = await fetch(`${gateway.url}/api/sessions/${setup.code}`, {
      headers: { "x-seat-token": setup.seats[5]!.seatToken },
    });
    assert.equal(restoredRes.status, 200);
    const restored = (await restoredRes.json()) as { session: SessionSnapshot };
    assert.equal(restored.session.handInProgress, true);
    assert.equal(restored.session.hand?.street, "FLOP");
    assert.equal(restored.session.hand?.potChips, 180);
    assert.equal(restored.session.hand?.currentBet, 100);
    assert.equal(restored.session.hand?.actingSeatNumber, 5);
    assert.equal(getSeatChips(restored.session, 1), 940);
    assert.equal(getSeatChips(restored.session, 3), 840);
    assert.equal(getSeatChips(restored.session, 5), 940);

    // Continue playing restored Hand via WebSocket subscription + HTTP actions
    const carolWs = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      seatToken: setup.seats[5]!.seatToken,
    });
    assert.equal(carolWs.messages[0]?.session.hand?.actingSeatNumber, 5);

    // Seat 5 folds, Seat 1 folds -> Fold-Win for Seat 3!
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setup.code,
          { "x-seat-token": setup.seats[5]!.seatToken },
          { action: "FOLD" },
        )
      ).status,
      200,
    );
    const foldWinRes = await submitAction(
      gateway.url,
      setup.code,
      { "x-seat-token": setup.seats[1]!.seatToken },
      { action: "FOLD" },
    );
    assert.equal(foldWinRes.status, 200);
    const afterFold = (await foldWinRes.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(afterFold.hand.status, "COMPLETE");
    assert.equal(afterFold.session.handInProgress, false);
    assert.equal(getSeatChips(afterFold.session, 3), 1120); // 1000 + 60 + 60
    assert.equal(getSeatChips(afterFold.session, 1), 940);
    assert.equal(getSeatChips(afterFold.session, 5), 940);

    await waitForCondition(() =>
      carolWs.messages.some((m) => m.session.hand?.status === "COMPLETE" && !m.session.handInProgress),
    );
    carolWs.ws.close();

    // Restart again between Hands and confirm Button rotates from Seat 1 -> Seat 3
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    const hand2Res = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(hand2Res.status, 201);
    const hand2 = (await hand2Res.json()) as { hand: HandState };
    assert.equal(hand2.hand.handNumber, 2);
    assert.equal(hand2.hand.buttonSeatNumber, 3);
  });

  it("handles whole-Chip odd-Chip splits, seated Host proxy vs own Seat, and bust blocking next Hand", async () => {
    // Whole-Chip odd-Chip Showdown split: Pot = 45 split between BTN (Seat 1) and BB (Seat 5) -> 23 to Seat 5, 22 to Seat 1
    const setupStep = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 200, smallBlind: 5, bigBlind: 10 },
      [
        { seatNumber: 1, displayName: "HostSeat" },
        { seatNumber: 3, displayName: "Bob" },
        { seatNumber: 5, displayName: "Carol" },
      ],
    );
    const start1 = (await (await startHand(gateway.url, setupStep.code, setupStep.hostToken)).json()) as {
      hand: HandState;
      session: SessionSnapshot;
    };
    const legalSeat1 = getLegalActions(start1.hand, setupStep.session.config);
    assert.equal(legalSeat1?.toCall, 10);
    assert.equal(legalSeat1?.minRaiseTo, 20);

    // Seated Host submits own action without passing seatNumber -> byHostProxy: false
    const hostOwnRes = await submitAction(
      gateway.url,
      setupStep.code,
      {
        "x-host-token": setupStep.hostToken,
        "x-seat-token": setupStep.seats[1]!.seatToken,
      },
      { action: "RAISE", amountChips: 20 },
    );
    assert.equal(hostOwnRes.status, 200);
    const hostOwn = (await hostOwnRes.json()) as { hand: HandState };
    assert.equal(hostOwn.hand.actionHistory.at(-1)?.byHostProxy, false);

    // Now Seat 3's turn: seated Host omitting seatNumber targets Seat 1 -> 409
    const missingProxySeat = await submitAction(
      gateway.url,
      setupStep.code,
      {
        "x-host-token": setupStep.hostToken,
        "x-seat-token": setupStep.seats[1]!.seatToken,
      },
      { action: "FOLD" },
    );
    assert.equal(missingProxySeat.status, 409);

    // Seated Host explicitly proxies Seat 3 Fold -> byHostProxy: true
    const proxySeat3 = await submitAction(
      gateway.url,
      setupStep.code,
      {
        "x-host-token": setupStep.hostToken,
        "x-seat-token": setupStep.seats[1]!.seatToken,
      },
      { seatNumber: 3, action: "FOLD" },
    );
    assert.equal(proxySeat3.status, 200);
    assert.equal(((await proxySeat3.json()) as { hand: HandState }).hand.actionHistory.at(-1)?.byHostProxy, true);

    // Seat 5 (BB) calls 10 (total 20) -> Pot = 45 (5 + 20 + 20)
    assert.equal(
      (
        await submitAction(
          gateway.url,
          setupStep.code,
          { "x-seat-token": setupStep.seats[5]!.seatToken },
          { action: "CALL" },
        )
      ).status,
      200,
    );
    // Check down Flop, Turn, River (Seat 5 -> Seat 1)
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        (
          await submitAction(
            gateway.url,
            setupStep.code,
            { "x-seat-token": setupStep.seats[5]!.seatToken },
            { action: "CHECK" },
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await submitAction(
            gateway.url,
            setupStep.code,
            { "x-seat-token": setupStep.seats[1]!.seatToken },
            { action: "CHECK" },
          )
        ).status,
        200,
      );
    }

    const splitStepRes = await resolveShowdownReq(gateway.url, setupStep.code, setupStep.hostToken, [1, 5]);
    assert.equal(splitStepRes.status, 200);
    const splitStep = (await splitStepRes.json()) as { hand: HandState; session: SessionSnapshot };
    assert.equal(getSeatChips(splitStep.session, 5), 203); // 200 - 20 + 23
    assert.equal(getSeatChips(splitStep.session, 1), 202); // 200 - 20 + 22
    assert.equal(getSeatChips(splitStep.session, 3), 195); // 200 - 5

    // Bust blocking next Hand in Heads-Up
    const setupBust = await createFundedSession(
      gateway.url,
      { seatCount: 4, startingStackChips: 100, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
      ],
    );
    await startHand(gateway.url, setupBust.code, setupBust.hostToken);
    await submitAction(gateway.url, setupBust.code, { "x-seat-token": setupBust.seats[1]!.seatToken }, { action: "ALL_IN" });
    await submitAction(gateway.url, setupBust.code, { "x-seat-token": setupBust.seats[2]!.seatToken }, { action: "CALL" });
    await resolveShowdownReq(gateway.url, setupBust.code, setupBust.hostToken, [2]);

    // Alice is at 0 Chips -> cannot start Hand 2 with only 1 funded Seat
    const blockedStart = await startHand(gateway.url, setupBust.code, setupBust.hostToken);
    assert.equal(blockedStart.status, 409);
  });
});
