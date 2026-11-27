import { useState } from "react";
import type { SessionSnapshot, ViewerIdentity } from "../shared/session.ts";
import { loadSessionTokens, sessionApi } from "./api.ts";

function formatSignedChips(chips: number): string {
  return chips > 0 ? `+${chips}` : String(chips);
}

export function LeaderboardPanel({
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
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);

  const isEnded = session.status === "SETTLED";
  const { leaderboard } = session;

  async function handleEndGame(): Promise<void> {
    onError(null);
    setEnding(true);
    try {
      const res = await sessionApi.endGame(session.code, loadSessionTokens(session.code));
      setConfirmingEnd(false);
      onSessionUpdate(res.session);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to end game.");
    } finally {
      setEnding(false);
    }
  }

  if (leaderboard.entries.length === 0 && !viewer.isHost) {
    return null;
  }

  return (
    <div className="card">
      <div className="brand-bar" style={{ marginBottom: "10px" }}>
        <h3 style={{ margin: 0 }}>
          {isEnded ? "Final Chip Leaderboard" : "Chip Leaderboard"}
        </h3>
        {isEnded && <span className="pill pill-warn">Game Ended</span>}
      </div>

      {leaderboard.entries.length === 0 ? (
        <div className="seat-sub" style={{ marginBottom: viewer.isHost ? "12px" : 0 }}>
          No Players seated yet.
        </div>
      ) : (
        <div className="seat-list" style={{ marginBottom: !isEnded && viewer.isHost ? "12px" : 0 }}>
          {leaderboard.entries.map((entry, idx) => {
            const netClass =
              entry.netChips > 0
                ? "net-positive"
                : entry.netChips < 0
                  ? "net-negative"
                  : "";
            return (
              <div key={`${entry.participantId}-${entry.seatNumber}`} className="seat-card">
                <div className="seat-meta">
                  <div className="seat-title">
                    <span>
                      #{idx + 1} · {entry.displayName}
                    </span>
                    <span className="pill">Seat {entry.seatNumber}</span>
                    {entry.status === "LEFT" && <span className="pill pill-warn">Left</span>}
                    {entry.rebuyCount > 0 && (
                      <span className="pill">
                        {entry.rebuyCount} {entry.rebuyCount === 1 ? "Rebuy" : "Rebuys"}
                      </span>
                    )}
                  </div>
                  <div className="seat-sub">
                    {entry.chips} Chips · Issued {entry.totalIssuedChips} Chips
                  </div>
                </div>
                <strong className={netClass}>{formatSignedChips(entry.netChips)} Chips</strong>
              </div>
            );
          })}
        </div>
      )}

      {!isEnded && viewer.isHost && (
        <div>
          {session.handInProgress ? (
            <div className="seat-sub">Finish the active Hand before ending the game.</div>
          ) : confirmingEnd ? (
            <div className="seat-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={ending}
                onClick={() => void handleEndGame()}
              >
                {ending ? "Ending..." : "Confirm End Game"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={ending}
                onClick={() => setConfirmingEnd(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmingEnd(true)}
            >
              End Game
            </button>
          )}
        </div>
      )}
    </div>
  );
}
