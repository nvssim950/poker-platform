import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";
import {
  getLegalActions,
  getLivePots,
  getTotalPotChips,
  type HandState,
} from "../src/shared/handEngine.ts";
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

async function startHand(gatewayUrl: string, code: string, hostToken: string): Promise<HandState> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/start`, {
    method: "POST",
    headers: { "x-host-token": hostToken },
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { hand: HandState }).hand;
}

async function act(
  gatewayUrl: string,
  code: string,
  seatToken: string,
  body: Record<string, unknown>,
  expectedStatus = 200,
): Promise<{ hand?: HandState; session?: SessionSnapshot; error?: string }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seat-token": seatToken },
    body: JSON.stringify(body),
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
  expectedStatus = 200,
): Promise<{ hand?: HandState; session?: SessionSnapshot; error?: string }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/showdown`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-host-token": hostToken,
    },
    body: JSON.stringify(potId ? { winnerSeatNumbers, potId } : { winnerSeatNumbers }),
  });
  assert.equal(res.status, expectedStatus);
  return (await res.json()) as { hand?: HandState; session?: SessionSnapshot; error?: string };
}

function getSeatChips(session: SessionSnapshot, seatNumber: number): number {
  const occ = session.seats.find((s) => s.seatNumber === seatNumber)?.occupant;
  assert.ok(occ, `Expected Seat ${seatNumber} to be occupied`);
  return occ.chips;
}

