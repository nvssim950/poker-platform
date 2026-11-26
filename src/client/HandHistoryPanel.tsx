import { useState } from "react";
import type { HandState, PotAwardView } from "../shared/handEngine.ts";
import type { SessionSnapshot } from "../shared/session.ts";
import {
  formatActionBody,
  formatEligibleSeatList,
  STREET_LABELS,
  STREET_ORDER,
} from "./handFormat.ts";

function summarizeWinners(awards: readonly PotAwardView[]): string {
  const totalsBySeat = new Map<number, { displayName: string; chips: number }>();
  for (const award of awards) {
    const prev = totalsBySeat.get(award.seatNumber);
    totalsBySeat.set(award.seatNumber, {
      displayName: award.displayName,
      chips: (prev?.chips ?? 0) + award.amountChips,
    });
  }
  return Array.from(totalsBySeat.entries())
    .map(([seatNumber, info]) => `Seat ${seatNumber} (${info.displayName}) +${info.chips} Chips`)
    .join(" · ");
}

function HandHistoryItem({
  hand,
  anteChipsPerSeat,
}: {
  hand: HandState;
  anteChipsPerSeat: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalPotChips =
    hand.result?.totalPotChips ?? hand.pots.reduce((sum, pot) => sum + pot.amountChips, 0);
  const awards = hand.result?.awards ?? [];
  const outcomeLabel = hand.result?.reason === "FOLD_WIN" ? "Fold-Win" : "Showdown";
  const streetGroups = STREET_ORDER.map((street) => ({
    street,
    actions: hand.actionHistory.filter((record) => record.street === street),
  })).filter((group) => group.actions.length > 0);

  return (
    <div className="seat-card hand-history-card">
      <div className="brand-bar" style={{ width: "100%", marginBottom: "6px" }}>
        <div>
          <div className="seat-title" style={{ marginBottom: "4px" }}>
            <span>Hand #{hand.handNumber}</span>
            <span className="pill pill-live">
              {outcomeLabel} · {totalPotChips} Chips
            </span>
            {hand.runItTwice && <span className="pill pill-live">Run It Twice</span>}
          </div>
          <div className="pill-row">
            <span className="pill">BTN Seat {hand.buttonSeatNumber}</span>
            <span className="pill">
              SB {hand.sbSeatNumber} / BB {hand.bbSeatNumber}
            </span>
            {hand.bbAnteChips > 0 && <span className="pill">BB Ante {hand.bbAnteChips}</span>}
            {anteChipsPerSeat > 0 && <span className="pill">Ante {anteChipsPerSeat}/Seat</span>}
            {hand.straddleSeatNumber !== null && (
              <span className="pill">Straddle Seat {hand.straddleSeatNumber}</span>
            )}
            {hand.isHeadsUp && <span className="pill">Heads-Up</span>}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ flexShrink: 0 }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide" : "Details"}
        </button>
      </div>

      {awards.length > 0 && (
        <div className="seat-sub" style={{ width: "100%" }}>
          Won: {summarizeWinners(awards)}
        </div>
      )}

      {expanded && (
        <div className="history-detail">
          <div className="history-section">
            <h4 className="settlement-subheading">Pots &amp; Awards</h4>
            <div className="pot-list">
              {hand.pots.map((pot) => {
                const potAwards = awards.filter((a) => a.potId === pot.id);
                return (
                  <div key={pot.id} className="pot-card">
                    <div
                      className="seat-title"
                      style={{ justifyContent: "space-between", width: "100%" }}
                    >
                      <span>{pot.label}</span>
                      <span className="pill pill-live">{pot.amountChips} Chips</span>
                    </div>
                    <div className="seat-sub">
                      Eligible: {formatEligibleSeatList(pot.eligibleSeatNumbers, hand.seats)}
                    </div>
                    {potAwards.length > 0 && (
                      <div className="seat-sub" style={{ color: "var(--accent)" }}>
                        {potAwards
                          .map(
                            (a) =>
                              `Seat ${a.seatNumber} (${a.displayName}) +${a.amountChips} Chips${
                                a.oddChips > 0 ? ` (includes ${a.oddChips} odd Chip(s))` : ""
                              }`,
                          )
                          .join(" · ")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {hand.result?.uncalledReturned && (
              <div className="seat-sub" style={{ marginTop: "6px" }}>
                Uncalled {hand.result.uncalledReturned.amountChips} Chips returned to Seat{" "}
                {hand.result.uncalledReturned.seatNumber} (
                {hand.result.uncalledReturned.displayName}).
              </div>
            )}
          </div>

          <div className="history-section">
            <h4 className="settlement-subheading">Street-by-Street Actions</h4>
            {streetGroups.length === 0 ? (
              <div className="seat-sub">
                No voluntary betting Actions (All-In from blinds/Antes).
              </div>
            ) : (
              <div className="pot-list">
                {streetGroups.map((group) => (
                  <div key={group.street} className="pot-card">
                    <div className="seat-title" style={{ fontSize: "0.86rem" }}>
                      {STREET_LABELS[group.street]}
                    </div>
                    <div className="seat-list" style={{ gap: "4px" }}>
                      {group.actions.map((record) => (
                        <div key={record.index} className="history-action-row">
                          <span className="seat-sub">{formatActionBody(record, false)}</span>
                          {record.byHostProxy && <span className="pill">Host Proxy</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Displays Session summary stats and expandable completed Hands for review across all phones.
 */
export function HandHistoryPanel({ session }: { session: SessionSnapshot }) {
  const [showHands, setShowHands] = useState(false);
  const { handHistory, sessionStats, config } = session;
  const anteChipsPerSeat = config.anteMode === "PER_SEAT" ? config.anteChips : 0;

  return (
    <div className="card">
      <div className="brand-bar" style={{ marginBottom: "10px" }}>
        <h3 style={{ margin: 0 }}>Hand History &amp; Summary</h3>
        {handHistory.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ flexShrink: 0 }}
            onClick={() => setShowHands((v) => !v)}
          >
            {showHands ? "Hide Hands" : `Hand History (${handHistory.length})`}
          </button>
        )}
      </div>

      <div
        className="ledger-stats"
        style={{ marginBottom: showHands && handHistory.length > 0 ? "12px" : 0 }}
      >
        <div className="ledger-stat">
          <span className="seat-sub">Hands Played</span>
          <strong>{sessionStats.handsPlayed}</strong>
        </div>
        <div className="ledger-stat">
          <span className="seat-sub">Biggest Pot</span>
          <strong>
            {sessionStats.biggestHandNumber !== null
              ? `${sessionStats.biggestPotChips} Chips (Hand #${sessionStats.biggestHandNumber})`
              : "—"}
          </strong>
        </div>
      </div>

      {handHistory.length === 0 && (
        <div className="seat-sub" style={{ marginTop: "8px" }}>
          No completed Hands yet.
        </div>
      )}

      {showHands && handHistory.length > 0 && (
        <div className="seat-list">
          {handHistory.map((hand) => (
            <HandHistoryItem
              key={hand.handNumber}
              hand={hand}
              anteChipsPerSeat={anteChipsPerSeat}
            />
          ))}
        </div>
      )}
    </div>
  );
}
