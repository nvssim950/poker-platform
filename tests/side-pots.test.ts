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
  players: Array<{ seatNumber: number; displayName: string }> = [],
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
      startingStackChips: 1000,
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
    // 4 players starting at 1000: drop Carol (Seat 3) to 160 by Hand 4 (Button=4)
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 1000, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
        { seatNumber: 4, displayName: "Dan" },
      ],
    );

    // Hand 1 (Button=1): trim Carol (Seat 3) by 830 -> 170
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "RAISE", amountChips: 830 });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });

    // Hand 2 (Button=2, SB=3): fold around -> Carol loses 10 SB -> 160
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });

    // Hand 3 (Button=3, SB=4, BB=1): fold around -> Button advances to Seat 4 (Carol unaffected!)
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "FOLD" });

    // Hand 4 (Button=4, SB=1, BB=2, UTG=3): Carol has 160!
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" });
    const flop = (await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CHECK" })).hand!;
    assert.equal(flop.street, "FLOP");
    assert.equal(flop.actingSeatNumber, 1);

    // Flop (1 -> 2 -> 3 -> 4): Seat 1 checks, Seat 2 bets 100 -> Seat 3 short All-In for 140 (+40 < 100 min increment!)
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 100 });
    const afterShort = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "ALL_IN" })).hand!;
    assert.equal(afterShort.currentBet, 140);
    assert.equal(afterShort.actingSeatNumber, 4);

    // Seat 4 (Dan) has NOT acted since Seat 2's 100 bet -> CAN still raise (minRaiseTo = 240)!
    const legalDan = getLegalActions(afterShort, setup.session.config, 4)!;
    assert.equal(legalDan.canCall, true);
    assert.equal(legalDan.callChips, 140);
    assert.equal(legalDan.canRaise, true);
    assert.equal(legalDan.minRaiseTo, 240);
    assert.equal(legalDan.canAllIn, true);

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

    // Seat 2 calls 40 -> Turn
    const turn = (await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(turn.street, "TURN");

    // Subcase B: fresh session to verify unacted Seat raising after short All-In reopens action for prior actors
    const reopenSetup = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 1000, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
        { seatNumber: 4, displayName: "Dan" },
      ],
    );
    await startHand(gateway.url, reopenSetup.code, reopenSetup.hostToken);
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[4]!.seatToken, { action: "FOLD" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[1]!.seatToken, { action: "RAISE", amountChips: 830 });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[3]!.seatToken, { action: "CHECK" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[1]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[3]!.seatToken, { action: "FOLD" });
    await startHand(gateway.url, reopenSetup.code, reopenSetup.hostToken);
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[3]!.seatToken, { action: "FOLD" });
    await startHand(gateway.url, reopenSetup.code, reopenSetup.hostToken);
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[3]!.seatToken, { action: "FOLD" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[4]!.seatToken, { action: "FOLD" });

    // Hand 4 (Button=4): Flop order 1 -> 2 -> 3 -> 4; Seat 1 bets 100, Seat 2 calls 100, Seat 3 short All-In 140
    await startHand(gateway.url, reopenSetup.code, reopenSetup.hostToken);
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[2]!.seatToken, { action: "CHECK" });

    await act(gateway.url, reopenSetup.code, reopenSetup.seats[1]!.seatToken, { action: "BET", amountChips: 100 });
    await act(gateway.url, reopenSetup.code, reopenSetup.seats[2]!.seatToken, { action: "CALL" });
    const afterCarolShort = (await act(gateway.url, reopenSetup.code, reopenSetup.seats[3]!.seatToken, { action: "ALL_IN" })).hand!;
    assert.equal(afterCarolShort.actingSeatNumber, 4);

    // Seat 4 raises to 240 (+100 full raise over 140) -> reopens Seat 1 and Seat 2!
    const afterDanFullRaise = (
      await act(gateway.url, reopenSetup.code, reopenSetup.seats[4]!.seatToken, { action: "RAISE", amountChips: 240 })
    ).hand!;
    assert.equal(afterDanFullRaise.actingSeatNumber, 1);
    const legalAliceReopened = getLegalActions(afterDanFullRaise, reopenSetup.session.config, 1)!;
    assert.equal(legalAliceReopened.canRaise, true);
    assert.equal(legalAliceReopened.minRaiseTo, 340);
    assert.equal(legalAliceReopened.canAllIn, true);
  });

  it("tracks lastFullRaiseBet across consecutive short All-Ins (cumulative below vs reaching threshold)", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 1000, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
        { seatNumber: 4, displayName: "Dan" },
      ],
    );

    // Hand 1 (Button=1): Carol(3) loses 835 -> 165
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "RAISE", amountChips: 835 });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });

    // Hand 2 (Button=2, SB=3, BB=4): Carol(3) folds SB (-10 -> 155), Dan(4) loses 795 -> 205
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "RAISE", amountChips: 795 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "FOLD" });

    // Hand 3 (Button=3, SB=4): Dan(4) folds SB (-10 -> 195); Button advances to Seat 4!
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "FOLD" });

    // Hand 4 (Button=4, SB=1, BB=2, UTG=3): Carol=155, Dan=195
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CHECK" });

    // Flop order: 1 -> 2 -> 3 -> 4
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 100 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "ALL_IN" }); // 135 (+35)
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "ALL_IN" }); // 175 (+40, cumulative +75 < 100!)
    const backToBob = (await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(backToBob.actingSeatNumber, 2);

    const legalBobStillLocked = getLegalActions(backToBob, setup.session.config, 2)!;
    assert.equal(legalBobStillLocked.canRaise, false);
    assert.equal(legalBobStillLocked.canAllIn, false);
    assert.equal(legalBobStillLocked.callChips, 75);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "RAISE", amountChips: 275 }, 409);

    // Part 2: two consecutive short All-Ins whose cumulative total reaches threshold (180 + 235)
    const setup2 = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 1000, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
        { seatNumber: 4, displayName: "Dan" },
      ],
    );
    // Hand 1: Carol loses 810 -> 190
    await startHand(gateway.url, setup2.code, setup2.hostToken);
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup2.code, setup2.seats[1]!.seatToken, { action: "RAISE", amountChips: 810 });
    await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup2.code, setup2.seats[1]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "FOLD" });

    // Hand 2: Carol folds SB -> 180; Dan loses 755 -> 245
    await startHand(gateway.url, setup2.code, setup2.hostToken);
    await act(gateway.url, setup2.code, setup2.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "RAISE", amountChips: 755 });
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "FOLD" });

    // Hand 3: Dan folds SB -> 235; Button=4
    await startHand(gateway.url, setup2.code, setup2.hostToken);
    await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "FOLD" });

    await startHand(gateway.url, setup2.code, setup2.hostToken);
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup2.code, setup2.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "CHECK" });

    await act(gateway.url, setup2.code, setup2.seats[1]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup2.code, setup2.seats[2]!.seatToken, { action: "BET", amountChips: 100 });
    await act(gateway.url, setup2.code, setup2.seats[3]!.seatToken, { action: "ALL_IN" }); // 160 (+60)
    await act(gateway.url, setup2.code, setup2.seats[4]!.seatToken, { action: "ALL_IN" }); // 215 (+55, cumulative >= 200!)
    const reopenedBob = (await act(gateway.url, setup2.code, setup2.seats[1]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(reopenedBob.actingSeatNumber, 2);

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
      { seatCount: 6, startingStackChips: 600, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
        { seatNumber: 4, displayName: "Dan" },
        { seatNumber: 5, displayName: "Eve" },
        { seatNumber: 6, displayName: "Frank" },
      ],
    );

    // Hand 1 (Button=1): Alice(1) loses 500 -> 100
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "RAISE", amountChips: 500 });
    await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[6]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });

    // Hand 2 (Button=2, SB=3, BB=4, UTG=5): Bob(2) lost 10 SB in Hand 1 (590 left), so loses 340 -> 250
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "RAISE", amountChips: 340 });
    await act(gateway.url, setup.code, setup.seats[6]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });

    const wsSub = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      hostToken: setup.hostToken,
    });

    // Hand 3 (Button=3, SB=4, BB=5, UTG=6): Alice=100, Bob=250, others >= 570
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[6]!.seatToken, { action: "RAISE", amountChips: 60 });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "ALL_IN" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "CALL" });
    const flop = (await act(gateway.url, setup.code, setup.seats[6]!.seatToken, { action: "FOLD" })).hand!;
    assert.equal(flop.street, "FLOP");
    assert.equal(flop.potChips, 560); // 100*5 + 60 dead
    assert.equal(flop.actingSeatNumber, 4);

    // Flop order (4 -> 5 -> 2 -> 3): 4 & 5 check, Bob(2) bets 80, Carol(3) calls 80, Dan(4) raises to 255, Eve(5) calls 255
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 80 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "RAISE", amountChips: 255 });
    const midFlop = (await act(gateway.url, setup.code, setup.seats[5]!.seatToken, { action: "CALL" })).hand!;

    const liveMidFlop = getLivePots(midFlop);
    assert.equal(liveMidFlop.length, 2);
    assert.equal(liveMidFlop[0]!.label, "Main Pot");
    assert.equal(liveMidFlop[0]!.amountChips, 560);
    assert.equal(
      liveMidFlop.reduce((s, p) => s + p.amountChips, 0),
      getTotalPotChips(midFlop),
    );

    const bobAllIn = (await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "ALL_IN" })).hand!;
    const liveAfterBobAllIn = getLivePots(bobAllIn);
    assert.equal(liveAfterBobAllIn.length, 3);
    assert.deepEqual(
      liveAfterBobAllIn.map((p) => ({ label: p.label, amount: p.amountChips })),
      [
        { label: "Main Pot", amount: 560 },
        { label: "Side Pot 1", amount: 530 },
        { label: "Side Pot 2", amount: 210 },
      ],
    );

    const turn = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" })).hand!;
    assert.equal(turn.street, "TURN");

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

    await waitForCondition(() =>
      wsSub.messages.some((m) => m.session.hand?.status === "SHOWDOWN" && m.session.hand.pots.length === 3),
    );

    const unauthRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/hand/showdown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": setup.seats[1]!.seatToken },
      body: JSON.stringify({ potId: "main", winnerSeatNumbers: [1] }),
    });
    assert.equal(unauthRes.status, 403);

    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [3], "main", 400);
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [6], "main", 400);
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1], "side-1", 400);
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [2], "side-2", 400);

    // Side Pot 1 (530 Chips) split 3 ways among [2, 4, 5], Button = 3 -> 4 gets 177, 5 gets 177, 2 gets 176
    const afterSide1 = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [5, 4, 2], "side-1");
    assert.equal(afterSide1.hand!.status, "SHOWDOWN");
    assert.equal(afterSide1.hand!.potChips, 770);
    assert.equal(getSeatChips(afterSide1.session!, 2), 176);

    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [2], "side-1", 409);

    // Restart gateway mid-Showdown
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    // Main Pot (560 Chips) split 3 ways among [1, 4, 5], Button = 3 -> 4 gets 187, 5 gets 187, 1 gets 186
    const afterMain = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1, 5, 4], "main");
    assert.equal(afterMain.hand!.status, "SHOWDOWN");
    assert.equal(afterMain.hand!.potChips, 210);
    assert.equal(getSeatChips(afterMain.session!, 1), 186);

    const afterSide2 = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [5], "side-2");
    assert.equal(afterSide2.hand!.status, "COMPLETE");
    assert.equal(afterSide2.session!.handInProgress, false);
    assert.equal(afterSide2.hand!.potChips, 0);
    assert.equal(afterSide2.hand!.result?.totalPotChips, 1300);

    const finalSession = afterSide2.session!;
    assert.deepEqual(
      afterSide2.hand!.result?.awards.map((a) => ({
        potId: a.potId,
        seatNumber: a.seatNumber,
        amountChips: a.amountChips,
        oddChips: a.oddChips,
      })),
      [
        { potId: "main", seatNumber: 4, amountChips: 187, oddChips: 1 },
        { potId: "main", seatNumber: 5, amountChips: 187, oddChips: 1 },
        { potId: "main", seatNumber: 1, amountChips: 186, oddChips: 0 },
        { potId: "side-1", seatNumber: 4, amountChips: 177, oddChips: 1 },
        { potId: "side-1", seatNumber: 5, amountChips: 177, oddChips: 1 },
        { potId: "side-1", seatNumber: 2, amountChips: 176, oddChips: 0 },
        { potId: "side-2", seatNumber: 5, amountChips: 210, oddChips: 0 },
      ],
    );
    const totalChips = [1, 2, 3, 4, 5, 6].reduce((sum, n) => sum + getSeatChips(finalSession, n), 0);
    assert.equal(totalChips, 3600);

    wsSub.ws.close();
  });

  it("handles postflop short open All-In below Big Blind without reopening prior checkers, and reopens when a full open occurs", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 500, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
      ],
    );

    // Hand 1 (Button=1): Bob(2) loses 470 -> 30
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "RAISE", amountChips: 470 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });

    // Hand 2: Button=2, SB=3, BB=1 -> Bob=30 total (10 left on Flop < BB 20!)
    const hand2 = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(hand2.buttonSeatNumber, 2);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    const flop2 = (await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" })).hand!;
    assert.equal(flop2.street, "FLOP");
    assert.equal(flop2.actingSeatNumber, 3);

    // Seat 3 checks, Seat 1 checks, Seat 2 (Bob, 10 left < BB 20) goes short open ALL_IN for 10!
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CHECK" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" });
    const afterShortOpen = (await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "ALL_IN" })).hand!;
    assert.equal(afterShortOpen.currentBet, 10);
    assert.equal(afterShortOpen.actingSeatNumber, 3);

    const legalCarolLocked = getLegalActions(afterShortOpen, setup.session.config, 3)!;
    assert.equal(legalCarolLocked.canCall, true);
    assert.equal(legalCarolLocked.callChips, 10);
    assert.equal(legalCarolLocked.canRaise, false);
    assert.equal(legalCarolLocked.canAllIn, false);
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "RAISE", amountChips: 30 }, 409);

    const backToAlice = (await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(backToAlice.actingSeatNumber, 1);
    const legalAliceLocked = getLegalActions(backToAlice, setup.session.config, 1)!;
    assert.equal(legalAliceLocked.canRaise, false);
    assert.equal(legalAliceLocked.canAllIn, false);
    assert.equal(legalAliceLocked.callChips, 10);
  });

  it("auto-awards any Showdown Pot with only one eligible Seat immediately and still allows resolving contested Pots", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { seatCount: 6, startingStackChips: 500, smallBlind: 10, bigBlind: 20 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
      ],
    );

    // Hand 1 (Button=1): Carol(3) loses 450 -> 50
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "RAISE", amountChips: 450 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });

    // Hand 2 (Button=2, SB=3(50), BB=1)
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "RAISE", amountChips: 50 });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "ALL_IN" });
    const flop = (await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(flop.street, "FLOP");

    // Flop: Alice(1) bets 100 -> Bob(2) calls 100
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "BET", amountChips: 100 });
    const turn = (await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" })).hand!;
    assert.equal(turn.street, "TURN");

    // Turn: Alice(1) bets 100 -> Bob(2) FOLDS!
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "BET", amountChips: 100 });
    const afterFold = await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });

    const showdown = afterFold.hand!;
    const sessionAtShowdown = afterFold.session!;
    assert.equal(showdown.status, "SHOWDOWN");
    assert.equal(showdown.lastUncalledReturned?.seatNumber, 1);
    assert.equal(showdown.lastUncalledReturned?.amountChips, 100);
    assert.equal(showdown.pots.length, 2);

    assert.deepEqual(showdown.pots[0], {
      id: "main",
      label: "Main Pot",
      amountChips: 150,
      eligibleSeatNumbers: [1, 3],
      winnerSeatNumbers: null,
    });
    assert.deepEqual(showdown.pots[1], {
      id: "side-1",
      label: "Side Pot 1",
      amountChips: 200,
      eligibleSeatNumbers: [1],
      winnerSeatNumbers: [1],
    });
    assert.equal(showdown.potChips, 150);
    assert.equal(getSeatChips(sessionAtShowdown, 1), 550);
    assert.ok(
      showdown.result?.awards.some(
        (a) => a.potId === "side-1" && a.seatNumber === 1 && a.amountChips === 200,
      ),
    );

    const completed = await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [3], "main");
    assert.equal(completed.hand!.status, "COMPLETE");
    assert.equal(completed.session!.handInProgress, false);
    assert.equal(completed.hand!.potChips, 0);
    assert.equal(completed.hand!.result?.totalPotChips, 350);
    assert.equal(completed.hand!.result?.awards.length, 2);
    assert.equal(getSeatChips(completed.session!, 1), 550);
    assert.equal(getSeatChips(completed.session!, 2), 800);
    assert.equal(getSeatChips(completed.session!, 3), 150);
  });
});
