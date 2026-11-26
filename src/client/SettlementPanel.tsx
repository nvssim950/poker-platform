import { useState } from "react";
import {
  chipsToCashMinor,
  formatCashMinor,
  formatChipsAsCash,
  type SessionSnapshot,
  type ViewerIdentity,
} from "../shared/session.ts";
import { formatSettlementTransfer } from "../shared/settlement.ts";
import { loadSessionTokens, sessionApi } from "./api.ts";

function formatSignedCashMinor(minorUnits: number, currencySymbol: string): string {
  const formatted = formatCashMinor(minorUnits, currencySymbol);
  return minorUnits > 0 ? `+${formatted}` : formatted;
}

function formatSignedChips(chips: number): string {
  return chips > 0 ? `+${chips}` : String(chips);
}

export function SettlementPanel({
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
  const [confirmingSettle, setConfirmingSettle] = useState(false);
  const [settling, setSettling] = useState(false);

  async function handleSettleSession(): Promise<void> {
    onError(null);
    setSettling(true);
    try {
      const res = await sessionApi.settleSession(session.code, loadSessionTokens(session.code));
      setConfirmingSettle(false);
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to settle Session.");
    } finally {
      setSettling(false);
    }
  }

  if (session.status === "SETTLED" && session.settlement) {
    const { settlement } = session;
    const currency = session.config.currencySymbol;

    return (
      <div className="card">
        <div className="brand-bar" style={{ marginBottom: "10px" }}>
          <h3 style={{ margin: 0 }}>Session Settlement</h3>
          <div className="pill-row">
            <span className="pill pill-warn">Settled</span>
            <span className={`pill ${settlement.isBalanced ? "pill-live" : "pill-warn"}`}>
              {settlement.isBalanced
                ? "Zero-Sum Balanced"
                : `Chip Discrepancy ${formatSignedChips(settlement.chipDiscrepancy)}`}
            </span>
          </div>
        </div>

        <div className="ledger-stats">
          <div className="ledger-stat">
            <span className="seat-sub">Total Buy-Ins</span>
            <strong>
              {settlement.totalBuyInChips} Chips (
              {formatChipsAsCash(settlement.totalBuyInChips, session.config)})
            </strong>
          </div>
          <div className="ledger-stat">
            <span className="seat-sub">Ending Chips</span>
            <strong>
              {settlement.totalEndingChips} Chips (
              {formatChipsAsCash(settlement.totalEndingChips, session.config)})
            </strong>
          </div>
        </div>

        <h4 className="settlement-subheading">
          Cash Transfers ({settlement.transfers.length})
        </h4>
        {settlement.transfers.length === 0 ? (
          <div className="seat-sub" style={{ marginBottom: "12px" }}>
            No Cash transfers needed — every Player broke even.
          </div>
        ) : (
          <div className="seat-list" style={{ marginBottom: "14px" }}>
            {settlement.transfers.map((transfer) => (
              <div
                key={`${transfer.fromParticipantId}-${transfer.toParticipantId}`}
                className="seat-card settlement-transfer-card"
              >
                <div className="seat-meta">
                  <div className="seat-title">
                    {formatSettlementTransfer(transfer, currency)}
                  </div>
                </div>
                <strong className="net-positive">
                  {formatCashMinor(transfer.amountCashMinor, currency)}
                </strong>
              </div>
            ))}
          </div>
        )}

        <h4 className="settlement-subheading">
          Player Ledger Summary ({settlement.participants.length})
        </h4>
        {settlement.participants.length === 0 ? (
          <div className="seat-sub">No Buy-Ins were recorded in this Session.</div>
        ) : (
          <div className="seat-list">
            {settlement.participants.map((participant) => {
              const netClass =
                participant.netCashMinor > 0
                  ? "net-positive"
                  : participant.netCashMinor < 0
                    ? "net-negative"
                    : "";
              return (
                <div key={participant.participantId} className="seat-card">
                  <div className="seat-meta">
                    <div className="seat-title">
                      <span>{participant.displayName}</span>
                      <span className="pill">Seat {participant.seatNumber}</span>
                      <span
                        className={`pill ${
                          participant.status === "CASHED_OUT" ? "pill-warn" : ""
                        }`}
                      >
                        {participant.status === "CASHED_OUT" ? "Cashed Out Early" : "Settled"}
                      </span>
                    </div>
                    <div className="seat-sub">
                      Buy-In: {participant.totalBuyInChips} Chips · Ending:{" "}
                      {participant.endingChips} Chips · Net:{" "}
                      {formatSignedChips(participant.netChips)} Chips
                    </div>
                  </div>
                  <strong className={netClass}>
                    {formatSignedCashMinor(participant.netCashMinor, currency)}
                  </strong>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {session.cashOuts.length > 0 && (
        <div className="card">
          <div className="brand-bar" style={{ marginBottom: "10px" }}>
            <h3 style={{ margin: 0 }}>Early Cash-Outs ({session.cashOuts.length})</h3>
          </div>
          <div className="seat-list">
            {session.cashOuts.map((cashOut) => {
              const netChips = cashOut.endingChips - cashOut.totalBuyInChips;
              const approxNetMinor = chipsToCashMinor(netChips, session.config);
              return (
                <div key={cashOut.id} className="seat-card">
                  <div className="seat-meta">
                    <div className="seat-title">
                      <span>{cashOut.displayName}</span>
                      <span className="pill">Seat {cashOut.seatNumber}</span>
                      <span className="pill pill-warn">Locked</span>
                    </div>
                    <div className="seat-sub">
                      Ending: {cashOut.endingChips} Chips · Buy-In: {cashOut.totalBuyInChips} Chips
                    </div>
                  </div>
                  <strong
                    className={
                      approxNetMinor > 0
                        ? "net-positive"
                        : approxNetMinor < 0
                          ? "net-negative"
                          : ""
                    }
                  >
                    {formatSignedCashMinor(approxNetMinor, session.config.currencySymbol)}
                  </strong>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewer.isHost && (
        <div className="card">
          <h3>Settle Session</h3>
          <p className="seat-sub" style={{ marginTop: 0, marginBottom: "12px" }}>
            Close the Session between Hands to lock all active Seat stacks and compute final Cash
            transfers.
          </p>
          {session.handInProgress ? (
            <div className="seat-sub">Finish the active Hand before settling the Session.</div>
          ) : confirmingSettle ? (
            <div className="seat-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={settling}
                onClick={() => void handleSettleSession()}
              >
                {settling ? "Settling..." : "Confirm Final Settlement"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={settling}
                onClick={() => setConfirmingSettle(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmingSettle(true)}
            >
              Settle Session
            </button>
          )}
        </div>
      )}
    </>
  );
}
