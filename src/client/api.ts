import {
  normalizeSessionCode,
  type ClaimSeatInput,
  type ClaimSeatResponse,
  type CreateSessionInput,
  type CreateSessionResponse,
  type EndGameResponse,
  type GetSessionResponse,
  type LeaveSeatResponse,
  type RebuySeatResponse,
  type ReleaseSeatResponse,
  type ResolveShowdownInput,
  type ResolveShowdownResponse,
  type SetSitOutInput,
  type SetSitOutResponse,
  type StartHandResponse,
  type SubmitHandActionInput,
  type SubmitHandActionResponse,
  type UndoHandResponse,
} from "../shared/session.ts";

export interface StoredSessionTokens {
  hostToken: string | null;
  seatToken: string | null;
}

function tokenStorageKey(code: string, kind: "hostToken" | "seatToken"): string {
  return `poker_session_${normalizeSessionCode(code)}_${kind}`;
}

export function loadSessionTokens(code: string): StoredSessionTokens {
  return {
    hostToken: window.localStorage.getItem(tokenStorageKey(code, "hostToken")),
    seatToken: window.localStorage.getItem(tokenStorageKey(code, "seatToken")),
  };
}

export function saveHostToken(code: string, hostToken: string): void {
  window.localStorage.setItem(tokenStorageKey(code, "hostToken"), hostToken);
}

export function saveSeatToken(code: string, seatToken: string | null): void {
  const key = tokenStorageKey(code, "seatToken");
  if (seatToken === null) {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, seatToken);
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return data;
}

function authHeaders(tokens: StoredSessionTokens): Record<string, string> {
  const headers: Record<string, string> = {};
  if (tokens.hostToken) {
    headers["x-host-token"] = tokens.hostToken;
  }
  if (tokens.seatToken) {
    headers["x-seat-token"] = tokens.seatToken;
  }
  return headers;
}

export const sessionApi = {
  async createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<CreateSessionResponse>(res);
  },

  async getSession(code: string, tokens: StoredSessionTokens): Promise<GetSessionResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}`, {
      headers: authHeaders(tokens),
    });
    return parseJsonOrThrow<GetSessionResponse>(res);
  },

  async claimSeat(code: string, input: ClaimSeatInput): Promise<ClaimSeatResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/seats/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<ClaimSeatResponse>(res);
  },

  async rebuySeat(
    code: string,
    seatNumber: number,
    tokens: StoredSessionTokens,
  ): Promise<RebuySeatResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/seats/${seatNumber}/rebuy`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<RebuySeatResponse>(res);
  },

  async leaveSeat(
    code: string,
    seatNumber: number,
    tokens: StoredSessionTokens,
  ): Promise<LeaveSeatResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/seats/${seatNumber}/leave`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<LeaveSeatResponse>(res);
  },

  async releaseSeat(
    code: string,
    seatNumber: number,
    tokens: StoredSessionTokens,
  ): Promise<ReleaseSeatResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/seats/${seatNumber}/release`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<ReleaseSeatResponse>(res);
  },

  async startHand(code: string, tokens: StoredSessionTokens): Promise<StartHandResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/hand/start`, {
      method: "POST",
      headers: authHeaders(tokens),
    });
    return parseJsonOrThrow<StartHandResponse>(res);
  },

  async submitHandAction(
    code: string,
    input: SubmitHandActionInput,
    tokens: StoredSessionTokens,
  ): Promise<SubmitHandActionResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/hand/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(tokens),
      },
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<SubmitHandActionResponse>(res);
  },

  async resolveShowdown(
    code: string,
    input: ResolveShowdownInput,
    tokens: StoredSessionTokens,
  ): Promise<ResolveShowdownResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/hand/showdown`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(tokens),
      },
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<ResolveShowdownResponse>(res);
  },

  async undoHandStep(code: string, tokens: StoredSessionTokens): Promise<UndoHandResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/hand/undo`, {
      method: "POST",
      headers: authHeaders(tokens),
    });
    return parseJsonOrThrow<UndoHandResponse>(res);
  },

  async setSitOut(
    code: string,
    seatNumber: number,
    input: SetSitOutInput,
    tokens: StoredSessionTokens,
  ): Promise<SetSitOutResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/seats/${seatNumber}/sit-out`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(tokens),
        },
        body: JSON.stringify(input),
      },
    );
    return parseJsonOrThrow<SetSitOutResponse>(res);
  },

  async endGame(code: string, tokens: StoredSessionTokens): Promise<EndGameResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/end`, {
      method: "POST",
      headers: authHeaders(tokens),
    });
    return parseJsonOrThrow<EndGameResponse>(res);
  },
};