describe("All-In Side Pots, Non-Reopening Short All-Ins & Per-Pot Showdown", () => {
  let tmpDir: string;
  let dbPath: string;
  let gateway: SessionGateway;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "poker-side-pots-"));
    dbPath = join(tmpDir, "poker.db");
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);
  });

  after(async () => {
    await gateway.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks raising for prior actors after a short All-In while allowing unacted Seats to raise and reopen action", async () => {
    // 4 players: Seat 1 (BTN, 1000), Seat 2 (SB, 1000), Seat 3 (BB, 160), Seat 4 (UTG, 1000)
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 1000 },
        { seatNumber: 2, displayName: "Bob", chips: 1000 },
        { seatNumber: 3, displayName: "Carol", chips: 160 },
        { seatNumber: 4, displayName: "Dan", chips: 1000 },
      ],
    );

    await startHand(gateway.url, setup.code, setup.hostToken);
    // Preflop: Dan (4), Alice (1), Bob (2) call 20; Carol (3, BB) checks -> Flop (Pot 80, remaining: Alice=980, Bob=980, Carol=140, Dan=980)
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    const flop = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CHECK" })).hand!;
    assert.equal(flop.street, "FLOP");
    assert.equal(flop.actingSeatNumber, 2);

    // Flop: Seat 2 bets 100 -> Seat 3 short All-In for 140 (+40 < 100 min increment!)
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 100 });
    const afterShort = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "ALL_IN" })).hand!;
    assert.equal(afterShort.currentBet, 140);
    assert.equal(afterShort.actingSeatNumber, 4);

    // Seat 4 (Dan) has NOT acted since Seat 2's 100 bet -> CAN still raise (minRaiseTo = 140 + 100 = 240)!
    const legalDan = getLegalActions(afterShort, setup.session.config, 4)!;
    assert.equal(legalDan.canCall, true);
    assert.equal(legalDan.callChips, 140);
    assert.equal(legalDan.canRaise, true);
    assert.equal(legalDan.minRaiseTo, 240);
    assert.equal(legalDan.canAllIn, true);

    // Check live pots right now: Main Pot includes all 4 seats (up to Carol's 160 total), and no Side Pot yet because Dan hasn't put >160
    const liveBeforeDan = getLivePots(afterShort);
    assert.equal(liveBeforeDan.length, 1);
    assert.equal(liveBeforeDan[0]!.amountChips, 80 + 100 + 140);

    // Subcase A: Dan calls 140, Seat 1 folds -> action returns to Seat 2 (Bob), who ALREADY acted on the 100 bet!
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    const afterFold1 = (await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" })).hand!;
    assert.equal(afterFold1.actingSeatNumber, 2);

    const legalBobLocked = getLegalActions(afterFold1, setup.session.config, 2)!;
    assert.equal(legalBobLocked.canFold, true);
    assert.equal(legalBobLocked.canCall, true);
    assert.equal(legalBobLocked.callChips, 40);
    assert.equal(legalBobLocked.canRaise, false);
    assert.equal(legalBobLocked.canAllIn, false);

    // Seat 2 attempting RAISE or ALL_IN is rejected with 409!
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "RAISE", amountChips: 240 }, 409);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "ALL_IN" }, 409);

    // Seat 2 calls 40 -> Turn (Pot = 500, Carol all-in at 160, Bob & Dan at 160)
    const turn = (await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(turn.street, "TURN");

    // Finish hand cleanly so we can run Hand 2 for the full-raise reopen branch!
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CHECK" });
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [4]);

    // Hand 2: Button rotated to Seat 2 (SB=4, BB=1, UTG=2) -> fold quickly so Seat 3 can Rebuy
    const hand2 = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(hand2.seats.length, 3);
    assert.equal(hand2.buttonSeatNumber, 2);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "FOLD" });

    // Rebuy Carol (Seat 3) for 160 Chips
    const rebuyRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/3/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": setup.hostToken },
      body: JSON.stringify({ kind: "REBUY", amountChips: 160 }),
    });
    assert.equal(rebuyRes.status, 201);

    const hand3 = await startHand(gateway.url, setup.code, setup.hostToken);
    // Button=3, SB=4, BB=1, UTG=2
    assert.equal(hand3.buttonSeatNumber, 3);
    // Preflop: UTG(2) calls 20, BTN(3, Carol=160) calls 20, SB(4) calls 10, BB(1) checks -> Flop!
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    const flop3 = (await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" })).hand!;
    assert.equal(flop3.street, "FLOP");
    assert.equal(flop3.actingSeatNumber, 4);

    // Flop: Seat 4 bets 100 -> Seat 1 calls 100 -> Seat 2 folds -> Seat 3 (Carol, 140 left) goes All-In for 140 (+40 short)
    // Wait: let's have Seat 4 bet 100, Seat 1 fold, Seat 2 call 100... no, to have an unacted Seat AFTER Carol(3), put Seat 4 bet 100, Seat 1 check? No, Seat 4 acts first:
    // Seat 4 bets 100 -> Seat 1 calls 100 -> Seat 2 calls 100 -> Seat 3 (BTN, last to act) is short! Then everyone already acted so nobody left to reopen!
    // Wait: to test unacted Seat reopening: Seat 4 bets 100, Seat 1 folds? No, Seat 1 calls 100, Seat 2 is AFTER Seat 3? No, order is 4, 1, 2, 3!
    // So if Seat 4 bets 100, Seat 1 (BB) calls 100, Seat 2 checks? No: Seat 4 acts, Seat 1 acts, Seat 2 acts, Seat 3 acts!
    // Wait: make Seat 3 (Carol) act BEFORE Seat 2! Order is 4 -> 1 -> 2 -> 3.
    // So Seat 4 checks! Seat 1 bets 100! Seat 2 calls 100! Seat 3 (Carol) short All-In 140!
    // Now Seat 4 (who checked BEFORE Seat 1's 100 bet!) has NOT acted since Seat 1's 100 bet (`hasActedSinceFullRaise = false`)!
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "BET", amountChips: 100 });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    const afterCarolShort = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "ALL_IN" })).hand!;
    assert.equal(afterCarolShort.actingSeatNumber, 4);

    // Seat 4 (Dan) has NOT acted since Seat 1's 100 bet -> raises to 240 (+100 full raise over 140)!
    const legalDanReopen = getLegalActions(afterCarolShort, setup.session.config, 4)!;
    assert.equal(legalDanReopen.canRaise, true);
    assert.equal(legalDanReopen.minRaiseTo, 240);
    const afterDanFullRaise = (
      await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "RAISE", amountChips: 240 })
    ).hand!;

    // Now Seat 1 (Alice) and Seat 2 (Bob) ARE reopened and can re-raise (minRaiseTo = 340)!
    assert.equal(afterDanFullRaise.actingSeatNumber, 1);
    const legalAliceReopened = getLegalActions(afterDanFullRaise, setup.session.config, 1)!;
    assert.equal(legalAliceReopened.canRaise, true);
    assert.equal(legalAliceReopened.minRaiseTo, 340);
    assert.equal(legalAliceReopened.canAllIn, true);
  });

  it("tracks lastFullRaiseBet across consecutive short All-Ins (cumulative below vs reaching threshold)", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 1000 },
        { seatNumber: 2, displayName: "Bob", chips: 1000 },
        { seatNumber: 3, displayName: "Carol", chips: 155 }, // 20 preflop + 135 on flop
        { seatNumber: 4, displayName: "Dan", chips: 195 },   // 20 preflop + 175 on flop
      ],
    );

    await startHand(gateway.url, setup.code, setup.hostToken);
    // Button=1, SB=2, BB=3, UTG=4
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CHECK" });

    // Flop order: 2 -> 3 -> 4 -> 1
    // Seat 2 bets 100 (lastFullRaiseBet = 100, increment = 100, threshold = 200)
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 100 });
    // Seat 3 short All-In for 135 (+35, total 135 < 200)
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "ALL_IN" });
    // Seat 4 short All-In for 175 (+40 over 135, cumulative +75 < 100, total 175 < 200)
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "ALL_IN" });
    // Seat 1 calls 175 -> returns to Seat 2 (who already acted at 100!)
    const backToBob = (await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(backToBob.actingSeatNumber, 2);

    // Two consecutive short All-Ins totaling 175 (< 200) must NOT reopen raising for Seat 2!
    const legalBobStillLocked = getLegalActions(backToBob, setup.session.config, 2)!;
    assert.equal(legalBobStillLocked.canRaise, false);
    assert.equal(legalBobStillLocked.canAllIn, false);
    assert.equal(legalBobStillLocked.callChips, 75);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "RAISE", amountChips: 275 }, 409);

    // Call to finish Hand 1 (Turn/River order left of Button 1: Seat 2 -> Seat 1)
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" });
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1]);

    // Hand 2: two consecutive short All-Ins whose CUMULATIVE total REACHES lastFullRaiseBet + lastFullRaiseIncrement!
    const setup2 = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 1000 },
        { seatNumber: 2, displayName: "Bob", chips: 1000 },
        { seatNumber: 3, displayName: "Carol", chips: 180 }, // 20 pre + 160 flop (+60)
        { seatNumber: 4, displayName: "Dan", chips: 235 },   // 20 pre + 215 flop (+55 over 160, cumulative +115 >= 100!)
      ],
    );
    await startHand(gateway.url, setup2.code, setup2.hostToken);
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup2.code, setup2.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "CHECK" });

    // Flop: Seat 2 bets 100
    await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "BET", amountChips: 100 });
    // Seat 3 short All-In 160 (+60)
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "ALL_IN" });
    // Seat 4 short All-In 215 (+55 < 100 over 160, BUT 215 >= 100 + 100 = 200!)
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "ALL_IN" });
    // Seat 1 calls 215 -> returns to Seat 2
    const reopenedBob = (await act(gateway.url, setup2.code, setup2.seats[1]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(reopenedBob.actingSeatNumber, 2);

    // Raising MUST be reopened for Seat 2! (minRaiseTo = 215 + 100 = 315)
    const legalBobReopened = getLegalActions(reopenedBob, setup2.session.config, 2)!;
    assert.equal(legalBobReopened.canRaise, true);
    assert.equal(legalBobReopened.minRaiseTo, 315);
    assert.equal(legalBobReopened.canAllIn, true);

    const bobReraise = (
      await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "RAISE", amountChips: 315 })
    ).hand!;
    assert.equal(bobReraise.currentBet, 315);
  });

  it("partitions 3+ tier Side Pots with folded dead Chips, syncs live pots, enforces eligibility, and splits odd Chips left of Button per Pot", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 100 }, // Tier 1 cap: 100
        { seatNumber: 2, displayName: "Bob", chips: 250 },   // Tier 2 cap: 250
        { seatNumber: 3, displayName: "Carol", chips: 500 }, // Folds on Flop after 180 total dead chips
        { seatNumber: 4, displayName: "Dan", chips: 500 },   // Tier 3 contender: 355 total
        { seatNumber: 5, displayName: "Eve", chips: 500 },   // Tier 3 contender: 355 total
        { seatNumber: 6, displayName: "Frank", chips: 500 }, // Folds Preflop after 60 dead chips
      ],
    );

    const wsSub = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      hostToken: setup.hostToken,
    });

    await startHand(gateway.url, setup.code, setup.hostToken);
    // Button=1, SB=2(10), BB=3(20), UTG=4
    // Preflop: Dan(4) raises to 60 -> Eve(5) calls 60 -> Frank(6) calls 60 -> Alice(1, 100) ALL_IN ->
    // Bob(2) calls 90 (total 100) -> Carol(3) calls 80 (total 100) -> Dan(4) calls 40 (total 100) ->
    // Eve(5) calls 40 (total 100) -> Frank(6) FOLDS (60 dead chips!)
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "RAISE", amountChips: 60 });
    await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[6]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "ALL_IN" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "CALL" });
    const flop = (await act(gateway.url, setup.code, setup.seats[6]!.seatToken, { action: "FOLD" })).hand!;
    assert.equal(flop.street, "FLOP");
    assert.equal(flop.potChips, 560); // 100*5 + 60 dead
    assert.equal(flop.actingSeatNumber, 2);

    // Flop: Bob(2, 150 left) bets 80 (total 180) -> Carol(3) calls 80 (total 180) ->
    // Dan(4) raises to 255 (total 355) -> Eve(5) calls 255 (total 355) ->
    // Bob(2) calls 70 ALL_IN (total 250) -> Carol(3) FOLDS (180 dead chips!) -> Turn!
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 80 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "RAISE", amountChips: 255 });
    const midFlop = (await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "CALL" })).hand!;

    // Verify live pots during BETTING right before Bob calls all-in and Carol folds:
    // Main Pot (cap 100): 560 ([1, 2, 3, 4, 5])
    // Side Pot 1 (cap 355, since Bob isn't all-in yet): 80(Bob)+80(Carol)+255(Dan)+255(Eve) = 670 ([2, 3, 4, 5])
    const liveMidFlop = getLivePots(midFlop);
    assert.equal(liveMidFlop.length, 2);
    assert.equal(liveMidFlop[0]!.label, "Main Pot");
    assert.equal(liveMidFlop[0]!.amountChips, 560);
    assert.equal(
      liveMidFlop.reduce((s, p) => s + p.amountChips, 0),
      getTotalPotChips(midFlop),
    );

    const bobAllIn = (await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "ALL_IN" })).hand!;
    // Now Bob IS all-in at 250! Live pots during BETTING now show 3 tiers!
    const liveAfterBobAllIn = getLivePots(bobAllIn);
    assert.equal(liveAfterBobAllIn.length, 3);
    assert.deepEqual(
      liveAfterBobAllIn.map((p) => ({ label: p.label, amount: p.amountChips })),
      [
        { label: "Main Pot", amount: 560 },
        { label: "Side Pot 1", amount: 530 }, // 150(Bob) + 80(Carol) + 150(Dan) + 150(Eve)
        { label: "Side Pot 2", amount: 210 }, // 105(Dan) + 105(Eve)
      ],
    );

    // Carol folds -> Turn (only Dan and Eve left with chips)
    const turn = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" })).hand!;
    assert.equal(turn.street, "TURN");

    // Check down Turn & River -> SHOWDOWN!
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CHECK" });
    const showdown = (await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "CHECK" })).hand!;

    assert.equal(showdown.status, "SHOWDOWN");
    assert.equal(showdown.pots.length, 3);
    assert.deepEqual(showdown.pots, [
      {
        id: "main",
        label: "Main Pot",
        amountChips: 560,
        eligibleSeatNumbers: [1, 2, 4, 5],
        winnerSeatNumbers: null,
      },
      {
        id: "side-1",
        label: "Side Pot 1",
        amountChips: 530,
        eligibleSeatNumbers: [2, 4, 5],
        winnerSeatNumbers: null,
      },
      {
        id: "side-2",
        label: "Side Pot 2",
        amountChips: 210,
        eligibleSeatNumbers: [4, 5],
        winnerSeatNumbers: null,
      },
    ]);

    // WebSocket broadcast delivered 3-tier Showdown pots
    await waitForCondition(() =>
      wsSub.messages.some((m) => m.session.hand?.status === "SHOWDOWN" && m.session.hand.pots.length === 3),
    );

    // Non-Host cannot resolve Showdown
    const unauthRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/hand/showdown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": setup.seats[1]!.seatToken },
      body: JSON.stringify({ potId: "main", winnerSeatNumbers: [1] }),
    });
    assert.equal(unauthRes.status, 403);

    // Folded seats (3 or 6) and ineligible seats (1 for side-1/side-2, 2 for side-2) are rejected (400)
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [3], "main", 400);
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [6], "main", 400);
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1], "side-1", 400);
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [2], "side-2", 400);

    // Resolve Side Pot 1 FIRST (530 Chips split 3 ways among [2, 4, 5], Button = 1):
    // 530 / 5 = 106 units; 106 / 3 = 35 units (175) remainder 1 unit (5)!
    // Clockwise left of Button (1): Seat 2 (offset 1) gets 180, Seat 4 (offset 3) gets 175, Seat 5 (offset 4) gets 175!
    const afterSide1 = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [5, 4, 2], "side-1");
    assert.equal(afterSide1.hand!.status, "SHOWDOWN");
    assert.equal(afterSide1.hand!.potChips, 770); // 560 + 210 remaining
    assert.equal(getSeatChips(afterSide1.session!, 2), 180);
    assert.equal(getSeatChips(afterSide1.session!, 4), 145 + 175);
    assert.equal(getSeatChips(afterSide1.session!, 5), 145 + 175);

    // Resolving already-resolved side-1 again is rejected (409)
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [2], "side-1", 409);

    // Restart gateway mid-Showdown to verify partial Showdown resolution persists in SQLite!
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    // Resolve Main Pot (560 Chips split 3 ways among [1, 4, 5], Button = 1):
    // 560 / 5 = 112 units; 112 / 3 = 37 units (185) remainder 1 unit (5)!
    // Clockwise left of Button (1): Seat 4 (offset 3) gets 190, Seat 5 (offset 4) gets 185, Seat 1 (Button, offset 6) gets 185!
    const afterMain = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1, 5, 4], "main");
    assert.equal(afterMain.hand!.status, "SHOWDOWN");
    assert.equal(afterMain.hand!.potChips, 210);
    assert.equal(getSeatChips(afterMain.session!, 1), 185);
    assert.equal(getSeatChips(afterMain.session!, 4), 320 + 190);
    assert.equal(getSeatChips(afterMain.session!, 5), 320 + 185);

    // Resolve Side Pot 2 (210 Chips split 2 ways? Let's award outright to Seat 5 to test distinct winners per pot!)
    const afterSide2 = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [5], "side-2");
    assert.equal(afterSide2.hand!.status, "COMPLETE");
    assert.equal(afterSide2.session!.handInProgress, false);
    assert.equal(afterSide2.hand!.potChips, 0);
    assert.equal(afterSide2.hand!.result?.totalPotChips, 1300);

    // Verify ending stacks, ordered per-Pot odd-Chip awards, and 100% chip conservation: initial total = 100 + 250 + 500*4 = 2350
    const finalSession = afterSide2.session!;
    assert.deepEqual(
      afterSide2.hand!.result?.awards.map((a) => ({
        potId: a.potId,
        seatNumber: a.seatNumber,
        amountChips: a.amountChips,
        oddChips: a.oddChips,
      })),
      [
        { potId: "main", seatNumber: 4, amountChips: 190, oddChips: 5 },
        { potId: "main", seatNumber: 5, amountChips: 185, oddChips: 0 },
        { potId: "main", seatNumber: 1, amountChips: 185, oddChips: 0 },
        { potId: "side-1", seatNumber: 2, amountChips: 180, oddChips: 5 },
        { potId: "side-1", seatNumber: 4, amountChips: 175, oddChips: 0 },
        { potId: "side-1", seatNumber: 5, amountChips: 175, oddChips: 0 },
        { potId: "side-2", seatNumber: 5, amountChips: 210, oddChips: 0 },
      ],
    );
    assert.deepEqual(
      getLivePots(afterSide2.hand!).map((p) => p.winnerSeatNumbers),
      [[4, 5, 1], [2, 4, 5], [5]],
    );
    assert.equal(getSeatChips(finalSession, 1), 185);
    assert.equal(getSeatChips(finalSession, 2), 180);
    assert.equal(getSeatChips(finalSession, 3), 320); // 500 - 180 dead
    assert.equal(getSeatChips(finalSession, 4), 510); // 145 + 175 + 190
    assert.equal(getSeatChips(finalSession, 5), 715); // 145 + 175 + 185 + 210
    assert.equal(getSeatChips(finalSession, 6), 440); // 500 - 60 dead
    const totalChips = [1, 2, 3, 4, 5, 6].reduce((sum, n) => sum + getSeatChips(finalSession, n), 0);
    assert.equal(totalChips, 2350);

    wsSub.ws.close();
  });

  it("handles postflop short open All-In below Big Blind without reopening prior checkers, and reopens when a full open occurs", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 30 },  // 10 left on flop (< bigBlind 20!)
        { seatNumber: 3, displayName: "Carol", chips: 500 },
      ],
    );

    await startHand(gateway.url, setup.code, setup.hostToken);
    // Button=1, SB=2, BB=3 -> Preflop: Alice(1) calls 20, Bob(2) calls 10, Carol(3) checks -> Flop
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CHECK" });

    // Flop order: 2 -> 3 -> 1. Let's make Seat 3 check first by having Seat 2 short-shove after Seat 3? Wait: Seat 2 acts first!
    // Actually: order is 2, 3, 1. Put Seat 2 after Seat 3! Or let Seat 1 check? No, on Flop: 2 checks? No, if Bob(2) has 10 chips, Bob can't bet 10 after Seat 3 checks unless order puts Bob after a checker!
    // Wait: let's start Hand 2 or fold Hand 1 so Button rotates to Seat 2 (then Flop order is 3 -> 1 -> 2, wait: Button=2, SB=3, BB=1 -> Flop order is 3 -> 1 -> 2)!
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" });
    // Turn & River check down
    for (let i = 0; i < 6; i += 1) {
      const seatNum = i % 3 === 0 ? 2 : i % 3 === 1 ? 3 : 1;
      await act(gateway.url, setup.code, setup.seats[seatNum]!.seatToken, { action: "CHECK" });
    }
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1]);

    // Top-Up Bob(2) to 30? Wait: Bob has 10 left! Top-Up +20 = 30!
    const topUpBob = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/2/ledger`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": setup.hostToken },
      body: JSON.stringify({ kind: "TOP_UP", amountChips: 20 }),
    });
    assert.equal(topUpBob.status, 201);

    // Hand 2: Button=2, SB=3, BB=1 -> Preflop order: 2 -> 3 -> 1
    const hand2 = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(hand2.buttonSeatNumber, 2);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    const flop2 = (await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" })).hand!;
    assert.equal(flop2.street, "FLOP");
    assert.equal(flop2.actingSeatNumber, 3); // Order: 3 -> 1 -> 2!

    // Seat 3 checks, Seat 1 checks, Seat 2 (Bob, 10 left < BB 20) goes short open ALL_IN for 10!
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" });
    const afterShortOpen = (await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "ALL_IN" })).hand!;
    assert.equal(afterShortOpen.currentBet, 10);
    assert.equal(afterShortOpen.actingSeatNumber, 3);

    // Seat 3 already checked and faces 10 (< BB 20) -> raising is NOT reopened! Only Fold or Call 10!
    const legalCarolLocked = getLegalActions(afterShortOpen, setup.session.config, 3)!;
    assert.equal(legalCarolLocked.canCall, true);
    assert.equal(legalCarolLocked.callChips, 10);
    assert.equal(legalCarolLocked.canRaise, false);
    assert.equal(legalCarolLocked.canAllIn, false);
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "RAISE", amountChips: 30 }, 409);

    // Seat 3 calls 10 -> Seat 1 (also checked earlier) is ALSO locked (Fold or Call 10 only)!
    const backToAlice = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(backToAlice.actingSeatNumber, 1);
    const legalAliceLocked = getLegalActions(backToAlice, setup.session.config, 1)!;
    assert.equal(legalAliceLocked.canRaise, false);
    assert.equal(legalAliceLocked.canAllIn, false);
    assert.equal(legalAliceLocked.callChips, 10);
  });

  it("auto-awards any Showdown Pot with only one eligible Seat immediately and still allows resolving contested Pots", async () => {
    // Seat 1 (Alice, BTN, 500), Seat 2 (Bob, SB, 500), Seat 3 (Carol, BB, 50)
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5 },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 50 },
      ],
    );

    await startHand(gateway.url, setup.code, setup.hostToken);
    // Preflop: Alice(1) raises to 50 -> Bob(2) calls 40 -> Carol(3, 50 total) calls 30 ALL_IN -> Flop (150 in pot)
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "RAISE", amountChips: 50 });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    const flop = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(flop.street, "FLOP");

    // Flop: Bob(2) bets 100 -> Alice(1) calls 100 -> Turn (Bob=350 left, Alice=350 left, Carol=0 all-in)
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 100 });
    const turn = (await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(turn.street, "TURN");

    // Turn: Bob(2) bets 100 -> Alice(1) FOLDS!
    // Uncalled 100 returned to Bob; Main Pot = 150 ([2, 3]), Side Pot 1 = 200 ([2] ONLY -> auto-awarded to Bob immediately!)
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 100 });
    const afterFold = await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });

    const showdown = afterFold.hand!;
    const sessionAtShowdown = afterFold.session!;
    assert.equal(showdown.status, "SHOWDOWN");
    assert.equal(showdown.lastUncalledReturned?.seatNumber, 2);
    assert.equal(showdown.lastUncalledReturned?.amountChips, 100);
    assert.equal(showdown.pots.length, 2);

    // Main Pot is unresolved, eligible [2, 3]
    assert.deepEqual(showdown.pots[0], {
      id: "main",
      label: "Main Pot",
      amountChips: 150,
      eligibleSeatNumbers: [2, 3],
      winnerSeatNumbers: null,
    });
    // Side Pot 1 had single eligible Seat 2 -> auto-awarded!
    assert.deepEqual(showdown.pots[1], {
      id: "side-1",
      label: "Side Pot 1",
      amountChips: 200,
      eligibleSeatNumbers: [2],
      winnerSeatNumbers: [2],
    });
    assert.equal(showdown.potChips, 150); // Only Main Pot remains unresolved
    assert.equal(getSeatChips(sessionAtShowdown, 2), 550); // 500 - 150 + 200 auto-awarded!
    assert.ok(
      showdown.result?.awards.some(
        (a) => a.potId === "side-1" && a.seatNumber === 2 && a.amountChips === 200,
      ),
    );

    // Host resolves Main Pot -> Carol (Seat 3) wins Main Pot (150)!
    const completed = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [3], "main");
    assert.equal(completed.hand!.status, "COMPLETE");
    assert.equal(completed.session!.handInProgress, false);
    assert.equal(completed.hand!.potChips, 0);
    assert.equal(completed.hand!.result?.totalPotChips, 350);
    assert.equal(completed.hand!.result?.awards.length, 2);
    assert.equal(getSeatChips(completed.session!, 1), 350);
    assert.equal(getSeatChips(completed.session!, 2), 550);
    assert.equal(getSeatChips(completed.session!, 3), 150);
  });
});
