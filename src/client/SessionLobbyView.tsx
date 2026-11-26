import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ServerWsMessage } from "../shared/protocol.ts";
import {
  formatCashMinor,
  formatChipsAsCash,
  getAvailableFundingForSeat,
  type RelinkSeatResponse,
  type SessionSnapshot,
  type ViewerIdentity,
} from "../shared/session.ts";
import { loadSessionTokens, saveHostToken, saveSeatToken, sessionApi } from "./api.ts";
import { HandTablePanel } from "./HandTablePanel.tsx";
import { LedgerPanel } from "./LedgerPanel.tsx";
import { SettlementPanel } from "./SettlementPanel.tsx";

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
  const [showHostKey, setShowHostKey] = useState(false);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [claimingSeat, setClaimingSeat] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [relinkInfo, setRelinkInfo] = useState<{
    seatNumber: number;
    data: RelinkSeatResponse;
  } | null>(null);
  const [selectedHostSeat, setSelectedHostSeat] = useState<number | null>(null);

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
      const url = new URL(window.location.href);
      const hostParam = url.searchParams.get("host");
      if (hostParam) {
        saveHostToken(code, hostParam);
        url.searchParams.delete("host");
        window.history.replaceState({}, "", url.pathname + url.search);
      }

      const relinkCode = url.searchParams.get("relink");
      if (relinkCode) {
        try {
          const redeemed = await sessionApi.redeemRelink(code, relinkCode);
          saveSeatToken(code, redeemed.seatToken);
          url.searchParams.delete("relink");
          window.history.replaceState({}, "", url.pathname + url.search);
          if (cancelled) return;
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Failed to redeem re-link code.");
        }
      }

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
      if (relinkInfo?.seatNumber === seatNumber) {
        setRelinkInfo(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to release Seat.");
    }
  }

  async function handleRelinkSeat(seatNumber: number): Promise<void> {
    setError(null);
    try {
      const res = await sessionApi.relinkSeat(code, seatNumber, loadSessionTokens(code));
      setSession(res.session);
      setRelinkInfo({ seatNumber, data: res });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to re-link Seat.");
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

  async function handleHostDirectCashOut(seatNumber: number): Promise<void> {
    setError(null);
    try {
      const res = await sessionApi.directCashOut(code, seatNumber, loadSessionTokens(code));
      setSession(res.session);
      if (relinkInfo?.seatNumber === seatNumber) {
        setRelinkInfo(null);
      }
      if (viewer.seatNumber === seatNumber) {
        saveSeatToken(code, null);
        setViewer((prev) => ({ ...prev, seatNumber: null, playerId: null }));
        syncSocketSubscription();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cash out Seat.");
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

  const hostToken = viewer.isHost ? loadSessionTokens(code).hostToken : null;
  const hostRecoveryUrl = hostToken && shareUrl ? `${shareUrl}?host=${encodeURIComponent(hostToken)}` : null;

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
              {session.status === "SETTLED" && <span className="pill pill-warn">Settled</span>}
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
            Blinds {session.config.smallBlind}/{session.config.bigBlind}
          </span>
          <span className="pill">Step {session.config.smallestChipStep}</span>
          <span className="pill">
            {session.config.exchangeRateChips} Chips ={" "}
            {formatCashMinor(
              session.config.exchangeRateCashMinor,
              session.config.currencySymbol,
            )}
          </span>
          {(session.config.minBuyInChips !== null || session.config.maxBuyInChips !== null) && (
            <span className="pill">
              Buy-In {session.config.minBuyInChips ?? "0"}–{session.config.maxBuyInChips ?? "∞"}
            </span>
          )}
          {session.config.anteMode === "PER_SEAT" && session.config.anteChips > 0 && (
            <span className="pill">Ante {session.config.anteChips}/Seat</span>
          )}
          {session.config.anteMode === "BIG_BLIND_ANTE" && session.config.anteChips > 0 && (
            <span className="pill">BB Ante {session.config.anteChips}</span>
          )}
          {session.config.allowStraddle && <span className="pill">Straddle</span>}
          {session.config.allowRunItTwice && <span className="pill">Run It Twice</span>}
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
              {viewer.isHost && hostToken && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowHostKey((v) => !v)}
                >
                  {showHostKey ? "Hide Host Key" : "Host Key"}
                </button>
              )}
            </div>
            {viewer.isHost && showHostKey && hostToken && (
              <div style={{ width: "100%", marginTop: "6px" }}>
                <div className="mono-link" style={{ marginBottom: "6px" }}>
                  Host token: {hostToken}
                </div>
                <div className="seat-actions" style={{ justifyContent: "center" }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void copyText(hostToken, "hostToken")}
                  >
                    {copiedLabel === "hostToken" ? "Copied Token!" : "Copy Host Token"}
                  </button>
                  {hostRecoveryUrl && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void copyText(hostRecoveryUrl, "hostUrl")}
                    >
                      {copiedLabel === "hostUrl" ? "Copied Host Link!" : "Copy Host Link"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {relinkInfo && (
        <div className="card">
          <h3>Re-link Seat {relinkInfo.seatNumber}</h3>
          <p className="seat-sub" style={{ marginTop: 0 }}>
            Previous token revoked. Have the Player scan or open this one-time link:
          </p>
          <div className="qr-box">
            <img
              src={relinkInfo.data.qrCodeDataUrl}
              alt={`Re-link QR code for Seat ${relinkInfo.seatNumber}`}
            />
            <div className="mono-link">{relinkInfo.data.relinkUrl}</div>
            <div className="seat-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void copyText(relinkInfo.data.relinkUrl, "relink")}
              >
                {copiedLabel === "relink" ? "Copied!" : "Copy Re-link URL"}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setRelinkInfo(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

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

      {session.status === "SETTLED" && (
        <SettlementPanel
          session={session}
          viewer={viewer}
          onSessionUpdate={setSession}
          onError={setError}
        />
      )}

      {session.status === "ACTIVE" && (
        <HandTablePanel
          session={session}
          viewer={viewer}
          onSessionUpdate={setSession}
          onError={setError}
        />
      )}

      <LedgerPanel
        session={session}
        viewer={viewer}
        selectedHostSeat={selectedHostSeat}
        onSelectHostSeat={setSelectedHostSeat}
        onSessionUpdate={setSession}
        onError={setError}
      />

      {session.status === "ACTIVE" && (
        <SettlementPanel
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
            const inActiveHand =
              activeHand !== null &&
              activeHand.seats.some((s) => s.seatNumber === seat.seatNumber);
            const seatFunding = seat.occupant
              ? getAvailableFundingForSeat({
                  config: session.config,
                  chips: seat.occupant.chips,
                  totalBuyInChips: seat.occupant.totalBuyInChips,
                  handInProgress: session.handInProgress,
                })
              : null;
            const releaseBlocked =
              seat.occupant !== null &&
              (seat.occupant.chips > 0 || seat.occupant.totalBuyInChips > 0 || inActiveHand);
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
                        {activeHand?.straddleSeatNumber === seat.seatNumber && (
                          <span className="pill">STR</span>
                        )}
                        {isActing && <span className="pill pill-live">Acting</span>}
                        {seat.occupant.hasPendingRelink && (
                          <span className="pill pill-warn">Pending Re-link</span>
                        )}
                      </>
                    ) : (
                      <span className="seat-sub">· Open</span>
                    )}
                  </div>
                  {seat.occupant && (
                    <div className="seat-sub">
                      {seat.occupant.chips} Chips · Buy-In: {seat.occupant.totalBuyInChips} Chips (
                      {formatChipsAsCash(seat.occupant.totalBuyInChips, session.config)}) ·{" "}
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
                    {seat.occupant && viewer.isHost && (
                      <>
                        {seatFunding && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={seatFunding.disabledReason !== null}
                            title={seatFunding.disabledReason ?? `Record ${seatFunding.label}`}
                            onClick={() => {
                              setSelectedHostSeat(seat.seatNumber);
                              document
                                .getElementById("host-ledger-entry")
                                ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                            }}
                          >
                            +{seatFunding.label}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={session.handInProgress}
                          title={
                            session.handInProgress
                              ? "Cash-Out is only allowed between Hands."
                              : "Cash out Seat and lock Chips"
                          }
                          onClick={() => void handleHostDirectCashOut(seat.seatNumber)}
                        >
                          Cash-Out
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void handleRelinkSeat(seat.seatNumber)}
                        >
                          Re-link
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={releaseBlocked}
                          title={
                            releaseBlocked
                              ? "Cannot release a Seat with Chips or recorded Buy-Ins"
                              : "Release Seat"
                          }
                          onClick={() => void handleReleaseSeat(seat.seatNumber)}
                        >
                          Release
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
