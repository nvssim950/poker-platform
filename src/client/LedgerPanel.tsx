import { useEffect, useState, type FormEvent } from "react";
import {
  formatChipsAsCash,
  getAvailableFundingForSeat,
  validateFundingOperation,
  type AvailableFundingOption,
  type FundingKind,
  type SeatOccupant,
  type SessionConfig,
  type SessionSnapshot,
  type ViewerIdentity,
} from "../shared/session.ts";
import { loadSessionTokens, sessionApi } from "./api.ts";

const FUNDING_LABELS: Record<FundingKind, string> = {
  BUY_IN: "Buy-In",
  REBUY: "Rebuy",
  TOP_UP: "Top-Up",
};

function defaultAmountForOption(option: AvailableFundingOption): string {
  if (option.disabledReason !== null) {
    return "";
  }
  const initial =
    option.maxAmountChips !== null
      ? Math.min(option.minAmountChips, option.maxAmountChips)
      : option.minAmountChips;
  return String(initial);
}

interface FundingAmountFieldsProps {
  idPrefix: string;
  config: SessionConfig;
  occupant: SeatOccupant;
  handInProgress: boolean;
  option: AvailableFundingOption;
  amountText: string;
  onAmountChange: (value: string) => void;
  submitLabel: string;
  submitting: boolean;
}

