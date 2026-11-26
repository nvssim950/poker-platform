import { useEffect, useState } from "react";
import {
  clockwiseLeftOfButtonOffset,
  computePotSplitAwards,
  determineNextButtonSeat,
  getEligibleSeatsForNewHand,
  getLegalActions,
  getTotalPotChips,
  type HandActionRecord,
  type PlayerActionType,
  type Street,
} from "../shared/handEngine.ts";
import type { SessionSnapshot, ViewerIdentity } from "../shared/session.ts";
import { loadSessionTokens, sessionApi } from "./api.ts";

const STREET_LABELS: Record<Street, string> = {
  PREFLOP: "Preflop",
  FLOP: "Flop",
  TURN: "Turn",
  RIVER: "River",
};

function formatActionSummary(record: HandActionRecord): string {
  const seatLabel = `Seat ${record.seatNumber} (${record.displayName})`;
  const proxyTag = record.byHostProxy ? " · Host Proxy" : "";
  switch (record.action) {
    case "FOLD":
      return `${STREET_LABELS[record.street]} · ${seatLabel} Folded${proxyTag}`;
    case "CHECK":
      return `${STREET_LABELS[record.street]} · ${seatLabel} Checked${proxyTag}`;
    case "CALL":
      return `${STREET_LABELS[record.street]} · ${seatLabel} Called ${record.amountChips} Chips${proxyTag}`;
    case "BET":
      return `${STREET_LABELS[record.street]} · ${seatLabel} Bet ${record.amountChips} Chips${proxyTag}`;
    case "RAISE":
      return `${STREET_LABELS[record.street]} · ${seatLabel} Raised to ${record.amountChips} Chips${proxyTag}`;
    case "ALL_IN":
      return `${STREET_LABELS[record.street]} · ${seatLabel} All-In (${record.amountChips} Chips)${proxyTag}`;
  }
}

