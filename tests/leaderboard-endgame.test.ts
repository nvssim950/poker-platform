import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGateway, type SessionGateway } from "../src/server/gateway.ts";
import type { SessionSnapshot } from "../src/shared/session.ts";

describe("Chip Leaderboard & Host End Game", () => {
  let tmpDir: string;
  let dbPath: string;
  let gateway: SessionGateway;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "poker-leaderboard-"));
    dbPath = join(tmpDir, "poker.db");
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);
  });

  after(async () => {
    await gateway.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tracks live Chip Leaderboard across Hands, Rebuys, and departures, removes Cash Settlement, and locks on End Game", async () => {
    const createRes = await fetch(`${gateway.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seatCount: 4,
        startingStackChips: 100,
        smallBlind: 10,
        bigBlind: 20,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      hostToken: string;
      session: SessionSnapshot;
    };
    const code = created.session.code;

    const claim = async (seatNumber: number, displayName: string) => {
      const res = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatNumber, displayName }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as { seatToken: string; playerId: string; session: SessionSnapshot };
    };

    const alice = await claim(1, "Alice");
    const bob = await claim(2, "Bob");
    const carol = await claim(3, "Carol");

    // Legacy Cash Settlement & Direct Cash-Out endpoints are removed (404)
    const oldSettle = await fetch(`${gateway.url}/api/sessions/${code}/settle`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(oldSettle.status, 404);

    const oldCashOut = await fetch(`${gateway.url}/api/sessions/${code}/seats/1/cash-out`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(oldCashOut.status, 404);

    // Hand 1: Alice wins All-In vs Bob (100+100), Carol folds BB (-20) -> Alice=220, Bob=0, Carol=80
    await fetch(`${gateway.url}/api/sessions/${code}/hand/start`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });

    // End Game rejected during active Hand (409) and unauthorized for Players (403)
    const unauthEnd = await fetch(`${gateway.url}/api/sessions/${code}/end`, {
      method: "POST",
      headers: { "x-seat-token": alice.seatToken },
    });
    assert.equal(unauthEnd.status, 403);

    const midHandEnd = await fetch(`${gateway.url}/api/sessions/${code}/end`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(midHandEnd.status, 409);

    await fetch(`${gateway.url}/api/sessions/${code}/hand/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": alice.seatToken },
      body: JSON.stringify({ action: "ALL_IN" }),
    });
    await fetch(`${gateway.url}/api/sessions/${code}/hand/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": bob.seatToken },
      body: JSON.stringify({ action: "ALL_IN" }),
    });
    await fetch(`${gateway.url}/api/sessions/${code}/hand/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seat-token": carol.seatToken },
      body: JSON.stringify({ action: "FOLD" }),
    });
    await fetch(`${gateway.url}/api/sessions/${code}/hand/showdown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-host-token": created.hostToken },
      body: JSON.stringify({ winnerSeatNumbers: [1] }),
    });

    // Bob rebuys (+100 Chips, rebuyCount = 1), Carol leaves Seat 3 (80 Chips, net -20)
    await fetch(`${gateway.url}/api/sessions/${code}/seats/2/rebuy`, {
      method: "POST",
      headers: { "x-seat-token": bob.seatToken },
    });
    const leaveRes = await fetch(`${gateway.url}/api/sessions/${code}/seats/3/leave`, {
      method: "POST",
      headers: { "x-seat-token": carol.seatToken },
    });
    assert.equal(leaveRes.status, 200);
    const afterLeave = (await leaveRes.json()) as { session: SessionSnapshot };

    assert.equal(afterLeave.session.leaderboard.endedAt, null);
    assert.equal(afterLeave.session.leaderboard.totalIssuedChips, 400);
    assert.equal(afterLeave.session.leaderboard.totalChips, 400);
    assert.deepEqual(
      afterLeave.session.leaderboard.entries.map((e) => ({
        displayName: e.displayName,
        chips: e.chips,
        totalIssuedChips: e.totalIssuedChips,
        rebuyCount: e.rebuyCount,
        netChips: e.netChips,
        status: e.status,
      })),
      [
        { displayName: "Alice", chips: 220, totalIssuedChips: 100, rebuyCount: 0, netChips: 120, status: "ACTIVE" },
        { displayName: "Carol", chips: 80, totalIssuedChips: 100, rebuyCount: 0, netChips: -20, status: "LEFT" },
        { displayName: "Bob", chips: 100, totalIssuedChips: 200, rebuyCount: 1, netChips: -100, status: "ACTIVE" },
      ],
    );

    // Host triggers End Game -> Session SETTLED, final leaderboard locked and persisted across restart
    const endRes = await fetch(`${gateway.url}/api/sessions/${code}/end`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(endRes.status, 200);
    const ended = (await endRes.json()) as { session: SessionSnapshot };
    assert.equal(ended.session.status, "SETTLED");
    assert.ok(ended.session.leaderboard.endedAt);
    assert.equal(ended.session.leaderboard.totalChips, 400);

    // Further mutations rejected (409)
    const startAfterEnd = await fetch(`${gateway.url}/api/sessions/${code}/hand/start`, {
      method: "POST",
      headers: { "x-host-token": created.hostToken },
    });
    assert.equal(startAfterEnd.status, 409);

    const claimAfterEnd = await fetch(`${gateway.url}/api/sessions/${code}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seatNumber: 4, displayName: "Dan" }),
    });
    assert.equal(claimAfterEnd.status, 409);

    // Persists across restart
    await gateway.close();
    gateway = createSessionGateway({ dbPath });
    await gateway.listen(0);

    const reloadedRes = await fetch(`${gateway.url}/api/sessions/${code}`);
    assert.equal(reloadedRes.status, 200);
    const reloaded = (await reloadedRes.json()) as { session: SessionSnapshot };
    assert.equal(reloaded.session.status, "SETTLED");
    assert.equal(reloaded.session.leaderboard.entries.length, 3);
    assert.equal(reloaded.session.leaderboard.entries[0]?.displayName, "Alice");
  });
});
