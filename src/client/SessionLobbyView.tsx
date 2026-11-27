import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ServerWsMessage } from "../shared/protocol.ts";
import {
  type SessionSnapshot,
  type ViewerIdentity,
} from "../shared/session.ts";
import { loadSessionTokens, saveSeatToken, sessionApi } from "./api.ts";
import { HandTablePanel } from "./HandTablePanel.tsx";
import { LeaderboardPanel } from "./LeaderboardPanel.tsx";

function clearSeatTokenIfConfirmedInvalid(
  code: string,
  sentSeatToken: string | null,
  viewer: ViewerIdentity,
): void {
  if (sentSeatToken && viewer.seatNumber === null && loadSessionTokens(code).seatToken === sentSeatToken) {
    saveSeatToken(code, null);
  }
}

export function SessionLobbyView({
  code,
  onLeaveToHome,
}: {
  code: string;
  onLeaveToHome: () => void;
}) {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [viewer, setViewer] = useState<ViewerIdentity>({
    isHost: false,
    seatNumber: null,
    playerId: null,
  });
  const [wsState, setWsState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(true);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [claimingSeat, setClaimingSeat] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const subscribedSeatTokenRef = useRef<string | null>(null);

  const syncSocketSubscription = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const tokens = loadSessionTokens(code);
    subscribedSeatTokenRef.current = tokens.seatToken;
    socket.send(
      JSON.stringify({
        type: "subscribe",
        code,
        hostToken: tokens.hostToken,
        seatToken: tokens.seatToken,
      }),
    );
  }, [code]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap(): Promise<void> {
      setError(null);
      try {
        const tokens = loadSessionTokens(code);
        const data = await sessionApi.getSession(code, tokens);
        if (cancelled) return;
        clearSeatTokenIfConfirmedInvalid(code, tokens.seatToken, data.viewer);
        setSession(data.session);
        setShareUrl(data.shareUrl);
        setQrDataUrl(data.qrCodeDataUrl);
        setViewer(data.viewer);
        syncSocketSubscription();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load Session.");
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [code, syncSocketSubscription]);

  useEffect(() => {
    let closedByEffect = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;

    function connect(): void {
      if (closedByEffect) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setWsState("live");
        syncSocketSubscription();
      });
      socket.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data)) as ServerWsMessage;
        if (msg.type === "snapshot") {
          clearSeatTokenIfConfirmedInvalid(code, subscribedSeatTokenRef.current, msg.viewer);
          setSession(msg.session);
          setViewer(msg.viewer);
        } else if (msg.type === "error") {
          setError(msg.error);
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        if (closedByEffect) return;
        setWsState("reconnecting");
        retryTimer = window.setTimeout(connect, 1200);
      });
    }

    connect();
    return () => {
      closedByEffect = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, [code, syncSocketSubscription]);

  async function copyText(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLabel(label);
      window.setTimeout(() => setCopiedLabel(null), 1500);
    } catch {
      setCopiedLabel("Copy failed");
    }
  }

  async function handleClaimSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (claimingSeat === null) return;
    setError(null);
    try {
      const claimed = await sessionApi.claimSeat(code, {
        seatNumber: claimingSeat,
        displayName,
      });
      saveSeatToken(code, claimed.seatToken);
      setClaimingSeat(null);
      setDisplayName("");
      setSession(claimed.session);
      setViewer((prev) => ({
        ...prev,
        seatNumber: claimed.seatNumber,
        playerId: claimed.playerId,
      }));
      syncSocketSubscription();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to claim Seat.");
    }
  }

  async function handleReleaseSeat(seatNumber: number): Promise<void> {
    setError(null);
    try {
      const res = await sessionApi.releaseSeat(code, seatNumber, loadSessionTokens(code));
      setSession(res.session);
      if (viewer.seatNumber === seatNumber) {
        saveSeatToken(code, null);
        setViewer((prev) => ({ ...prev, seatNumber: null, playerId: null }));
        syncSocketSubscription();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove Seat.");
    }
  }

  async function handleLeaveSeat(seatNumber: number): Promise<void> {
    setError(null);
    try {
      const res = await sessionApi.leaveSeat(code, seatNumber, loadSessionTokens(code));
      setSession(res.session);
      saveSeatToken(code, null);
      setViewer((prev) => ({ ...prev, seatNumber: null, playerId: null }));
      syncSocketSubscription();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to leave Seat.");
    }
  }

  async function handleRebuySeat(seatNumber: number): Promise<void> {
    setError(null);
    try {
      const res = await sessionApi.rebuySeat(code, seatNumber, loadSessionTokens(code));
      setSession(res.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to Rebuy.");
    }
  }

  async function handleToggleSitOut(seatNumber: number, isSittingOut: boolean): Promise<void> {
    setError(null);
    try {
      const res = await sessionApi.setSitOut(
        code,
        seatNumber,
        { isSittingOut },
        loadSessionTokens(code),
      );
      setSession(res.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update Sit Out status.");
    }
  }

  if (!session) {
    return (
      <div className="card">
        {error ? <div className="error-banner">{error}</div> : <p>Loading Session {code}...</p>}
        <button type="button" className="btn btn-secondary" onClick={onLeaveToHome}>
          Back to Home
        </button>
      </div>
    );
  }

  const leaderboardSection = (
    <LeaderboardPanel
      session={session}
      viewer={viewer}
      onSessionUpdate={setSession}
      onError={setError}
    />
  );

  return (
    <>
      <div className="card">
        <div className="brand-bar" style={{ marginBottom: "10px" }}>
          <div>
            <h2 style={{ marginBottom: "4px" }}>Session {session.code}</h2>
            <div className="pill-row">
              <span className={`pill ${wsState === "live" ? "pill-live" : "pill-warn"}`}>
                <span className="dot" />
                {wsState === "live" ? "Live Sync" : "Reconnecting"}
              </span>
              {viewer.isHost && <span className="pill pill-live">Host</span>}
              {viewer.seatNumber !== null && (
                <span className="pill pill-live">Seat {viewer.seatNumber}</span>
              )}
              {session.status === "SETTLED" && <span className="pill pill-warn">Game Ended</span>}
            </div>
          </div>
          <div className="seat-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowInvite((v) => !v)}
            >
              {showInvite ? "Hide QR" : "Invite QR"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onLeaveToHome}>
              Home
            </button>
          </div>
        </div>

        <div className="pill-row">
          <span className="pill">
            Stack {session.config.startingStackChips} Chips
          </span>
          <span className="pill">
            Blinds {session.config.smallBlind}/{session.config.bigBlind}
          </span>
        </div>

        {showInvite && (
          <div className="qr-box">
            {qrDataUrl && <img src={qrDataUrl} alt={`QR code for Session ${session.code}`} />}
            <div className="mono-link">{shareUrl}</div>
            <div className="seat-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void copyText(shareUrl, "share")}
              >
                {copiedLabel === "share" ? "Copied Link!" : "Copy Invite Link"}
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {session.status === "ACTIVE" && claimingSeat !== null && (
        <div className="card">
          <h3>Claim Seat {claimingSeat}</h3>
          <form onSubmit={handleClaimSubmit}>
            <div className="field">
              <label htmlFor="player-name">Display Name</label>
              <input
                id="player-name"
                type="text"
                maxLength={30}
                placeholder="Your table name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="seat-actions">
              <button type="submit" className="btn btn-primary">
                Take Seat {claimingSeat}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setClaimingSeat(null);
                  setDisplayName("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {session.status === "SETTLED" && leaderboardSection}

      {session.status === "ACTIVE" && (
        <HandTablePanel
          session={session}
          viewer={viewer}
          onSessionUpdate={setSession}
          onError={setError}
        />
      )}

      <div className="card">
        <h3>Seats ({session.config.seatCount})</h3>
        <div className="seat-list">
          {session.seats.map((seat) => {
            const isMine = viewer.seatNumber === seat.seatNumber;
            const isSessionActive = session.status === "ACTIVE";
            const activeHand = session.handInProgress ? session.hand : null;
            const isActing =
              activeHand !== null &&
              activeHand.status === "BETTING" &&
              activeHand.actingSeatNumber === seat.seatNumber;
            const activeHandSeat =
              activeHand?.seats.find((s) => s.seatNumber === seat.seatNumber) ?? null;
            const inActiveHand = activeHandSeat !== null;
            const releaseBlocked = inActiveHand;
            return (
              <div
                key={seat.seatNumber}
                className={`seat-card ${isActing ? "seat-acting" : ""} ${isMine ? "seat-mine" : ""}`}
              >
                <div className="seat-meta">
                  <div className="seat-title">
                    <span>Seat {seat.seatNumber}</span>
                    {seat.occupant ? (
                      <>
                        <span>· {seat.occupant.displayName}</span>
                        {isMine && <span className="pill pill-live">You</span>}
                        {seat.occupant.isSittingOut && (
                          <span className="pill pill-warn">Sitting Out</span>
                        )}
                        {activeHand?.buttonSeatNumber === seat.seatNumber && (
                          <span className="pill">BTN</span>
                        )}
                        {activeHand?.sbSeatNumber === seat.seatNumber && (
                          <span className="pill">SB</span>
                        )}
                        {activeHand?.bbSeatNumber === seat.seatNumber && (
                          <span className="pill">BB</span>
                        )}
                        {isActing && <span className="pill pill-live">Acting</span>}
                        {activeHandSeat?.hasFolded && <span className="pill">Folded</span>}
                        {activeHandSeat?.isAllIn && <span className="pill pill-warn">All-In</span>}
                      </>
                    ) : (
                      <span className="seat-sub">· Open</span>
                    )}
                  </div>
                  {seat.occupant && (
                    <div className="seat-sub">
                      {seat.occupant.chips} Chips
                      {activeHandSeat && activeHandSeat.streetCommittedChips > 0
                        ? ` · Street Bet: ${activeHandSeat.streetCommittedChips} Chips`
                        : ""}
                      {" · "}
                      {seat.occupant.isConnected ? "Connected" : "Offline"}
                    </div>
                  )}
                </div>

                {isSessionActive && (
                  <div className="seat-actions">
                    {!seat.occupant && viewer.seatNumber === null && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setClaimingSeat(seat.seatNumber)}
                      >
                        Claim
                      </button>
                    )}
                    {seat.occupant && (isMine || viewer.isHost) && seat.occupant.chips === 0 && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={session.handInProgress}
                        title={
                          session.handInProgress
                            ? "Rebuy is only allowed between Hands."
                            : `Rebuy ${session.config.startingStackChips} Chips`
                        }
                        onClick={() => void handleRebuySeat(seat.seatNumber)}
                      >
                        Rebuy
                      </button>
                    )}
                    {seat.occupant && (isMine || viewer.isHost) && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={session.handInProgress}
                        title={
                          session.handInProgress
                            ? "Sit Out can only be changed between Hands."
                            : seat.occupant.isSittingOut
                              ? "Return to active play"
                              : "Sit Out next Hand"
                        }
                        onClick={() =>
                          void handleToggleSitOut(seat.seatNumber, !seat.occupant!.isSittingOut)
                        }
                      >
                        {seat.occupant.isSittingOut ? "Return to Play" : "Sit Out"}
                      </button>
                    )}
                    {seat.occupant && isMine && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={session.handInProgress}
                        title={
                          session.handInProgress
                            ? "Leave Seat is only allowed between Hands."
                            : "Leave Seat"
                        }
                        onClick={() => void handleLeaveSeat(seat.seatNumber)}
                      >
                        Leave
                      </button>
                    )}
                    {seat.occupant && viewer.isHost && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={releaseBlocked || session.handInProgress}
                        title={
                          releaseBlocked || session.handInProgress
                            ? "Cannot remove a Seat while a Hand is in progress"
                            : "Remove Player from Seat"
                        }
                        onClick={() => void handleReleaseSeat(seat.seatNumber)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {session.status === "ACTIVE" && leaderboardSection}
    </>
  );
}
