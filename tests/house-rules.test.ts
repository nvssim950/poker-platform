import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";
import {
  canRunItTwice,
  getLegalActions,
  getLivePots,
  getTotalPotChips,
  setRunItTwice as setRunItTwiceEngine,
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

async function startHand(
  gatewayUrl: string,
  code: string,
  hostToken: string,
  body?: Record<string, unknown>,
  expectedStatus = 201,
): Promise<{ hand?: HandState; session?: SessionSnapshot; error?: string }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/start`, {
    method: "POST",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-host-token": hostToken,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(res.status, expectedStatus);
  return (await res.json()) as { hand?: HandState; session?: SessionSnapshot; error?: string };
}

async function act(
  gatewayUrl: string,
  code: string,
  token: string,
  payload: Record<string, unknown>,
  expectedStatus = 200,
  asHost = false,
): Promise<{ hand?: HandState; session?: SessionSnapshot; error?: string }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(asHost ? { "x-host-token": token } : { "x-seat-token": token }),
    },
    body: JSON.stringify(payload),
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
    body: JSON.stringify({ winnerSeatNumbers, ...(potId ? { potId } : {}) }),
  });
  assert.equal(res.status, expectedStatus);
  return (await res.json()) as { hand?: HandState; session?: SessionSnapshot; error?: string };
}

async function setRunItTwice(
  gatewayUrl: string,
  code: string,
  token: string,
  enabled: boolean,
  expectedStatus = 200,
  useSeatToken = false,
): Promise<{ hand?: HandState; session?: SessionSnapshot; error?: string }> {
  const res = await fetch(`${gatewayUrl}/api/sessions/${code}/hand/run-it-twice`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(useSeatToken ? { "x-seat-token": token } : { "x-host-token": token }),
    },
    body: JSON.stringify({ enabled }),
  });
  assert.equal(res.status, expectedStatus);
  return (await res.json()) as { hand?: HandState; session?: SessionSnapshot; error?: string };
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

function getSeatChips(session: SessionSnapshot, seatNumber: number): number {
  return session.seats.find((s) => s.seatNumber === seatNumber)?.occupant?.chips ?? -1;
}

describe("Optional House Rules — Antes, Straddles & Run It Twice", () => {
  let tmpDir: string;
  let dbPath: string;
  let gateway: SessionGateway;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "poker-house-rules-"));
    dbPath = join(tmpDir, "poker.db");
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);
  });

  after(async () => {
    await gateway.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates house rule config fields and defaults omitted values cleanly", async () => {
    // Omitted house rule fields default cleanly
    const defaultSetup = await createFundedSession(gateway.url);
    assert.equal(defaultSetup.session.config.anteMode, "NONE");
    assert.equal(defaultSetup.session.config.anteChips, 0);
    assert.equal(defaultSetup.session.config.allowStraddle, false);
    assert.equal(defaultSetup.session.config.allowRunItTwice, false);

    // Invalid ante combinations rejected
    const badCases = [
      { anteMode: "PER_SEAT", anteChips: 0 },
      { anteMode: "BIG_BLIND_ANTE" },
      { anteMode: "PER_SEAT", anteChips: 7 }, // not multiple of step=5
      { anteMode: "PER_SEAT", anteChips: -5 },
      { anteMode: "INVALID_MODE", anteChips: 5 },
      { allowStraddle: "yes" },
      { allowRunItTwice: 1 },
    ];
    for (const bad of badCases) {
      const res = await fetch(`${gateway.url}/api/sessions`, {
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
          ...bad,
        }),
      });
      assert.equal(res.status, 400);
    }

    // Valid configured house rules persist in SessionConfig
    const configured = await createFundedSession(gateway.url, {
      anteMode: "BIG_BLIND_ANTE",
      anteChips: 20,
      allowStraddle: true,
      allowRunItTwice: true,
    });
    assert.equal(configured.session.config.anteMode, "BIG_BLIND_ANTE");
    assert.equal(configured.session.config.anteChips, 20);
    assert.equal(configured.session.config.allowStraddle, true);
    assert.equal(configured.session.config.allowRunItTwice, true);
  });

  it("posts every-Seat Antes without inflating To Call or min-raise and caps short-stack Ante All-Ins cleanly", async () => {
    const setup = await createFundedSession(
      gateway.url,
      {
        seatCount: 6,
        smallBlind: 10,
        bigBlind: 20,
        smallestChipStep: 5,
        anteMode: "PER_SEAT",
        anteChips: 10,
      },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
      ],
    );

    // Hand 1: BTN=1, SB=2, BB=3. Deep stacks verify To Call & minRaiseTo are NOT inflated by Antes.
    const start1 = (await startHand(gateway.url, setup.code, setup.hostToken)).hand!;
    assert.equal(start1.potChips, 30); // 10 * 3 antes
    assert.equal(start1.deadPotChips, 0);
    assert.equal(start1.bbAnteChips, 0);
    assert.equal(start1.currentBet, 20);
    assert.equal(getTotalPotChips(start1), 60); // 30 antes + 10 SB + 20 BB
    assert.equal(start1.actingSeatNumber, 1);

    for (const s of start1.seats) {
      assert.equal(s.anteCommittedChips, 10);
    }
    const legal1 = getLegalActions(start1, setup.session.config, 1)!;
    assert.equal(legal1.toCall, 20);
    assert.equal(legal1.callChips, 20);
    assert.equal(legal1.minRaiseTo, 40);

    // Seat 1 folds, Seat 2 folds -> BB (Seat 3) wins Fold-Win collecting 30 antes + 10 SB + 10 matched BB = 50 (plus 10 uncalled returned)
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });
    const foldWin = await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    assert.equal(foldWin.hand!.status, "COMPLETE");
    assert.equal(foldWin.hand!.result?.reason, "FOLD_WIN");
    assert.equal(foldWin.hand!.result?.totalPotChips, 50);
    assert.equal(getSeatChips(foldWin.session!, 1), 490);
    assert.equal(getSeatChips(foldWin.session!, 2), 480);
    assert.equal(getSeatChips(foldWin.session!, 3), 530); // +30 net profit (10 from Alice + 20 from Bob)

    // Now test short-stack Ante All-In! Setup a fresh session where Seat 2 has only 5 Chips (< 10 Ante).
    const shortSetup = await createFundedSession(
      gateway.url,
      {
        seatCount: 6,
        smallBlind: 10,
        bigBlind: 20,
        smallestChipStep: 5,
        anteMode: "PER_SEAT",
        anteChips: 10,
      },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Shorty", chips: 5 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
      ],
    );

    // Hand 1: BTN=1, SB=2 (posts 5 Ante -> All-In with 0 SB!), BB=3 (posts 10 Ante + 20 BB)
    const shortStart = (await startHand(gateway.url, shortSetup.code, shortSetup.hostToken)).hand!;
    const seat2 = shortStart.seats.find((s) => s.seatNumber === 2)!;
    assert.equal(seat2.chips, 0);
    assert.equal(seat2.anteCommittedChips, 5);
    assert.equal(seat2.streetCommittedChips, 0);
    assert.equal(seat2.totalCommittedChips, 5);
    assert.equal(seat2.isAllIn, true);
    assert.equal(shortStart.potChips, 25); // 10 + 5 + 10
    assert.equal(getTotalPotChips(shortStart), 45); // 25 + 20 BB
    assert.equal(shortStart.actingSeatNumber, 1);

    const liveBefore = getLivePots(shortStart);
    assert.deepEqual(
      liveBefore.map((p) => ({ label: p.label, amount: p.amountChips, eligible: p.eligibleSeatNumbers })),
      [
        { label: "Main Pot", amount: 15, eligible: [1, 2, 3] },
        { label: "Side Pot 1", amount: 30, eligible: [1, 3] },
      ],
    );

    // Alice calls 20 -> Seat 2 skipped -> Carol checks -> Flop -> check down to Showdown
    await act(gateway.url, shortSetup.code, shortSetup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, shortSetup.code, shortSetup.seats[3]!.seatToken, { action: "CHECK" });
    // Flop, Turn, River check-down (Carol first to act left of BTN=1)
    for (let i = 0; i < 3; i += 1) {
      await act(gateway.url, shortSetup.code, shortSetup.seats[3]!.seatToken, { action: "CHECK" });
      await act(gateway.url, shortSetup.code, shortSetup.seats[1]!.seatToken, { action: "CHECK" });
    }

    const afterShowdownFetch = await fetch(`${gateway.url}/api/sessions/${shortSetup.code}`, {
      headers: { "x-host-token": shortSetup.hostToken },
    });
    const showdownSession = ((await afterShowdownFetch.json()) as { session: SessionSnapshot }).session;
    const showdownHand = showdownSession.hand!;
    assert.equal(showdownHand.status, "SHOWDOWN");
    assert.deepEqual(
      showdownHand.pots.map((p) => ({
        id: p.id,
        amountChips: p.amountChips,
        eligibleSeatNumbers: p.eligibleSeatNumbers,
      })),
      [
        { id: "main", amountChips: 15, eligibleSeatNumbers: [1, 2, 3] },
        { id: "side-1", amountChips: 50, eligibleSeatNumbers: [1, 3] },
      ],
    );

    // Shorty wins Main Pot (15), Carol wins Side Pot 1 (50)
    await resolveShowdownPot(gateway.url, shortSetup.code, shortSetup.hostToken, [2], "main");
    const completed = await resolveShowdownPot(gateway.url, shortSetup.code, shortSetup.hostToken, [3], "side-1");
    assert.equal(completed.hand!.status, "COMPLETE");
    assert.equal(getSeatChips(completed.session!, 1), 470);
    assert.equal(getSeatChips(completed.session!, 2), 15);
    assert.equal(getSeatChips(completed.session!, 3), 520);
    assert.equal(470 + 15 + 520, 1005);
  });

  it("posts Big Blind Ante into deadPotChips after Big Blind without distorting Side Pots or call baselines", async () => {
    // Subtest A: BB has partial stack after posting BB (25 total: 20 BB + 5 BBA)
    const partialSetup = await createFundedSession(
      gateway.url,
      {
        seatCount: 6,
        smallBlind: 10,
        bigBlind: 20,
        smallestChipStep: 5,
        anteMode: "BIG_BLIND_ANTE",
        anteChips: 20,
      },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "ShortBB", chips: 25 },
      ],
    );

    const partialStart = (await startHand(gateway.url, partialSetup.code, partialSetup.hostToken)).hand!;
    const bbSeatPartial = partialStart.seats.find((s) => s.seatNumber === 3)!;
    assert.equal(bbSeatPartial.chips, 0);
    assert.equal(bbSeatPartial.streetCommittedChips, 20);
    assert.equal(bbSeatPartial.totalCommittedChips, 20);
    assert.equal(bbSeatPartial.isAllIn, true);
    assert.equal(partialStart.deadPotChips, 5);
    assert.equal(partialStart.bbAnteChips, 5);
    assert.equal(getTotalPotChips(partialStart), 35); // 10 SB + 20 BB + 5 BBA

    // Alice folds, Bob folds -> Fold-Win returns 10 uncalled to ShortBB and awards 10 (SB) + 10 (BB) + 5 (BBA) = 25 -> ShortBB ends with 35
    await act(gateway.url, partialSetup.code, partialSetup.seats[1]!.seatToken, { action: "FOLD" });
    const partialEnd = await act(gateway.url, partialSetup.code, partialSetup.seats[2]!.seatToken, { action: "FOLD" });
    assert.equal(partialEnd.hand!.status, "COMPLETE");
    assert.equal(partialEnd.hand!.deadPotChips, 0);
    assert.equal(getSeatChips(partialEnd.session!, 3), 35); // +10 from Bob

    // Subtest B: Full BBA (20) stays purely in Main Pot even when a Side Pot forms
    const bbaSetup = await createFundedSession(
      gateway.url,
      {
        seatCount: 6,
        smallBlind: 10,
        bigBlind: 20,
        smallestChipStep: 5,
        anteMode: "BIG_BLIND_ANTE",
        anteChips: 20,
      },
      [
        { seatNumber: 1, displayName: "ShortBTN", chips: 30 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
      ],
    );

    const bbaStart = (await startHand(gateway.url, bbaSetup.code, bbaSetup.hostToken)).hand!;
    assert.equal(bbaStart.deadPotChips, 20);
    assert.equal(bbaStart.bbAnteChips, 20);
    assert.equal(bbaStart.currentBet, 20);
    assert.equal(getTotalPotChips(bbaStart), 50); // 10 SB + 20 BB + 20 BBA

    const legalBtn = getLegalActions(bbaStart, bbaSetup.session.config, 1)!;
    assert.equal(legalBtn.toCall, 20); // NOT inflated by BBA!

    // ShortBTN goes All-In (30), Bob calls 30, Carol calls 10 (total 30)
    await act(gateway.url, bbaSetup.code, bbaSetup.seats[1]!.seatToken, { action: "ALL_IN" });
    await act(gateway.url, bbaSetup.code, bbaSetup.seats[2]!.seatToken, { action: "CALL" });
    await act(gateway.url, bbaSetup.code, bbaSetup.seats[3]!.seatToken, { action: "CALL" });

    // Flop: Bob bets 20, Carol calls 20; Turn & River check down
    await act(gateway.url, bbaSetup.code, bbaSetup.seats[2]!.seatToken, { action: "BET", amountChips: 20 });
    await act(gateway.url, bbaSetup.code, bbaSetup.seats[3]!.seatToken, { action: "CALL" });
    for (let i = 0; i < 2; i += 1) {
      await act(gateway.url, bbaSetup.code, bbaSetup.seats[2]!.seatToken, { action: "CHECK" });
      await act(gateway.url, bbaSetup.code, bbaSetup.seats[3]!.seatToken, { action: "CHECK" });
    }

    const bbaRes = await fetch(`${gateway.url}/api/sessions/${bbaSetup.code}`, {
      headers: { "x-host-token": bbaSetup.hostToken },
    });
    const bbaHand = ((await bbaRes.json()) as { session: SessionSnapshot }).session.hand!;
    assert.equal(bbaHand.status, "SHOWDOWN");
    assert.deepEqual(
      bbaHand.pots.map((p) => ({
        id: p.id,
        amountChips: p.amountChips,
        eligibleSeatNumbers: p.eligibleSeatNumbers,
      })),
      [
        { id: "main", amountChips: 110, eligibleSeatNumbers: [1, 2, 3] }, // 30*3 + 20 dead BBA
        { id: "side-1", amountChips: 40, eligibleSeatNumbers: [2, 3] },
      ],
    );

    await resolveShowdownPot(gateway.url, bbaSetup.code, bbaSetup.hostToken, [1], "main");
    const bbaComplete = await resolveShowdownPot(gateway.url, bbaSetup.code, bbaSetup.hostToken, [2], "side-1");
    assert.equal(getSeatChips(bbaComplete.session!, 1), 110);
    assert.equal(getSeatChips(bbaComplete.session!, 2), 490);
    assert.equal(getSeatChips(bbaComplete.session!, 3), 430);
    assert.equal(110 + 490 + 430, 1030);
  });

  it("supports voluntary UTG Straddle via both startHand and STRADDLE action, shifting Preflop order and preserving raise option", async () => {
    const setup = await createFundedSession(
      gateway.url,
      {
        seatCount: 6,
        smallBlind: 10,
        bigBlind: 20,
        smallestChipStep: 5,
        allowStraddle: true,
      },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
        { seatNumber: 4, displayName: "Dan", chips: 500 },
      ],
    );

    // Hand 1: BTN=1, SB=2, BB=3, UTG=4. Explicit STRADDLE via /hand/actions!
    const start1 = (await startHand(gateway.url, setup.code, setup.hostToken)).hand!;
    assert.equal(start1.actingSeatNumber, 4);
    assert.equal(start1.straddleSeatNumber, null);
    assert.equal(getLegalActions(start1, setup.session.config, 4)?.canStraddle, true);
    assert.equal(getLegalActions(start1, setup.session.config, 4)?.straddleChips, 40);

    // Non-UTG cannot straddle
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "STRADDLE" }, 409);

    // UTG (Seat 4) posts Straddle (40)
    const afterStraddle = (
      await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "STRADDLE" })
    ).hand!;
    assert.equal(afterStraddle.straddleSeatNumber, 4);
    assert.equal(afterStraddle.currentBet, 40);
    assert.equal(afterStraddle.lastFullRaiseBet, 40);
    assert.equal(afterStraddle.lastFullRaiseIncrement, 20);
    assert.equal(afterStraddle.actingSeatNumber, 1); // Shifted clockwise left of UTG!

    const danSeat = afterStraddle.seats.find((s) => s.seatNumber === 4)!;
    assert.equal(danSeat.chips, 460);
    assert.equal(danSeat.streetCommittedChips, 40);
    assert.equal(danSeat.hasActedThisStreet, false);
    assert.equal(danSeat.hasActedSinceFullRaise, false);

    // Cannot straddle a second time
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "STRADDLE" }, 409);

    // Seat 1 calls 40, Seat 2 calls 30, Seat 3 calls 20 -> returns to Seat 4 (UTG) with live raise option!
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "CALL" });
    const backToUtg = (
      await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" })
    ).hand!;
    assert.equal(backToUtg.street, "PREFLOP");
    assert.equal(backToUtg.actingSeatNumber, 4);

    const legalUtgOption = getLegalActions(backToUtg, setup.session.config, 4)!;
    assert.equal(legalUtgOption.toCall, 0);
    assert.equal(legalUtgOption.canCheck, true);
    assert.equal(legalUtgOption.canRaise, true);
    assert.equal(legalUtgOption.minRaiseTo, 60);
    assert.equal(legalUtgOption.canStraddle, false);

    // Dan exercises Straddle option and raises to 100!
    const afterUtgRaise = (
      await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "RAISE", amountChips: 100 })
    ).hand!;
    assert.equal(afterUtgRaise.currentBet, 100);
    assert.equal(afterUtgRaise.actingSeatNumber, 1);

    // Everyone folds to Dan -> Hand 1 completes
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    const end1 = await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });
    assert.equal(end1.hand!.status, "COMPLETE");

    // Hand 2: BTN rotates to Seat 2, SB=3, BB=4, UTG=1. Start Hand with { postStraddle: true }!
    const start2 = (
      await startHand(gateway.url, setup.code, setup.hostToken, { postStraddle: true })
    ).hand!;
    assert.equal(start2.buttonSeatNumber, 2);
    assert.equal(start2.sbSeatNumber, 3);
    assert.equal(start2.bbSeatNumber, 4);
    assert.equal(start2.straddleSeatNumber, 1);
    assert.equal(start2.currentBet, 40);
    assert.equal(start2.actingSeatNumber, 2); // Left of UTG (Seat 1) is Seat 2!

    // Seat 2 folds, Seat 3 folds, Seat 4 calls 20 -> returns to Seat 1 (UTG) who checks to Flop
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "FOLD" });
    const backToSeat1 = (
      await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "CALL" })
    ).hand!;
    assert.equal(backToSeat1.actingSeatNumber, 1);
    const toFlop = (
      await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "CHECK" })
    ).hand!;
    assert.equal(toFlop.street, "FLOP");
  });

  it("supports Host-toggled Run It Twice across Main Pot & Side Pots with odd-Chip halves, left-of-Button splits, and SQLite persistence", async () => {
    const setup = await createFundedSession(
      gateway.url,
      {
        seatCount: 6,
        smallBlind: 10,
        bigBlind: 20,
        smallestChipStep: 5,
        allowRunItTwice: true,
      },
      [
        { seatNumber: 1, displayName: "Alice", chips: 35 },  // BTN: 35 -> Main Pot cap
        { seatNumber: 2, displayName: "Bob", chips: 100 },   // SB: 100 -> Side Pot 1 cap
        { seatNumber: 3, displayName: "Carol", chips: 300 }, // BB: calls 100 -> retains 200 chips (contendersWithChips = [3], length 1 < 2!)
      ],
    );

    const wsSub = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      hostToken: setup.hostToken,
    });

    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "ALL_IN" }); // 35
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "ALL_IN" }); // 100

    // Before Showdown, Run It Twice toggle is rejected
    await setRunItTwice(gateway.url, setup.code, setup.hostToken, true, 409);

    const showdown = (
      await act(gateway.url, setup.code, setup.seats[3]!.seatToken, { action: "CALL" })
    ).hand!;
    assert.equal(showdown.status, "SHOWDOWN");
    assert.equal(showdown.runItTwice, false);
    // Main Pot = 35*3 = 105 (21 steps of 5); Side Pot 1 = 65*2 = 130 (26 steps of 5)
    assert.deepEqual(
      showdown.pots.map((p) => ({ id: p.id, amountChips: p.amountChips })),
      [
        { id: "main", amountChips: 105 },
        { id: "side-1", amountChips: 130 },
      ],
    );

    // Non-Host cannot toggle Run It Twice
    await setRunItTwice(gateway.url, setup.code, setup.seats[1]!.seatToken, true, 403, true);

    // Host enables Run It Twice -> splits Main Pot (105 -> 55 & 50) and Side Pot 1 (130 -> 65 & 65)
    const ritOn = (await setRunItTwice(gateway.url, setup.code, setup.hostToken, true)).hand!;
    assert.equal(ritOn.runItTwice, true);
    assert.deepEqual(
      ritOn.pots.map((p) => ({ id: p.id, label: p.label, amountChips: p.amountChips })),
      [
        { id: "main-run-1", label: "Main Pot (Run 1)", amountChips: 55 },
        { id: "main-run-2", label: "Main Pot (Run 2)", amountChips: 50 },
        { id: "side-1-run-1", label: "Side Pot 1 (Run 1)", amountChips: 65 },
        { id: "side-1-run-2", label: "Side Pot 1 (Run 2)", amountChips: 65 },
      ],
    );

    // Host can toggle Run It Twice back OFF before resolving any contested pot, then ON again
    const ritOff = (await setRunItTwice(gateway.url, setup.code, setup.hostToken, false)).hand!;
    assert.equal(ritOff.runItTwice, false);
    assert.equal(ritOff.pots.length, 2);
    assert.equal(ritOff.pots[0]!.amountChips, 105);

    const ritOnAgain = (await setRunItTwice(gateway.url, setup.code, setup.hostToken, true)).hand!;
    assert.equal(ritOnAgain.runItTwice, true);
    assert.equal(ritOnAgain.pots.length, 4);

    // WebSocket received Run It Twice Showdown pots
    await waitForCondition(() =>
      wsSub.messages.some((m) => m.session.hand?.runItTwice === true && m.session.hand.pots.length === 4),
    );
    wsSub.ws.close();

    // Resolve Main Pot (Run 1) = 55 split between Seat 1 (BTN) and Seat 2 (SB).
    // Clockwise left of Button (1): Seat 2 gets odd 5 Chips -> Seat 2 +30, Seat 1 +25.
    const afterRun1 = (
      await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1, 2], "main-run-1")
    ).hand!;
    assert.equal(afterRun1.status, "SHOWDOWN");

    // Once a contested sub-pot is resolved, toggling Run It Twice is blocked
    await setRunItTwice(gateway.url, setup.code, setup.hostToken, false, 409);

    // Restart gateway mid-Run-It-Twice Showdown -> verify SQLite persistence!
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    const reloadRes = await fetch(`${gateway.url}/api/sessions/${setup.code}`, {
      headers: { "x-host-token": setup.hostToken },
    });
    assert.equal(reloadRes.status, 200);
    const reloaded = (await reloadRes.json()) as { session: SessionSnapshot };
    assert.equal(reloaded.session.hand?.runItTwice, true);
    assert.equal(reloaded.session.hand?.pots.length, 4);
    assert.deepEqual(reloaded.session.hand?.pots[0]?.winnerSeatNumbers, [2, 1]);

    // Resolve remaining sub-pots:
    // Main Pot (Run 2) = 50 -> Seat 3 wins (+50)
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [3], "main-run-2");
    // Side Pot 1 (Run 1) = 65 -> Split between Seat 2 & Seat 3 (left of Button=1: Seat 2 gets +35, Seat 3 gets +30)
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [2, 3], "side-1-run-1");
    // Side Pot 1 (Run 2) = 65 -> Seat 3 wins (+65)
    const completed = await resolveShowdownPot(
      gateway.url,
      setup.code,
      setup.hostToken,
      [3],
      "side-1-run-2",
    );

    assert.equal(completed.hand!.status, "COMPLETE");
    assert.equal(completed.hand!.potChips, 0);
    assert.equal(completed.hand!.result?.totalPotChips, 235);
    assert.equal(getSeatChips(completed.session!, 1), 25);
    assert.equal(getSeatChips(completed.session!, 2), 65);
    assert.equal(getSeatChips(completed.session!, 3), 345); // 200 remaining + 50 + 30 + 65
    assert.equal(25 + 65 + 345, 435);
  });

  it("enforces UTG Straddle endpoint guards (dedicated /straddle endpoint, Heads-Up, short stack, and post-action)", async () => {
    // 1. Dedicated /hand/straddle endpoint via Host proxy & UTG Player, plus short-stack / post-action rejection
    const setup = await createFundedSession(
      gateway.url,
      {
        seatCount: 6,
        smallBlind: 10,
        bigBlind: 20,
        smallestChipStep: 5,
        allowStraddle: true,
      },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
        { seatNumber: 4, displayName: "ShortUTG", chips: 35 }, // < 40 (2*BB)
      ],
    );

    // Hand 1: BTN=1, SB=2, BB=3, UTG=4 (only 35 Chips -> cannot Straddle!)
    const badStart = await startHand(gateway.url, setup.code, setup.hostToken, { postStraddle: true }, 409);
    assert.match(badStart.error ?? "", /40 Chips/);

    const h1 = (await startHand(gateway.url, setup.code, setup.hostToken)).hand!;
    assert.equal(getLegalActions(h1, setup.session.config, 4)?.canStraddle, false);
    const shortRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/hand/straddle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seat-token": setup.seats[4]!.seatToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(shortRes.status, 409);

    // Seat 4 folds -> actionHistory.length === 1; Seat 1 cannot Straddle after first action
    await act(gateway.url, setup.code, setup.seats[4]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[1]!.seatToken, { action: "FOLD" });
    await act(gateway.url, setup.code, setup.seats[2]!.seatToken, { action: "FOLD" });

    // Hand 2: BTN=2, SB=3, BB=4 (ShortUTG=35 -> BB all-in 20), UTG=1 (500 Chips) -> Host proxy posts /hand/straddle!
    const h2 = (await startHand(gateway.url, setup.code, setup.hostToken)).hand!;
    assert.equal(h2.actingSeatNumber, 1);
    const proxyStraddleRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/hand/straddle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-host-token": setup.hostToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(proxyStraddleRes.status, 200);
    const proxyStraddled = (await proxyStraddleRes.json()) as { hand: HandState };
    assert.equal(proxyStraddled.hand.straddleSeatNumber, 1);
    assert.equal(proxyStraddled.hand.actingSeatNumber, 2);
    assert.equal(proxyStraddled.hand.actionHistory[0]?.action, "STRADDLE");
    assert.equal(proxyStraddled.hand.actionHistory[0]?.byHostProxy, true);

    // 2. Heads-Up session with allowStraddle=true does NOT permit Straddle
    const huSetup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5, allowStraddle: true },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
      ],
    );
    await startHand(gateway.url, huSetup.code, huSetup.hostToken, { postStraddle: true }, 409);
    const huHand = (await startHand(gateway.url, huSetup.code, huSetup.hostToken)).hand!;
    assert.equal(getLegalActions(huHand, huSetup.session.config, 1)?.canStraddle, false);
    await act(gateway.url, huSetup.code, huSetup.seats[1]!.seatToken, { action: "STRADDLE" }, 409);

    // 3. Session with allowStraddle=false rejects postStraddle=true
    const disabledSetup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5, allowStraddle: false },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
        { seatNumber: 3, displayName: "Carol", chips: 500 },
      ],
    );
    await startHand(gateway.url, disabledSetup.code, disabledSetup.hostToken, { postStraddle: true }, 409);
  });

  it("blocks Run It Twice on non-all-in River check-downs, preserves auto-awarded pots, and skips Run 2 on single-step pots", async () => {
    // Subtest A: River check-down with 2+ contenders holding chips > 0 cannot use Run It Twice
    const riverSetup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5, allowRunItTwice: true },
      [
        { seatNumber: 1, displayName: "Alice", chips: 500 },
        { seatNumber: 2, displayName: "Bob", chips: 500 },
      ],
    );
    await startHand(gateway.url, riverSetup.code, riverSetup.hostToken);
    await act(gateway.url, riverSetup.code, riverSetup.seats[1]!.seatToken, { action: "CALL" });
    await act(gateway.url, riverSetup.code, riverSetup.seats[2]!.seatToken, { action: "CHECK" });
    for (let i = 0; i < 3; i += 1) {
      await act(gateway.url, riverSetup.code, riverSetup.seats[2]!.seatToken, { action: "CHECK" });
      await act(gateway.url, riverSetup.code, riverSetup.seats[1]!.seatToken, { action: "CHECK" });
    }
    const riverSessionRes = await fetch(`${gateway.url}/api/sessions/${riverSetup.code}`, {
      headers: { "x-host-token": riverSetup.hostToken },
    });
    const riverHand = ((await riverSessionRes.json()) as { session: SessionSnapshot }).session.hand!;
    assert.equal(riverHand.status, "SHOWDOWN");
    assert.equal(canRunItTwice(riverHand, riverSetup.session.config), false);
    await setRunItTwice(gateway.url, riverSetup.code, riverSetup.hostToken, true, 409);

    // Subtest B: Auto-awarded Side Pot stays auto-awarded while contested Main Pot splits into Run 1 & Run 2
    const autoSetup = await createFundedSession(
      gateway.url,
      { seatCount: 6, smallBlind: 10, bigBlind: 20, smallestChipStep: 5, allowRunItTwice: true },
      [
        { seatNumber: 1, displayName: "Alice", chips: 200 },
        { seatNumber: 2, displayName: "Bob", chips: 100 },
        { seatNumber: 3, displayName: "Carol", chips: 50 },
      ],
    );
    await startHand(gateway.url, autoSetup.code, autoSetup.hostToken);
    await act(gateway.url, autoSetup.code, autoSetup.seats[1]!.seatToken, { action: "ALL_IN" }); // 200
    await act(gateway.url, autoSetup.code, autoSetup.seats[2]!.seatToken, { action: "FOLD" });   // folded 10 SB
    const autoShowdown = (
      await act(gateway.url, autoSetup.code, autoSetup.seats[3]!.seatToken, { action: "ALL_IN" }) // 50
    ).hand!;
    // Uncalled 150 returned to Seat 1 -> Main Pot = 50 + 10 + 50 = 110 ([1, 3])
    assert.equal(autoShowdown.status, "SHOWDOWN");
    assert.equal(canRunItTwice(autoShowdown, autoSetup.session.config), true);

    // Also test Run It Twice with an auto-awarded single-eligible pot via 3-way where bettor folds?
    // Wait: test single-step pot skipping Run 2 directly via setRunItTwiceEngine!
    const singleStepHand: HandState = {
      ...autoShowdown,
      pots: [
        {
          id: "main",
          label: "Main Pot",
          amountChips: 5,
          eligibleSeatNumbers: [1, 3],
          winnerSeatNumbers: null,
        },
        {
          id: "side-1",
          label: "Side Pot 1",
          amountChips: 40,
          eligibleSeatNumbers: [1],
          winnerSeatNumbers: [1],
        },
      ],
    };
    const ritSingleStep = setRunItTwiceEngine(singleStepHand, autoSetup.session.config, true);
    assert.equal(ritSingleStep.ok, true);
    if (ritSingleStep.ok) {
      assert.deepEqual(
        ritSingleStep.value.pots.map((p) => ({
          id: p.id,
          amountChips: p.amountChips,
          winnerSeatNumbers: p.winnerSeatNumbers,
        })),
        [
          { id: "main-run-1", amountChips: 5, winnerSeatNumbers: null },
          { id: "side-1", amountChips: 40, winnerSeatNumbers: [1] },
        ],
      );
      // Toggling back OFF restores exact original pots while preserving auto-awarded side-1!
      const ritOff = setRunItTwiceEngine(ritSingleStep.value, autoSetup.session.config, false);
      assert.equal(ritOff.ok, true);
      if (ritOff.ok) {
        assert.deepEqual(ritOff.value.pots, singleStepHand.pots);
      }
    }
  });
});
