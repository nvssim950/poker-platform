import { useState, type FormEvent } from "react";
import { normalizeSessionCode, type AnteMode } from "../shared/session.ts";
import { saveHostToken, sessionApi } from "./api.ts";

export function CreateSessionView({
  onOpenSession,
}: {
  onOpenSession: (code: string) => void;
}) {
  const [joinCode, setJoinCode] = useState("");
  const [seatCount, setSeatCount] = useState("8");
  const [smallBlind, setSmallBlind] = useState("10");
  const [bigBlind, setBigBlind] = useState("20");
  const [smallestChipStep, setSmallestChipStep] = useState("5");
  const [currencySymbol, setCurrencySymbol] = useState("$");
  const [rateChips, setRateChips] = useState("100");
  const [rateCashDecimal, setRateCashDecimal] = useState("1.00");
  const [minBuyIn, setMinBuyIn] = useState("500");
  const [maxBuyIn, setMaxBuyIn] = useState("2000");
  const [anteMode, setAnteMode] = useState<AnteMode>("NONE");
  const [anteChips, setAnteChips] = useState("0");
  const [allowStraddle, setAllowStraddle] = useState(false);
  const [allowRunItTwice, setAllowRunItTwice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const parsedCashMinor = Math.round(Number(rateCashDecimal) * 100);
    if (!Number.isFinite(parsedCashMinor) || parsedCashMinor < 1) {
      setError("Cash exchange amount must be at least 0.01.");
      return;
    }

    setSubmitting(true);
    try {
      const created = await sessionApi.createSession({
        seatCount: Number(seatCount),
        smallBlind: Number(smallBlind),
        bigBlind: Number(bigBlind),
        smallestChipStep: Number(smallestChipStep),
        currencySymbol,
        exchangeRateChips: Number(rateChips),
        exchangeRateCashMinor: parsedCashMinor,
        minBuyInChips: minBuyIn.trim() ? Number(minBuyIn) : null,
        maxBuyInChips: maxBuyIn.trim() ? Number(maxBuyIn) : null,
        anteMode,
        anteChips: anteMode === "NONE" ? 0 : Number(anteChips),
        allowStraddle,
        allowRunItTwice,
      });
      saveHostToken(created.session.code, created.hostToken);
      onOpenSession(created.session.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create Session.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleJoinSubmit(e: FormEvent): void {
    e.preventDefault();
    const cleaned = normalizeSessionCode(joinCode);
    if (!cleaned) {
      return;
    }
    onOpenSession(cleaned);
  }

  return (
    <>
      <div className="card">
        <h2>Join Existing Session</h2>
        <form onSubmit={handleJoinSubmit} className="inline-row">
          <input
            aria-label="Session code"
            placeholder="Enter code (e.g. A7K9P2)"
            value={joinCode}
            onChange={(e) => setJoinCode(normalizeSessionCode(e.target.value))}
            maxLength={10}
            style={{
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: "10px",
              padding: "10px 12px",
              fontSize: "1rem",
            }}
          />
          <button type="submit" className="btn btn-secondary">
            Join
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Create New Session (Host)</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={handleCreate}>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="seat-count">Seats (2–10)</label>
              <select
                id="seat-count"
                value={seatCount}
                onChange={(e) => setSeatCount(e.target.value)}
              >
                {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} Seats
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="chip-step">Smallest Chip Step</label>
              <input
                id="chip-step"
                type="number"
                min={1}
                value={smallestChipStep}
                onChange={(e) => setSmallestChipStep(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="sb">Small Blind (Chips)</label>
              <input
                id="sb"
                type="number"
                min={1}
                value={smallBlind}
                onChange={(e) => setSmallBlind(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="bb">Big Blind (Chips)</label>
              <input
                id="bb"
                type="number"
                min={1}
                value={bigBlind}
                onChange={(e) => setBigBlind(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="rate-chips">Exchange Rate: Chips</label>
              <input
                id="rate-chips"
                type="number"
                min={1}
                value={rateChips}
                onChange={(e) => setRateChips(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="rate-cash">Equals Cash ({currencySymbol || "$"})</label>
              <input
                id="rate-cash"
                type="number"
                min="0.01"
                step="0.01"
                value={rateCashDecimal}
                onChange={(e) => setRateCashDecimal(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="currency">Currency Symbol</label>
              <input
                id="currency"
                type="text"
                maxLength={8}
                value={currencySymbol}
                onChange={(e) => setCurrencySymbol(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="min-buyin">Min Buy-In (optional)</label>
              <input
                id="min-buyin"
                type="number"
                min={1}
                placeholder="None"
                value={minBuyIn}
                onChange={(e) => setMinBuyIn(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="max-buyin">Max Buy-In (optional)</label>
              <input
                id="max-buyin"
                type="number"
                min={1}
                placeholder="None"
                value={maxBuyIn}
                onChange={(e) => setMaxBuyIn(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ante-mode">Ante Rule</label>
              <select
                id="ante-mode"
                value={anteMode}
                onChange={(e) => {
                  const next = e.target.value as AnteMode;
                  setAnteMode(next);
                  if (next === "NONE") {
                    setAnteChips("0");
                  } else if (Number(anteChips) <= 0 || !Number.isFinite(Number(anteChips))) {
                    setAnteChips(next === "BIG_BLIND_ANTE" ? bigBlind : smallestChipStep);
                  }
                }}
              >
                <option value="NONE">Off (No Ante)</option>
                <option value="PER_SEAT">Every-Seat Ante</option>
                <option value="BIG_BLIND_ANTE">Big Blind Ante</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ante-chips">Ante (Chips)</label>
              <input
                id="ante-chips"
                type="number"
                min={anteMode === "NONE" ? 0 : 1}
                disabled={anteMode === "NONE"}
                value={anteMode === "NONE" ? "0" : anteChips}
                onChange={(e) => setAnteChips(e.target.value)}
              />
            </div>
          </div>
          <div className="toggle-list">
            <label className="toggle-row" htmlFor="allow-straddle">
              <input
                id="allow-straddle"
                type="checkbox"
                checked={allowStraddle}
                onChange={(e) => setAllowStraddle(e.target.checked)}
              />
              <span>Allow voluntary UTG Straddle (2× Big Blind)</span>
            </label>
            <label className="toggle-row" htmlFor="allow-rit">
              <input
                id="allow-rit"
                type="checkbox"
                checked={allowRunItTwice}
                onChange={(e) => setAllowRunItTwice(e.target.checked)}
              />
              <span>Allow Run It Twice on all-in Showdowns</span>
            </label>
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Creating Session..." : "Open Session"}
          </button>
        </form>
      </div>
    </>
  );
}