function FundingAmountFields({
  idPrefix,
  config,
  occupant,
  handInProgress,
  option,
  amountText,
  onAmountChange,
  submitLabel,
  submitting,
}: FundingAmountFieldsProps) {
  const parsedAmount = Number(amountText);
  const validation = validateFundingOperation(
    { kind: option.kind, amountChips: parsedAmount },
    {
      config,
      chips: occupant.chips,
      totalBuyInChips: occupant.totalBuyInChips,
      handInProgress,
    },
  );

  const hasBoundedSlider =
    option.disabledReason === null &&
    option.maxAmountChips !== null &&
    option.maxAmountChips >= option.minAmountChips;

  const cashPreview =
    Number.isInteger(parsedAmount) && parsedAmount > 0
      ? formatChipsAsCash(parsedAmount, config)
      : formatChipsAsCash(0, config);

  return (
    <>
      <div className="pill-row" style={{ marginBottom: "10px" }}>
        <span className="pill">{option.label}</span>
        <span className="pill">
          Min {option.minAmountChips} · Max {option.maxAmountChips ?? "∞"} · Step{" "}
          {config.smallestChipStep}
        </span>
      </div>

      {option.disabledReason ? (
        <div className="seat-sub">{option.disabledReason}</div>
      ) : (
        <>
          {hasBoundedSlider && option.maxAmountChips !== null && (
            <div className="field">
              <label htmlFor={`${idPrefix}-slider`}>Adjust {option.label} (Chips)</label>
              <input
                id={`${idPrefix}-slider`}
                className="chip-slider"
                type="range"
                min={option.minAmountChips}
                max={option.maxAmountChips}
                step={config.smallestChipStep}
                value={
                  Number.isFinite(parsedAmount)
                    ? Math.min(
                        option.maxAmountChips,
                        Math.max(option.minAmountChips, parsedAmount),
                      )
                    : option.minAmountChips
                }
                onChange={(e) => onAmountChange(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor={`${idPrefix}-amount`}>
              {option.label} Amount (Chips) · Cash: {cashPreview}
            </label>
            <input
              id={`${idPrefix}-amount`}
              type="number"
              inputMode="numeric"
              min={option.minAmountChips}
              max={option.maxAmountChips ?? undefined}
              step={config.smallestChipStep}
              value={amountText}
              onChange={(e) => onAmountChange(e.target.value)}
            />
          </div>

          {!validation.ok && amountText.trim().length > 0 && (
            <div className="seat-sub" style={{ color: "var(--warn)", marginBottom: "8px" }}>
              {validation.error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !validation.ok}
          >
            {submitting ? "Submitting..." : submitLabel}
          </button>
        </>
      )}
    </>
  );
}

export function LedgerPanel({
  session,
  viewer,
  selectedHostSeat,
  onSelectHostSeat,
  onSessionUpdate,
  onError,
}: {
  session: SessionSnapshot;
  viewer: ViewerIdentity;
  selectedHostSeat: number | null;
  onSelectHostSeat: (seatNumber: number) => void;
  onSessionUpdate: (updated: SessionSnapshot) => void;
  onError: (message: string | null) => void;
}) {
  const occupiedSeats = session.seats.filter(
    (s): s is { seatNumber: number; occupant: SeatOccupant } => s.occupant !== null,
  );

  const mySeat =
    viewer.seatNumber !== null
      ? occupiedSeats.find((s) => s.seatNumber === viewer.seatNumber) ?? null
      : null;

  const myOption = mySeat
    ? getAvailableFundingForSeat({
        config: session.config,
        chips: mySeat.occupant.chips,
        totalBuyInChips: mySeat.occupant.totalBuyInChips,
        handInProgress: session.handInProgress,
      })
    : null;

  const activeHostSeat =
    occupiedSeats.find((s) => s.seatNumber === selectedHostSeat) ?? occupiedSeats[0] ?? null;

  const hostOption = activeHostSeat
    ? getAvailableFundingForSeat({
        config: session.config,
        chips: activeHostSeat.occupant.chips,
        totalBuyInChips: activeHostSeat.occupant.totalBuyInChips,
        handInProgress: session.handInProgress,
      })
    : null;

  const [playerAmount, setPlayerAmount] = useState("");
  const [hostAmount, setHostAmount] = useState("");
  const [submittingPlayer, setSubmittingPlayer] = useState(false);
  const [submittingHost, setSubmittingHost] = useState(false);
  const [submittingCashOut, setSubmittingCashOut] = useState(false);
  const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (myOption) {
      setPlayerAmount(defaultAmountForOption(myOption));
    }
  }, [
    mySeat?.seatNumber,
    myOption?.kind,
    myOption?.minAmountChips,
    myOption?.maxAmountChips,
    myOption?.disabledReason,
  ]);

  useEffect(() => {
    if (hostOption) {
      setHostAmount(defaultAmountForOption(hostOption));
    }
  }, [
    activeHostSeat?.seatNumber,
    hostOption?.kind,
    hostOption?.minAmountChips,
    hostOption?.maxAmountChips,
    hostOption?.disabledReason,
  ]);

  async function handlePlayerRequestSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!mySeat || !myOption || myOption.disabledReason) return;
    onError(null);
    setSubmittingPlayer(true);
    try {
      const res = await sessionApi.createBuyInRequest(
        session.code,
        { kind: myOption.kind, amountChips: Number(playerAmount) },
        loadSessionTokens(session.code),
      );
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to submit Buy-In request.");
    } finally {
      setSubmittingPlayer(false);
    }
  }

  async function handleHostResolve(
    requestId: string,
    decision: "approve" | "reject",
  ): Promise<void> {
    onError(null);
    setResolvingRequestId(requestId);
    try {
      const tokens = loadSessionTokens(session.code);
      const res =
        decision === "approve"
          ? await sessionApi.approveBuyInRequest(session.code, requestId, tokens)
          : await sessionApi.rejectBuyInRequest(session.code, requestId, tokens);
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : `Unable to ${decision} request.`);
    } finally {
      setResolvingRequestId(null);
    }
  }

  async function handleHostResolveCashOut(
    requestId: string,
    decision: "approve" | "reject",
  ): Promise<void> {
    onError(null);
    setResolvingRequestId(requestId);
    try {
      const tokens = loadSessionTokens(session.code);
      const res =
        decision === "approve"
          ? await sessionApi.approveCashOutRequest(session.code, requestId, tokens)
          : await sessionApi.rejectCashOutRequest(session.code, requestId, tokens);
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : `Unable to ${decision} Cash-Out request.`);
    } finally {
      setResolvingRequestId(null);
    }
  }

  async function handleRequestCashOut(): Promise<void> {
    if (!mySeat) return;
    onError(null);
    setSubmittingCashOut(true);
    try {
      const res = await sessionApi.createCashOutRequest(
        session.code,
        {},
        loadSessionTokens(session.code),
      );
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to request Cash-Out.");
    } finally {
      setSubmittingCashOut(false);
    }
  }

  async function handleHostDirectSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!activeHostSeat || !hostOption || hostOption.disabledReason) return;
    onError(null);
    setSubmittingHost(true);
    try {
      const res = await sessionApi.recordDirectLedger(
        session.code,
        activeHostSeat.seatNumber,
        { kind: hostOption.kind, amountChips: Number(hostAmount) },
        loadSessionTokens(session.code),
      );
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to record Chips on ledger.");
    } finally {
      setSubmittingHost(false);
    }
  }

  const isSessionActive = session.status === "ACTIVE";
  const myPendingRequests = mySeat
    ? session.pendingRequests.filter((r) => r.seatNumber === mySeat.seatNumber)
    : [];
  const myPendingCashOut = mySeat
    ? session.pendingCashOutRequests.find((r) => r.seatNumber === mySeat.seatNumber) ?? null
    : null;
  const totalPendingCount =
    session.pendingRequests.length + session.pendingCashOutRequests.length;

  const totalSessionBuyInChips = session.ledgerEntries.reduce(
    (sum, entry) => sum + entry.amountChips,
    0,
  );
  const totalTableChips = occupiedSeats.reduce((sum, s) => sum + s.occupant.chips, 0);
  const totalCashedOutChips = session.cashOuts.reduce(
    (sum, cashOut) => sum + cashOut.endingChips,
    0,
  );

  return (
    <>
      {isSessionActive && viewer.isHost && totalPendingCount > 0 && (
        <div className="card">
          <div className="brand-bar" style={{ marginBottom: "10px" }}>
            <h3 style={{ margin: 0 }}>Pending Requests</h3>
            <span className="pill pill-warn">{totalPendingCount} Pending</span>
          </div>
          <div className="seat-list">
            {session.pendingCashOutRequests.map((req) => (
              <div key={req.id} className="seat-card">
                <div className="seat-meta">
                  <div className="seat-title">
                    <span>Seat {req.seatNumber}</span>
                    <span>· {req.displayName}</span>
                    <span className="pill pill-warn">Cash-Out</span>
                  </div>
                  <div className="seat-sub">
                    Stack: {req.chips} Chips ({formatChipsAsCash(req.chips, session.config)}) ·
                    Buy-Ins: {req.totalBuyInChips} Chips
                  </div>
                </div>
                <div className="seat-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={resolvingRequestId === req.id || session.handInProgress}
                    title={
                      session.handInProgress
                        ? "Cash-Out can only be approved between Hands."
                        : "Approve Cash-Out"
                    }
                    onClick={() => void handleHostResolveCashOut(req.id, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={resolvingRequestId === req.id}
                    onClick={() => void handleHostResolveCashOut(req.id, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
            {session.pendingRequests.map((req) => (
              <div key={req.id} className="seat-card">
                <div className="seat-meta">
                  <div className="seat-title">
                    <span>Seat {req.seatNumber}</span>
                    <span>· {req.displayName}</span>
                  </div>
                  <div className="seat-sub">
                    {FUNDING_LABELS[req.kind]} · {req.amountChips} Chips (
                    {formatChipsAsCash(req.amountChips, session.config)})
                  </div>
                </div>
                <div className="seat-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={resolvingRequestId === req.id}
                    onClick={() => void handleHostResolve(req.id, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={resolvingRequestId === req.id}
                    onClick={() => void handleHostResolve(req.id, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isSessionActive && mySeat && myOption && (
        <div className="card">
          <h3>Your Chips &amp; Buy-In Ledger (Seat {mySeat.seatNumber})</h3>
          <div className="ledger-stats">
            <div className="ledger-stat">
              <span className="seat-sub">Current Stack</span>
              <strong>
                {mySeat.occupant.chips} Chips ({formatChipsAsCash(mySeat.occupant.chips, session.config)})
              </strong>
            </div>
            <div className="ledger-stat">
              <span className="seat-sub">Cash Obligation</span>
              <strong>
                {mySeat.occupant.totalBuyInChips} Chips (
                {formatChipsAsCash(mySeat.occupant.totalBuyInChips, session.config)})
              </strong>
            </div>
          </div>

          {(myPendingRequests.length > 0 || myPendingCashOut) && (
            <div className="seat-list" style={{ marginBottom: "12px" }}>
              {myPendingCashOut && (
                <div className="seat-card">
                  <div className="seat-meta">
                    <div className="seat-title">
                      <span>Pending Cash-Out</span>
                      <span className="pill pill-warn">Awaiting Host</span>
                    </div>
                    <div className="seat-sub">
                      {myPendingCashOut.chips} Chips (
                      {formatChipsAsCash(myPendingCashOut.chips, session.config)})
                    </div>
                  </div>
                </div>
              )}
              {myPendingRequests.map((req) => (
                <div key={req.id} className="seat-card">
                  <div className="seat-meta">
                    <div className="seat-title">
                      <span>Pending {FUNDING_LABELS[req.kind]}</span>
                      <span className="pill pill-warn">Awaiting Host</span>
                    </div>
                    <div className="seat-sub">
                      {req.amountChips} Chips ({formatChipsAsCash(req.amountChips, session.config)})
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handlePlayerRequestSubmit}>
            <FundingAmountFields
              idPrefix="player-funding"
              config={session.config}
              occupant={mySeat.occupant}
              handInProgress={session.handInProgress}
              option={myOption}
              amountText={playerAmount}
              onAmountChange={setPlayerAmount}
              submitLabel={`Request ${myOption.label}`}
              submitting={submittingPlayer}
            />
          </form>

          <div className="cashout-action-row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={submittingCashOut || session.handInProgress || myPendingCashOut !== null}
              onClick={() => void handleRequestCashOut()}
            >
              {submittingCashOut
                ? "Requesting..."
                : myPendingCashOut
                  ? "Cash-Out Requested"
                  : "Request Early Cash-Out"}
            </button>
            {session.handInProgress && (
              <span className="seat-sub">Available between Hands</span>
            )}
          </div>
        </div>
      )}

      {isSessionActive && viewer.isHost && activeHostSeat && hostOption && (
        <div className="card" id="host-ledger-entry">
          <h3>Host Direct Ledger Entry</h3>
          <div className="field">
            <label htmlFor="host-seat-select">Target Seat</label>
            <select
              id="host-seat-select"
              value={activeHostSeat.seatNumber}
              onChange={(e) => onSelectHostSeat(Number(e.target.value))}
            >
              {occupiedSeats.map((s) => (
                <option key={s.seatNumber} value={s.seatNumber}>
                  Seat {s.seatNumber} · {s.occupant.displayName} ({s.occupant.chips} Chips)
                </option>
              ))}
            </select>
          </div>
          <form onSubmit={handleHostDirectSubmit}>
            <FundingAmountFields
              idPrefix="host-funding"
              config={session.config}
              occupant={activeHostSeat.occupant}
              handInProgress={session.handInProgress}
              option={hostOption}
              amountText={hostAmount}
              onAmountChange={setHostAmount}
              submitLabel={`Record ${hostOption.label} for Seat ${activeHostSeat.seatNumber}`}
              submitting={submittingHost}
            />
          </form>
        </div>
      )}

      <div className="card">
        <div className="brand-bar" style={{ marginBottom: "10px" }}>
          <h3 style={{ margin: 0 }}>Session Cash Ledger</h3>
          {session.ledgerEntries.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? "Hide History" : `History (${session.ledgerEntries.length})`}
            </button>
          )}
        </div>

        <div className="ledger-stats" style={{ marginBottom: showHistory ? "12px" : 0 }}>
          <div className="ledger-stat">
            <span className="seat-sub">Total Buy-Ins</span>
            <strong>
              {totalSessionBuyInChips} Chips (
              {formatChipsAsCash(totalSessionBuyInChips, session.config)})
            </strong>
          </div>
          <div className="ledger-stat">
            <span className="seat-sub">Chips on Table</span>
            <strong>
              {totalTableChips} Chips ({formatChipsAsCash(totalTableChips, session.config)})
            </strong>
          </div>
          {session.cashOuts.length > 0 && (
            <div className="ledger-stat">
              <span className="seat-sub">Early Cash-Outs</span>
              <strong>
                {totalCashedOutChips} Chips (
                {formatChipsAsCash(totalCashedOutChips, session.config)})
              </strong>
            </div>
          )}
        </div>

        {isSessionActive && !viewer.isHost && totalPendingCount > 0 && (
          <div className="seat-sub" style={{ marginTop: "8px" }}>
            {totalPendingCount} pending{" "}
            {totalPendingCount === 1 ? "request" : "requests"} awaiting Host approval.
          </div>
        )}

        {showHistory && session.ledgerEntries.length > 0 && (
          <div className="seat-list">
            {[...session.ledgerEntries].reverse().map((entry) => (
              <div key={entry.id} className="seat-card">
                <div className="seat-meta">
                  <div className="seat-title">
                    <span>Seat {entry.seatNumber}</span>
                    <span>· {entry.displayName}</span>
                    <span className="pill">{FUNDING_LABELS[entry.kind]}</span>
                  </div>
                  <div className="seat-sub">
                    +{entry.amountChips} Chips ({formatChipsAsCash(entry.amountChips, session.config)}) ·{" "}
                    {entry.source === "HOST_DIRECT" ? "Host Direct" : "Approved Request"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
