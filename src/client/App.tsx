import { useEffect, useState } from "react";
import { normalizeSessionCode } from "../shared/session.ts";
import { CreateSessionView } from "./CreateSessionView.tsx";
import { SessionLobbyView } from "./SessionLobbyView.tsx";

function parseSessionCodeFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/s\/([A-Za-z0-9]+)\/?$/);
  return match ? normalizeSessionCode(match[1] ?? "") : null;
}

export function App() {
  const [sessionCode, setSessionCode] = useState<string | null>(() =>
    parseSessionCodeFromPath(window.location.pathname),
  );

  useEffect(() => {
    function handlePopState(): void {
      setSessionCode(parseSessionCodeFromPath(window.location.pathname));
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function navigateToSession(code: string): void {
    const normalized = normalizeSessionCode(code);
    window.history.pushState({}, "", `/s/${normalized}`);
    setSessionCode(normalized);
  }

  function navigateHome(): void {
    window.history.pushState({}, "", "/");
    setSessionCode(null);
  }

  return (
    <main className="app-shell">
      <header className="brand-bar">
        <h1 className="brand-title">Poker Table Companion</h1>
      </header>
      {sessionCode ? (
        <SessionLobbyView code={sessionCode} onLeaveToHome={navigateHome} />
      ) : (
        <CreateSessionView onOpenSession={navigateToSession} />
      )}
    </main>
  );
}
