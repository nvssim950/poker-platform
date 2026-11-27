import { useState, type FormEvent } from "react";
import { normalizeSessionCode } from "../shared/session.ts";
import { saveHostToken, sessionApi } from "./api.ts";

const TABLE_PRESETS = [
  { label: "Casual (1,000 · 10/20)", startingStackChips: 1000, smallBlind: 10, bigBlind: 20 },
  { label: "Short (500 · 5/10)", startingStackChips: 500, smallBlind: 5, bigBlind: 10 },
  { label: "Deep (2,000 · 10/20)", startingStackChips: 2000, smallBlind: 10, bigBlind: 20 },
] as const;

export function CreateSessionView({
  onOpenSession,
}: {
  onOpenSession: (code: string) => void;
}) {
  const [joinCode, setJoinCode] = useState("");
  const [seatCount, setSeatCount] = useState("8");
  const [startingStackChips, setStartingStackChips] = useState("1000");
  const [smallBlind, setSmallBlind] = useState("10");
  const [bigBlind, setBigBlind] = useState("20");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function applyPreset(preset: (typeof TABLE_PRESETS)[number]): void {
    setStartingStackChips(String(preset.startingStackChips));
    setSmallBlind(String(preset.smallBlind));
    setBigBlind(String(preset.bigBlind));
  }

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await sessionApi.createSession({
        seatCount: Number(seatCount),
        startingStackChips: Number(startingStackChips),
        smallBlind: Number(smallBlind),
        bigBlind: Number(bigBlind),
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
        <div className="pill-row" style={{ marginBottom: "12px" }}>
          {TABLE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ width: "auto" }}
              onClick={() => applyPreset(preset)}
            >
              {preset.label}
            </button>
          ))}
        </div>
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
              <label htmlFor="starting-stack">Starting Stack (Chips)</label>
              <input
                id="starting-stack"
                type="number"
                min={1}
                value={startingStackChips}
                onChange={(e) => setStartingStackChips(e.target.value)}
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
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Creating Session..." : "Open Session"}
          </button>
        </form>
      </div>
    </>
  );
}