export function HandTablePanel({
  session,
  viewer,
  onSessionUpdate,
  onError,
}: {
  session: SessionSnapshot;
  viewer: ViewerIdentity;
  onSessionUpdate: (updated: SessionSnapshot) => void;
  onError: (message: string | null) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [wagerText, setWagerText] = useState("");
  const [selectedWinners, setSelectedWinners] = useState<number[]>([]);
  const [showActionLog, setShowActionLog] = useState(false);

  const hand = session.hand;
  const eligibleSeats = getEligibleSeatsForNewHand(session.seats);
  const nextButtonSeat =
    eligibleSeats.length >= 2
      ? determineNextButtonSeat(
          eligibleSeats.map((s) => s.seatNumber),
          hand?.buttonSeatNumber ?? null,
        )
      : null;

  const actingSeat =
    hand && hand.actingSeatNumber !== null
      ? hand.seats.find((s) => s.seatNumber === hand.actingSeatNumber) ?? null
      : null;

  const legal =
    hand && hand.status === "BETTING" && hand.actingSeatNumber !== null
      ? getLegalActions(hand, session.config, hand.actingSeatNumber)
      : null;

  const minWager = legal ? (legal.minBetTo ?? legal.minRaiseTo ?? null) : null;
  const maxWager = legal ? (legal.maxBetTo ?? legal.maxRaiseTo ?? null) : null;

  useEffect(() => {
    if (minWager !== null) {
      setWagerText(String(minWager));
    } else {
      setWagerText("");
    }
  }, [hand?.handNumber, hand?.street, hand?.actingSeatNumber, hand?.actionHistory.length, minWager]);

  const activeShowdownPot =
    hand && hand.status === "SHOWDOWN"
      ? hand.pots.find((p) => p.winnerSeatNumbers === null) ?? null
      : null;

  useEffect(() => {
    setSelectedWinners([]);
  }, [hand?.handNumber, hand?.status, activeShowdownPot?.id]);

  async function handleStartHand(): Promise<void> {
    onError(null);
    setSubmitting(true);
    try {
      const res = await sessionApi.startHand(session.code, loadSessionTokens(session.code));
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to start Hand.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAction(action: PlayerActionType, amountChips?: number): Promise<void> {
    if (!hand || hand.actingSeatNumber === null) return;
    onError(null);
    setSubmitting(true);
    try {
      const payload =
        viewer.isHost && viewer.seatNumber !== hand.actingSeatNumber
          ? { seatNumber: hand.actingSeatNumber, action, amountChips }
          : { action, amountChips };
      const res = await sessionApi.submitHandAction(
        session.code,
        payload,
        loadSessionTokens(session.code),
      );
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to submit Action.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResolveShowdown(): Promise<void> {
    if (!activeShowdownPot || selectedWinners.length === 0) return;
    onError(null);
    setSubmitting(true);
    try {
      const res = await sessionApi.resolveShowdown(
        session.code,
        { winnerSeatNumbers: selectedWinners, potId: activeShowdownPot.id },
        loadSessionTokens(session.code),
      );
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to resolve Showdown.");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleWinnerSeat(seatNumber: number): void {
    setSelectedWinners((prev) =>
      prev.includes(seatNumber) ? prev.filter((n) => n !== seatNumber) : [...prev, seatNumber],
    );
  }

  const parsedWager = Number(wagerText);
  const wagerValid =
    legal !== null &&
    minWager !== null &&
    maxWager !== null &&
    Number.isInteger(parsedWager) &&
    parsedWager >= minWager &&
    parsedWager <= maxWager &&
    parsedWager % legal.smallestChipStep === 0;

  let wagerError: string | null = null;
  if (minWager !== null && maxWager !== null && wagerText.trim().length > 0 && !wagerValid) {
    if (!Number.isInteger(parsedWager)) {
      wagerError = "Wager must be a whole number in Chips.";
    } else if (legal && parsedWager % legal.smallestChipStep !== 0) {
      wagerError = `Must be a multiple of smallest Chip step (${legal.smallestChipStep}).`;
    } else if (parsedWager < minWager) {
      wagerError = `Minimum is ${minWager} Chips.`;
    } else if (parsedWager > maxWager) {
      wagerError = `Cannot exceed ${maxWager} Chips.`;
    }
  }

  const isMyTurn =
    hand !== null &&
    hand.status === "BETTING" &&
    hand.actingSeatNumber !== null &&
    viewer.seatNumber === hand.actingSeatNumber;

  const canActNow =
    hand !== null &&
    hand.status === "BETTING" &&
    legal !== null &&
    (isMyTurn || viewer.isHost);

  const livePotChips = hand ? getTotalPotChips(hand) : 0;

  const orderedShowdownContenders =
    hand && activeShowdownPot
      ? [...activeShowdownPot.eligibleSeatNumbers]
          .sort(
            (a, b) =>
              clockwiseLeftOfButtonOffset(a, hand.buttonSeatNumber, session.config.seatCount) -
              clockwiseLeftOfButtonOffset(b, hand.buttonSeatNumber, session.config.seatCount),
          )
          .map((seatNumber) => hand.seats.find((s) => s.seatNumber === seatNumber))
          .filter((s): s is NonNullable<typeof s> => s !== undefined)
      : [];

  const splitPreview =
    hand && activeShowdownPot && selectedWinners.length > 0
      ? computePotSplitAwards({
          potAmountChips: activeShowdownPot.amountChips,
          winnerSeatNumbers: selectedWinners,
          buttonSeatNumber: hand.buttonSeatNumber,
          seatCount: session.config.seatCount,
          smallestChipStep: session.config.smallestChipStep,
        })
      : null;

  return (
    <>
      {!session.handInProgress && (
        <div className="card">
          <div className="brand-bar" style={{ marginBottom: viewer.isHost ? "10px" : 0 }}>
            <div>
              <h3 style={{ margin: "0 0 4px" }}>
                {hand ? `Ready for Hand #${hand.handNumber + 1}` : "Table Ready"}
              </h3>
              <div className="seat-sub">
                {eligibleSeats.length >= 2
                  ? `${eligibleSeats.length} funded Seats ready · Next Button: Seat ${nextButtonSeat}`
                  : `Need at least 2 funded Seats to start a Hand (${eligibleSeats.length} ready).`}
              </div>
            </div>
          </div>

          {viewer.isHost && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting || eligibleSeats.length < 2}
              onClick={() => void handleStartHand()}
            >
              {submitting
                ? "Starting Hand..."
                : `Start Hand #${(hand?.handNumber ?? 0) + 1}`}
            </button>
          )}
        </div>
      )}

      {hand && hand.status === "COMPLETE" && hand.result && (
        <div className="card">
          <div className="brand-bar" style={{ marginBottom: "10px" }}>
            <h3 style={{ margin: 0 }}>Hand #{hand.handNumber} Complete</h3>
            <span className="pill pill-live">
              {hand.result.reason === "FOLD_WIN" ? "Fold-Win" : "Showdown"} ·{" "}
              {hand.result.totalPotChips} Chips
            </span>
          </div>
          <div className="seat-list">
            {hand.result.awards.map((award) => (
              <div key={`${award.potId}-${award.seatNumber}`} className="seat-card">
                <div className="seat-meta">
                  <div className="seat-title">
                    <span>
                      Seat {award.seatNumber} · {award.displayName}
                    </span>
                    <span className="pill pill-live">+{award.amountChips} Chips</span>
                  </div>
                  <div className="seat-sub">
                    {award.potLabel}
                    {award.oddChips > 0 ? ` · includes ${award.oddChips} odd Chip(s)` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {hand.result.uncalledReturned && (
            <div className="seat-sub" style={{ marginTop: "8px" }}>
              Uncalled {hand.result.uncalledReturned.amountChips} Chips returned to Seat{" "}
              {hand.result.uncalledReturned.seatNumber} ({hand.result.uncalledReturned.displayName}
              ).
            </div>
          )}
        </div>
      )}

      {hand && hand.status !== "COMPLETE" && (
        <div className="card">
          <div className="brand-bar" style={{ marginBottom: "10px" }}>
            <div>
              <h3 style={{ margin: "0 0 4px" }}>
                Hand #{hand.handNumber} ·{" "}
                {hand.status === "SHOWDOWN" ? "Showdown" : STREET_LABELS[hand.street]}
              </h3>
              <div className="pill-row">
                <span className="pill pill-live">Pot {livePotChips} Chips</span>
                <span className="pill">BTN Seat {hand.buttonSeatNumber}</span>
                <span className="pill">
                  SB {hand.sbSeatNumber} / BB {hand.bbSeatNumber}
                </span>
                {hand.isHeadsUp && <span className="pill">Heads-Up</span>}
              </div>
            </div>
          </div>

          {hand.dealPrompt && (
            <div className="deal-prompt-banner">
              <strong>Deal Prompt:</strong> {hand.dealPrompt}
            </div>
          )}

          {hand.status === "BETTING" && actingSeat && legal && (
            <>
              <div className={`turn-banner ${isMyTurn ? "turn-mine" : ""}`}>
                {isMyTurn
                  ? `Your Turn · Seat ${actingSeat.seatNumber} (${actingSeat.displayName})`
                  : `Acting: Seat ${actingSeat.seatNumber} (${actingSeat.displayName})`}
              </div>

              <div className="hand-stats-row">
                <div className="ledger-stat">
                  <span className="seat-sub">Pot</span>
                  <strong>{legal.totalPotChips} Chips</strong>
                </div>
                <div className="ledger-stat">
                  <span className="seat-sub">To Call</span>
                  <strong>{legal.toCall} Chips</strong>
                </div>
                <div className="ledger-stat">
                  <span className="seat-sub">
                    {legal.canBet ? "Min Bet" : "Min Raise"}
                  </span>
                  <strong>
                    {minWager !== null ? `${minWager} Chips` : "—"}
                  </strong>
                </div>
              </div>
            </>
          )}

          <div className="seat-list" style={{ marginBottom: canActNow || activeShowdownPot ? "12px" : 0 }}>
            {hand.seats.map((seat) => {
              const isActing =
                hand.status === "BETTING" && hand.actingSeatNumber === seat.seatNumber;
              return (
                <div
                  key={seat.seatNumber}
                  className={`seat-card ${isActing ? "seat-acting" : ""} ${
                    viewer.seatNumber === seat.seatNumber ? "seat-mine" : ""
                  }`}
                >
                  <div className="seat-meta">
                    <div className="seat-title">
                      <span>
                        Seat {seat.seatNumber} · {seat.displayName}
                      </span>
                      {seat.seatNumber === hand.buttonSeatNumber && (
                        <span className="pill">BTN</span>
                      )}
                      {seat.seatNumber === hand.sbSeatNumber && <span className="pill">SB</span>}
                      {seat.seatNumber === hand.bbSeatNumber && <span className="pill">BB</span>}
                      {isActing && <span className="pill pill-live">Acting</span>}
                      {seat.hasFolded && <span className="pill">Folded</span>}
                      {seat.isAllIn && <span className="pill pill-warn">All-In</span>}
                    </div>
                    <div className="seat-sub">
                      Stack: {seat.chips} Chips
                      {seat.streetCommittedChips > 0
                        ? ` · Street Bet: ${seat.streetCommittedChips} Chips`
                        : ""}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {canActNow && legal && actingSeat && (
            <div className="action-bar">
              <div className="seat-sub" style={{ marginBottom: "8px" }}>
                {isMyTurn
                  ? `Your Action (Seat ${actingSeat.seatNumber})`
                  : `Host Proxy Action · Seat ${actingSeat.seatNumber} (${actingSeat.displayName})`}
              </div>

              {(legal.canBet || legal.canRaise) && minWager !== null && maxWager !== null && (
                <div className="wager-controls">
                  {maxWager > minWager && (
                    <div className="field">
                      <label htmlFor="hand-wager-slider">
                        {legal.canBet ? "Bet Amount" : "Raise To"} ({minWager}–{maxWager} Chips)
                      </label>
                      <input
                        id="hand-wager-slider"
                        className="chip-slider"
                        type="range"
                        min={minWager}
                        max={maxWager}
                        step={legal.smallestChipStep}
                        value={
                          Number.isFinite(parsedWager)
                            ? Math.min(maxWager, Math.max(minWager, parsedWager))
                            : minWager
                        }
                        onChange={(e) => setWagerText(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="hand-wager-input">
                      {legal.canBet ? "Bet (Chips)" : "Raise To (Chips)"}
                    </label>
                    <input
                      id="hand-wager-input"
                      type="number"
                      inputMode="numeric"
                      min={minWager}
                      max={maxWager}
                      step={legal.smallestChipStep}
                      value={wagerText}
                      onChange={(e) => setWagerText(e.target.value)}
                    />
                  </div>
                  {wagerError && (
                    <div className="seat-sub" style={{ color: "var(--warn)", marginBottom: "8px" }}>
                      {wagerError}
                    </div>
                  )}
                </div>
              )}

              <div className="action-buttons-grid">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={submitting || !legal.canFold}
                  onClick={() => void handleAction("FOLD")}
                >
                  Fold
                </button>

                {legal.canCheck && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={submitting}
                    onClick={() => void handleAction("CHECK")}
                  >
                    Check
                  </button>
                )}

                {legal.canCall && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={submitting}
                    onClick={() => void handleAction("CALL")}
                  >
                    {legal.callIsAllIn
                      ? `Call ${legal.callChips} (All-In)`
                      : `Call ${legal.callChips}`}
                  </button>
                )}

                {legal.canBet && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={submitting || !wagerValid}
                    onClick={() => void handleAction("BET", parsedWager)}
                  >
                    Bet {wagerValid ? parsedWager : ""}
                  </button>
                )}

                {legal.canRaise && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={submitting || !wagerValid}
                    onClick={() => void handleAction("RAISE", parsedWager)}
                  >
                    Raise to {wagerValid ? parsedWager : ""}
                  </button>
                )}

                {legal.canAllIn && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={submitting}
                    onClick={() => void handleAction("ALL_IN")}
                  >
                    All-In ({legal.allInAddedChips})
                  </button>
                )}
              </div>
            </div>
          )}

          {hand.status === "SHOWDOWN" && activeShowdownPot && (
            <div className="action-bar">
              <div className="brand-bar" style={{ marginBottom: "8px" }}>
                <h4 style={{ margin: 0 }}>
                  {activeShowdownPot.label} · {activeShowdownPot.amountChips} Chips
                </h4>
                <span className="pill pill-warn">Select Winner(s)</span>
              </div>
              {viewer.isHost ? (
                <>
                  <div className="seat-sub" style={{ marginBottom: "8px" }}>
                    Tap one Seat to award the Pot, or multiple Seats to split (any odd Chip goes
                    clockwise left of Button Seat {hand.buttonSeatNumber}).
                  </div>
                  <div className="seat-list" style={{ marginBottom: "10px" }}>
                    {orderedShowdownContenders.map((contender) => {
                      const checked = selectedWinners.includes(contender.seatNumber);
                      const payout = splitPreview?.get(contender.seatNumber);
                      return (
                        <button
                          key={contender.seatNumber}
                          type="button"
                          className={`seat-card showdown-option ${checked ? "seat-acting" : ""}`}
                          onClick={() => toggleWinnerSeat(contender.seatNumber)}
                        >
                          <div className="seat-meta" style={{ textAlign: "left" }}>
                            <div className="seat-title">
                              <span>
                                Seat {contender.seatNumber} · {contender.displayName}
                              </span>
                              {checked && <span className="pill pill-live">Winner</span>}
                            </div>
                            {payout && (
                              <div className="seat-sub">
                                Receives +{payout.amountChips} Chips
                                {payout.oddChips > 0
                                  ? ` (includes ${payout.oddChips} odd Chip)`
                                  : ""}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={submitting || selectedWinners.length === 0}
                    onClick={() => void handleResolveShowdown()}
                  >
                    {selectedWinners.length > 1
                      ? `Split ${activeShowdownPot.label} (${selectedWinners.length} ways)`
                      : `Award ${activeShowdownPot.label} (${activeShowdownPot.amountChips} Chips)`}
                  </button>
                </>
              ) : (
                <div className="seat-sub">
                  Waiting for Host to select the Showdown winner(s) for {activeShowdownPot.label}.
                </div>
              )}
            </div>
          )}

          {hand.actionHistory.length > 0 && (
            <div style={{ marginTop: "10px" }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowActionLog((v) => !v)}
              >
                {showActionLog
                  ? "Hide Hand Actions"
                  : `Hand Actions (${hand.actionHistory.length})`}
              </button>
              {showActionLog && (
                <div className="seat-list" style={{ marginTop: "8px" }}>
                  {[...hand.actionHistory].reverse().map((record) => (
                    <div key={record.index} className="seat-sub">
                      {formatActionSummary(record)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
