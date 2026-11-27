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
      startingStackChips: 500,
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

  it("enforces Host-only authority, 404s, and 409 boundary rejections for Undo (including Settled)", async () => {
    const missingUndo = await undoStep(gateway.url, "NOPE99", { "x-host-token": "anything" }, 404);
    assert.ok(missingUndo.error);
    const missingHands = await fetch(`${gateway.url}/api/sessions/NOPE99/hands`);
    assert.equal(missingHands.status, 404);

    const setup = await createFundedSession(
      gateway.url,
      { startingStackChips: 500 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
      ],
    );

    assert.equal(setup.session.canUndo, false);
    assert.deepEqual(setup.session.handHistory, []);
    assert.deepEqual(setup.session.sessionStats, {
      handsPlayed: 0,
      biggestPotChips: 0,
      biggestHandNumber: null,
    } satisfies SessionStats);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);

    const started = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(started.session.canUndo, false);
    assert.equal(started.hand.actingSeatNumber, 1);
    const atStartErr = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);
    assert.match(atStartErr.error ?? "", /start of current Hand/i);

    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "RAISE", amountChips: 40 });

    // Non-Host cannot Undo
    await undoStep(gateway.url, setup.code, {}, 403);
    await undoStep(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, 403);
    await undoStep(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, 403);

    // Host Undoes back to step 0
    const undone = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 200);
    assert.equal(undone.hand?.actingSeatNumber, 1);
    assert.equal(undone.hand?.currentBet, 20);
    assert.equal(undone.hand?.actionHistory.length, 0);
    assert.equal(undone.session?.canUndo, false);
    assert.equal(getSeatChips(undone.session!, 1), 500);

    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);

    // Finish Hand 1 via Fold-Win and End Game -> Undo rejected with 409
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "FOLD" });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "FOLD" });
    const endRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/end`, {
      method: "POST",
      headers: { "x-host-token": setup.hostToken },
    });
    assert.equal(endRes.status, 200);
    const ended = (await endRes.json()) as { session: SessionSnapshot };
    assert.equal(ended.session.canUndo, false);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);
  });

  it("steps Undo backward across Street transitions, restores exact stacks, Pots, raising rights, and broadcasts via WebSocket", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { startingStackChips: 1000 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
      ],
    );

    // Hand 1 (Button=1): Carol loses 840 -> 160
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "RAISE", amountChips: 840 });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "FOLD" });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[3]!.seatToken }, { action: "CALL" });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[3]!.seatToken }, { action: "CHECK" });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "BET", amountChips: 20 });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[3]!.seatToken }, { action: "FOLD" });

    // Hand 2 (Button=2, SB=3(160), BB=1) -> fold around? No, play Hand 2 or advance Button to 3:
    // Actually with Button=2: SB=3(160), BB=1, UTG=2! Flop order is 3 -> 1 -> 2, so 1 bets 60, 3? No, let's advance Button to 1 by folding 2 hands (keep Carol out of SB by trimming Carol to 170 first -> fold SB = 160)!
    // Even simpler: in Hand 2 (Button=2), SB=3(160), BB=1, UTG=2 -> 2 raises to 60, 3 calls 60 (100 left), 1 calls 60 -> Flop (3 -> 1 -> 2): 3 checks, 1 bets 60, 2 calls 60, 3? No, 3 already checked so 3 can shove 100 (+40 short) -> 1 already bet 60 so 1 is locked from raising!!
    const hostWs = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      hostToken: setup.hostToken,
    });
    const aliceWs = await connectSubscribedWs(gateway.url, {
      code: setup.code,
      seatToken: setup.seats[1]!.seatToken,
    });

    try {
      await startHand(gateway.url, setup.code, setup.hostToken);
      await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "RAISE", amountChips: 60 });
      await act(gateway.url, setup.code, { "x-seat-token": setup.seats[3]!.seatToken }, { action: "CALL" });
      const flopReached = await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "CALL" });
      assert.equal(flopReached.hand?.street, "FLOP");
      assert.equal(flopReached.hand?.potChips, 180);
      assert.equal(flopReached.hand?.actingSeatNumber, 3);

      // Flop (3 -> 1 -> 2): 3 checks, 1 bets 60, 2 calls 60, 3 pushes short All-In for 100 (increment 40 < 60!)
      await act(gateway.url, setup.code, { "x-seat-token": setup.seats[3]!.seatToken }, { action: "CHECK" });
      await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "BET", amountChips: 60 });
      await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "CALL" });
      const beforeAliceCall = await act(gateway.url, setup.code, { "x-seat-token": setup.seats[3]!.seatToken }, { action: "ALL_IN" });
      assert.equal(beforeAliceCall.hand?.actingSeatNumber, 1);
      assert.equal(getLegalActions(beforeAliceCall.hand!, setup.session.config, 1)?.canRaise, false);

      // Seat 1 calls 40 -> Seat 2 calls 40 -> TURN
      await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "CALL" });
      const turnReached = await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "CALL" });
      assert.equal(turnReached.hand?.street, "TURN");
      assert.equal(turnReached.hand?.potChips, 480);
      assert.equal(turnReached.hand?.actingSeatNumber, 1);

      // Turn: Seat 1 bets 100
      const afterTurnBet = await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "BET", amountChips: 100 });
      assert.equal(afterTurnBet.hand?.actingSeatNumber, 2);

      // Step 1 Undo: Turn bet 100 -> back to start of TURN
      const u1 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(u1.hand?.street, "TURN");
      assert.equal(u1.hand?.currentBet, 0);
      assert.equal(u1.hand?.actingSeatNumber, 1);

      // Step 2 Undo: TURN -> FLOP transition
      const u2 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(u2.hand?.street, "FLOP");
      assert.equal(u2.hand?.actingSeatNumber, 2);
      assert.equal(u2.hand?.potChips, 180);
      assert.equal(u2.hand?.currentBet, 100);
      assert.equal(getLegalActions(u2.hand!, setup.session.config, 2)?.canRaise, false);

      // Undo back across Carol's short All-In -> restores Seat 1 raising rights if not yet acted on 60?
      await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }); // undo Seat 1 call
      const u4 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }); // undo Carol All-In
      assert.equal(u4.hand?.street, "FLOP");
      assert.equal(u4.hand?.actingSeatNumber, 3);
      assert.equal(u4.hand?.currentBet, 60);
      assert.equal(getSeatChips(u4.session!, 3), 100);
      assert.equal(u4.hand?.seats.find((s) => s.seatNumber === 3)?.isAllIn, false);

      // Undo Bob call, Alice bet, Carol check -> FLOP -> PREFLOP!
      await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      const uPreflop = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
      assert.equal(uPreflop.hand?.street, "PREFLOP");
      assert.equal(uPreflop.hand?.actingSeatNumber, 1);
      assert.equal(uPreflop.hand?.potChips, 0);

      await waitForCondition(() => {
        const latestHost = hostWs.messages.at(-1)?.session;
        const latestAlice = aliceWs.messages.at(-1)?.session;
        return (
          latestHost?.hand?.street === "PREFLOP" &&
          latestHost.hand.actingSeatNumber === 1 &&
          latestAlice?.hand?.street === "PREFLOP" &&
          latestAlice.hand.actingSeatNumber === 1
        );
      });
    } finally {
      hostWs.ws.close();
      aliceWs.ws.close();
    }
  });

  it("rewinds just-resolved Fold-Win (with uncalled return) and Showdown pots before next Hand starts", async () => {
    const foldSetup = await createFundedSession(
      gateway.url,
      { startingStackChips: 500 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
      ],
    );

    await startHand(gateway.url, foldSetup.code, foldSetup.hostToken);
    await act(gateway.url, foldSetup.code, { "x-seat-token": foldSetup.seats[1]!.seatToken }, { action: "RAISE", amountChips: 80 });
    await act(gateway.url, foldSetup.code, { "x-seat-token": foldSetup.seats[2]!.seatToken }, { action: "FOLD" });
    const foldWin = await act(gateway.url, foldSetup.code, { "x-seat-token": foldSetup.seats[3]!.seatToken }, { action: "FOLD" });
    assert.equal(foldWin.hand?.status, "COMPLETE");
    assert.equal(foldWin.hand?.result?.reason, "FOLD_WIN");
    assert.equal(foldWin.hand?.result?.uncalledReturned?.amountChips, 60);
    assert.equal(foldWin.session?.canUndo, true);
    assert.equal(foldWin.session?.handHistory.length, 1);
    assert.equal(foldWin.session?.sessionStats.handsPlayed, 1);
    assert.equal(getSeatChips(foldWin.session!, 1), 530);

    const rewoundFold = await undoStep(gateway.url, foldSetup.code, { "x-host-token": foldSetup.hostToken });
    assert.equal(rewoundFold.hand?.status, "BETTING");
    assert.equal(rewoundFold.hand?.street, "PREFLOP");
    assert.equal(rewoundFold.hand?.actingSeatNumber, 3);
    assert.equal(rewoundFold.hand?.result, null);
    assert.equal(rewoundFold.hand?.lastUncalledReturned, null);
    assert.equal(rewoundFold.session?.handInProgress, true);
    assert.equal(rewoundFold.session?.handHistory.length, 0);
    assert.equal(rewoundFold.session?.sessionStats.handsPlayed, 0);
    assert.equal(getSeatChips(rewoundFold.session!, 1), 420);

    const carolCalled = await act(gateway.url, foldSetup.code, { "x-seat-token": foldSetup.seats[3]!.seatToken }, { action: "CALL" });
    assert.equal(carolCalled.hand?.street, "FLOP");

    // Part B: Showdown Undo
    const sdSetup = await createFundedSession(
      gateway.url,
      { startingStackChips: 400 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
      ],
    );
    await startHand(gateway.url, sdSetup.code, sdSetup.hostToken);
    await act(gateway.url, sdSetup.code, { "x-seat-token": sdSetup.seats[1]!.seatToken }, { action: "ALL_IN" });
    await act(gateway.url, sdSetup.code, { "x-seat-token": sdSetup.seats[2]!.seatToken }, { action: "CALL" });
    const completed = await resolveShowdownPot(gateway.url, sdSetup.code, sdSetup.hostToken, [1]);
    assert.equal(completed.hand.status, "COMPLETE");
    assert.equal(getSeatChips(completed.session, 1), 800);
    assert.equal(getSeatChips(completed.session, 2), 0);

    const undoneSd = await undoStep(gateway.url, sdSetup.code, { "x-host-token": sdSetup.hostToken });
    assert.equal(undoneSd.hand?.status, "SHOWDOWN");
    assert.equal(undoneSd.session?.handHistory.length, 0);
    assert.equal(getSeatChips(undoneSd.session!, 1), 0);

    const reResolved = await resolveShowdownPot(gateway.url, sdSetup.code, sdSetup.hostToken, [2]);
    assert.equal(reResolved.hand.status, "COMPLETE");
    assert.equal(getSeatChips(reResolved.session, 2), 800);
  });

  it("locks prior Hands once a new Hand starts and recovers Undo checkpoints across server restart", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { startingStackChips: 500 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
      ],
    );

    await startHand(gateway.url, setup.code, setup.hostToken);
    const h1Done = await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "FOLD" });
    assert.equal(h1Done.hand?.status, "COMPLETE");
    assert.equal(h1Done.session?.canUndo, true);
    assert.equal(h1Done.session?.handHistory.length, 1);

    const h2Start = await startHand(gateway.url, setup.code, setup.hostToken);
    assert.equal(h2Start.hand.handNumber, 2);
    assert.equal(h2Start.session.canUndo, false);
    assert.equal(h2Start.session.handHistory.length, 1);
    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);

    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "RAISE", amountChips: 60 });
    const h2Flop = await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "CALL" });
    assert.equal(h2Flop.hand?.street, "FLOP");
    assert.equal(h2Flop.session?.canUndo, true);

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

    const u1 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
    assert.equal(u1.hand?.handNumber, 2);
    assert.equal(u1.hand?.street, "PREFLOP");
    assert.equal(u1.hand?.actingSeatNumber, 1);
    assert.equal(getSeatChips(u1.session!, 1), 470);

    const u2 = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
    assert.equal(u2.hand?.handNumber, 2);
    assert.equal(u2.hand?.actingSeatNumber, 2);
    assert.equal(u2.session?.canUndo, false);
    assert.equal(getSeatChips(u2.session!, 2), 500);

    await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken }, 409);
  });

  it("allows mid-Hand newcomer Seat claiming while preserving active-Hand Undo", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { startingStackChips: 300 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 3, displayName: "Carol" },
      ],
    );

    const h1 = await startHand(gateway.url, setup.code, setup.hostToken);
    const firstActor = h1.hand.actingSeatNumber!;
    const actorToken = firstActor === 1 ? setup.seats[1]!.seatToken : setup.seats[3]!.seatToken;
    await act(gateway.url, setup.code, { "x-seat-token": actorToken }, { action: "RAISE", amountChips: 60 });

    const claim4 = await fetch(`${gateway.url}/api/sessions/${setup.code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 4, displayName: "Dave" }),
    });
    assert.equal(claim4.status, 200);

    const undoMidHand = await undoStep(gateway.url, setup.code, { "x-host-token": setup.hostToken });
    assert.equal(undoMidHand.hand?.actionHistory.length, 0);
    assert.equal(getSeatChips(undoMidHand.session!, 4), 300);
  });

  it("exposes GET /api/sessions/:code/hands and accurate Hand history / Session stats across multiple Hands", async () => {
    const setup = await createFundedSession(
      gateway.url,
      { startingStackChips: 300 },
      [
        { seatNumber: 1, displayName: "Alice" },
        { seatNumber: 2, displayName: "Bob" },
        { seatNumber: 3, displayName: "Carol" },
      ],
    );

    // Hand 1: Fold-Win (Pot = 30)
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "FOLD" });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "FOLD" });

    // Hand 2: All-In Showdown with Host proxy action (Main Pot = 900)
    await startHand(gateway.url, setup.code, setup.hostToken);
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[2]!.seatToken }, { action: "ALL_IN" });
    await act(gateway.url, setup.code, { "x-host-token": setup.hostToken }, { seatNumber: 3, action: "ALL_IN" });
    await act(gateway.url, setup.code, { "x-seat-token": setup.seats[1]!.seatToken }, { action: "CALL" });
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1], "main");
    await resolveShowdownPot(gateway.url, setup.code, setup.hostToken, [1], "side-1");

    const handsRes = await fetch(`${gateway.url}/api/sessions/${setup.code}/hands`);
    assert.equal(handsRes.status, 200);
    const handsData = (await handsRes.json()) as GetSessionHandsResponse;

    assert.equal(handsData.hands.length, 2);
    assert.deepEqual(handsData.hands.map((h) => h.handNumber), [2, 1]);
    assert.deepEqual(handsData.sessionStats, {
      handsPlayed: 2,
      biggestPotChips: 890,
      biggestHandNumber: 2,
    });

    const hand2 = handsData.hands.find((h) => h.handNumber === 2)!;
    assert.equal(hand2.result?.reason, "SHOWDOWN");
    assert.equal(hand2.actionHistory.some((a) => a.seatNumber === 3 && a.byHostProxy), true);
  });
});
