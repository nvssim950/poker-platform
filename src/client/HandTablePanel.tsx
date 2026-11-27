import { useEffect, useState } from "react";
import {
  clockwiseLeftOfButtonOffset,
  computePotSplitAwards,
  computeQuickWagerPresets,
  determineNextButtonSeat,
  getEligibleSeatsForNewHand,
  getLegalActions,
  getLivePots,
  getTotalPotChips,
  type HandPot,
  type PlayerActionType,
} from "../shared/handEngine.ts";
import type { SessionSnapshot, ViewerIdentity } from "../shared/session.ts";
import { loadSessionTokens, sessionApi } from "./api.ts";
import { formatEligibleSeatList, STREET_LABELS } from "./handFormat.ts";

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
  const [selectedWinnersByPot, setSelectedWinnersByPot] = useState<Record<string, number[]>>({});

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
  const quickPresets = legal ? computeQuickWagerPresets(legal) : null;

  useEffect(() => {
    if (minWager !== null) {
      setWagerText(String(minWager));
    } else {
      setWagerText("");
    }
  }, [hand?.handNumber, hand?.street, hand?.actingSeatNumber, hand?.actionHistory.length, minWager]);

  const unresolvedPotIdsKey =
    hand && hand.status === "SHOWDOWN"
      ? hand.pots
          .filter((p) => p.winnerSeatNumbers === null)
          .map((p) => p.id)
          .join(",")
      : "";

  useEffect(() => {
    setSelectedWinnersByPot({});
  }, [hand?.handNumber, hand?.status, unresolvedPotIdsKey]);

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

  async function handleResolveShowdown(pot: HandPot): Promise<void> {
    const winners = selectedWinnersByPot[pot.id] ?? [];
    if (winners.length === 0) return;
    onError(null);
    setSubmitting(true);
    try {
      const res = await sessionApi.resolveShowdown(
        session.code,
        { winnerSeatNumbers: winners, potId: pot.id },
        loadSessionTokens(session.code),
      );
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to resolve Showdown.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUndoHandStep(): Promise<void> {
    onError(null);
    setSubmitting(true);
    try {
      const res = await sessionApi.undoHandStep(session.code, loadSessionTokens(session.code));
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to undo Hand step.");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleWinnerSeat(potId: string, seatNumber: number): void {
    setSelectedWinnersByPot((prev) => {
      const current = prev[potId] ?? [];
      const next = current.includes(seatNumber)
        ? current.filter((n) => n !== seatNumber)
        : [...current, seatNumber];
      return { ...prev, [potId]: next };
    });
  }

  const parsedWager = Number(wagerText);
  const wagerValid =
    legal !== null &&
    minWager !== null &&
    maxWager !== null &&
    Number.isInteger(parsedWager) &&
    parsedWager >= minWager &&
    parsedWager <= maxWager;

  let wagerError: string | null = null;
  if (minWager !== null && maxWager !== null && wagerText.trim().length > 0 && !wagerValid) {
    if (!Number.isInteger(parsedWager)) {
      wagerError = "Wager must be a whole number in Chips.";
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
  const livePots = hand ? getLivePots(hand) : [];
  const totalHandPotChips =
    hand && hand.status === "SHOWDOWN"
      ? hand.pots.reduce((sum, pot) => sum + pot.amountChips, 0)
      : livePotChips;
  const shortAllInLocked =
    hand !== null &&
    hand.status === "BETTING" &&
    actingSeat !== null &&
    legal !== null &&
    hand.currentBet > 0 &&
    actingSeat.hasActedSinceFullRaise &&
    legal.toCall > 0 &&
    !legal.canRaise &&
    actingSeat.chips > legal.toCall;

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
            <div>
              <h3 style={{ margin: "0 0 4px" }}>Hand #{hand.handNumber} Complete</h3>
              <span className="pill pill-live">
                {hand.result.reason === "FOLD_WIN" ? "Fold-Win" : "Showdown"} ·{" "}
                {hand.result.totalPotChips} Chips
              </span>
            </div>
            {viewer.isHost && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ flexShrink: 0 }}
                disabled={submitting || !session.canUndo}
                title={
                  session.canUndo
                    ? "Undo resolution and rewind to previous state"
                    : "Undo locked after Rebuy or Seat departure"
                }
                onClick={() => void handleUndoHandStep()}
              >
                Undo
              </button>
            )}
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
                <span className="pill pill-live">Pot {totalHandPotChips} Chips</span>
                <span className="pill">BTN Seat {hand.buttonSeatNumber}</span>
                <span className="pill">
                  SB {hand.sbSeatNumber} / BB {hand.bbSeatNumber}
                </span>
                {hand.isHeadsUp && <span className="pill">Heads-Up</span>}
              </div>
            </div>
            {viewer.isHost && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ flexShrink: 0 }}
                disabled={submitting || !session.canUndo}
                title={
                  session.canUndo
                    ? "Undo last Action, Street transition, or Showdown step"
                    : "At start of current Hand; nothing left to undo"
                }
                onClick={() => void handleUndoHandStep()}
              >
                Undo
              </button>
            )}
          </div>

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
                  <strong>{minWager !== null ? `${minWager} Chips` : "—"}</strong>
                </div>
              </div>
            </>
          )}

          {hand.status === "BETTING" && livePots.length > 0 && (
            <div className="pot-list" style={{ marginBottom: "12px" }}>
              {livePots.map((pot) => (
                <div key={pot.id} className="pot-card">
                  <div className="seat-title" style={{ justifyContent: "space-between", width: "100%" }}>
                    <span>{pot.label}</span>
                    <span className="pill pill-live">{pot.amountChips} Chips</span>
                  </div>
                  <div className="seat-sub">
                    Eligible: {formatEligibleSeatList(pot.eligibleSeatNumbers, hand.seats)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {canActNow && legal && actingSeat && (
            <div className="action-bar">
              <div className="seat-sub" style={{ marginBottom: "8px" }}>
                {isMyTurn
                  ? `Your Action (Seat ${actingSeat.seatNumber})`
                  : `Host Proxy Action · Seat ${actingSeat.seatNumber} (${actingSeat.displayName})`}
              </div>

              {shortAllInLocked && (
                <div className="seat-sub" style={{ color: "var(--warn)", marginBottom: "8px" }}>
                  Short All-In did not reopen raising — Fold or Call only.
                </div>
              )}

              {(legal.canBet || legal.canRaise) &&
                minWager !== null &&
                maxWager !== null &&
                quickPresets !== null && (
                  <div className="wager-controls">
                    <div className="pill-row" style={{ marginBottom: "8px" }}>
                      {(
                        [
                          { label: "Min", value: quickPresets.min },
                          { label: "½ Pot", value: quickPresets.halfPot },
                          { label: "Pot", value: quickPresets.pot },
                          { label: "All-In", value: quickPresets.allIn },
                        ] as const
                      ).map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={submitting}
                          onClick={() => setWagerText(String(preset.value))}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
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
                          step={1}
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
                        step={1}
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

          {hand.status === "SHOWDOWN" && hand.pots.length > 0 && (
            <div className="pot-list">
              {hand.pots.map((pot) => {
                const isResolved = pot.winnerSeatNumbers !== null;
                const isAutoAwarded = isResolved && pot.eligibleSeatNumbers.length === 1;
                const potAwards = (hand.result?.awards ?? []).filter((a) => a.potId === pot.id);

                if (isResolved) {
                  return (
                    <div key={pot.id} className="pot-card">
                      <div
                        className="seat-title"
                        style={{ justifyContent: "space-between", width: "100%" }}
                      >
                        <span>
                          {pot.label} · {pot.amountChips} Chips
                        </span>
                        <span className="pill pill-live">
                          {isAutoAwarded ? "Auto-Awarded" : "Awarded"}
                        </span>
                      </div>
                      <div className="seat-sub">
                        Eligible: {formatEligibleSeatList(pot.eligibleSeatNumbers, hand.seats)}
                      </div>
                      <div className="seat-sub" style={{ color: "var(--accent)" }}>
                        {isAutoAwarded
                          ? `Auto-awarded +${pot.amountChips} Chips to ${formatEligibleSeatList(pot.winnerSeatNumbers ?? [], hand.seats)}`
                          : potAwards.length > 0
                            ? potAwards
                                .map(
                                  (a) =>
                                    `Seat ${a.seatNumber} (${a.displayName}) +${a.amountChips} Chips${a.oddChips > 0 ? ` (includes ${a.oddChips} odd Chip(s))` : ""}`,
                                )
                                .join(" · ")
                            : `Winner(s): ${formatEligibleSeatList(pot.winnerSeatNumbers ?? [], hand.seats)}`}
                      </div>
                    </div>
                  );
                }

                const selected = selectedWinnersByPot[pot.id] ?? [];
                const orderedContenders = [...pot.eligibleSeatNumbers]
                  .sort(
                    (a, b) =>
                      clockwiseLeftOfButtonOffset(
                        a,
                        hand.buttonSeatNumber,
                        session.config.seatCount,
                      ) -
                      clockwiseLeftOfButtonOffset(
                        b,
                        hand.buttonSeatNumber,
                        session.config.seatCount,
                      ),
                  )
                  .map((seatNumber) => hand.seats.find((s) => s.seatNumber === seatNumber))
                  .filter((s): s is NonNullable<typeof s> => s !== undefined);

                const splitPreview =
                  selected.length > 0
                    ? computePotSplitAwards({
                        potAmountChips: pot.amountChips,
                        winnerSeatNumbers: selected,
                        buttonSeatNumber: hand.buttonSeatNumber,
                        seatCount: session.config.seatCount,
                      })
                    : null;

                return (
                  <div key={pot.id} className="action-bar">
                    <div className="brand-bar" style={{ marginBottom: "6px" }}>
                      <h4 style={{ margin: 0 }}>
                        {pot.label} · {pot.amountChips} Chips
                      </h4>
                      <span className="pill pill-warn">Select Winner(s)</span>
                    </div>
                    <div className="seat-sub" style={{ marginBottom: "8px" }}>
                      Eligible: {formatEligibleSeatList(pot.eligibleSeatNumbers, hand.seats)}
                    </div>
                    {viewer.isHost ? (
                      <>
                        <div className="seat-sub" style={{ marginBottom: "8px" }}>
                          Tap one Seat to award this Pot, or multiple Seats to split (any odd Chip
                          goes clockwise left of Button Seat {hand.buttonSeatNumber}).
                        </div>
                        <div className="seat-list" style={{ marginBottom: "10px" }}>
                          {orderedContenders.map((contender) => {
                            const checked = selected.includes(contender.seatNumber);
                            const payout = splitPreview?.get(contender.seatNumber);
                            return (
                              <button
                                key={contender.seatNumber}
                                type="button"
                                aria-pressed={checked}
                                className={`seat-card showdown-option ${checked ? "seat-acting" : ""}`}
                                onClick={() => toggleWinnerSeat(pot.id, contender.seatNumber)}
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
                                        ? ` (includes ${payout.oddChips} odd Chip(s))`
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
                          disabled={submitting || selected.length === 0}
                          onClick={() => void handleResolveShowdown(pot)}
                        >
                          {selected.length > 1
                            ? `Split ${pot.label} (${selected.length} ways)`
                            : `Award ${pot.label} (${pot.amountChips} Chips)`}
                        </button>
                      </>
                    ) : (
                      <div className="seat-sub">
                        Waiting for Host to select the Showdown winner(s) for {pot.label}.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
