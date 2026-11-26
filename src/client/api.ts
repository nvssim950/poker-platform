import {
  normalizeSessionCode,
  type ApproveBuyInRequestResponse,
  type ApproveCashOutRequestResponse,
  type ClaimSeatInput,
  type ClaimSeatResponse,
  type CreateBuyInRequestInput,
  type CreateBuyInRequestResponse,
  type CreateCashOutRequestInput,
  type CreateCashOutRequestResponse,
  type CreateSessionInput,
  type CreateSessionResponse,
  type DirectCashOutResponse,
  type GetSessionResponse,
  type RecordDirectLedgerInput,
  type RecordDirectLedgerResponse,
  type RejectBuyInRequestResponse,
  type RejectCashOutRequestResponse,
  type ReleaseSeatResponse,
  type RelinkSeatResponse,
  type ResolveShowdownInput,
  type ResolveShowdownResponse,
  type SetRunItTwiceInput,
  type SetRunItTwiceResponse,
  type SetSitOutInput,
  type SetSitOutResponse,
  type SettleSessionResponse,
  type StartHandInput,
  type StartHandResponse,
  type SubmitHandActionInput,
  type SubmitHandActionResponse,
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

const inflightRelinkRedemptions = new Map<string, Promise<ClaimSeatResponse>>();

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

  async relinkSeat(
    code: string,
    seatNumber: number,
    tokens: StoredSessionTokens,
  ): Promise<RelinkSeatResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/seats/${seatNumber}/relink`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<RelinkSeatResponse>(res);
  },

  redeemRelink(code: string, relinkCode: string): Promise<ClaimSeatResponse> {
    const normalized = normalizeSessionCode(code);
    const key = `${normalized}:${relinkCode}`;
    const existing = inflightRelinkRedemptions.get(key);
    if (existing) {
      return existing;
    }

    const request = fetch(`/api/sessions/${encodeURIComponent(normalized)}/relink/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relinkCode }),
    }).then((res) => parseJsonOrThrow<ClaimSeatResponse>(res));

    inflightRelinkRedemptions.set(key, request);
    request.catch(() => {
      inflightRelinkRedemptions.delete(key);
    });
    return request;
  },

  async createBuyInRequest(
    code: string,
    input: CreateBuyInRequestInput,
    tokens: StoredSessionTokens,
  ): Promise<CreateBuyInRequestResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/buy-in-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(tokens),
      },
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<CreateBuyInRequestResponse>(res);
  },

  async approveBuyInRequest(
    code: string,
    requestId: string,
    tokens: StoredSessionTokens,
  ): Promise<ApproveBuyInRequestResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/buy-in-requests/${encodeURIComponent(requestId)}/approve`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<ApproveBuyInRequestResponse>(res);
  },

  async rejectBuyInRequest(
    code: string,
    requestId: string,
    tokens: StoredSessionTokens,
  ): Promise<RejectBuyInRequestResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/buy-in-requests/${encodeURIComponent(requestId)}/reject`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<RejectBuyInRequestResponse>(res);
  },

  async recordDirectLedger(
    code: string,
    seatNumber: number,
    input: RecordDirectLedgerInput,
    tokens: StoredSessionTokens,
  ): Promise<RecordDirectLedgerResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/seats/${seatNumber}/ledger`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(tokens),
        },
        body: JSON.stringify(input),
      },
    );
    return parseJsonOrThrow<RecordDirectLedgerResponse>(res);
  },

  async startHand(
    code: string,
    tokens: StoredSessionTokens,
    input?: StartHandInput,
  ): Promise<StartHandResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/hand/start`, {
      method: "POST",
      headers: input
        ? {
            "content-type": "application/json",
            ...authHeaders(tokens),
          }
        : authHeaders(tokens),
      ...(input ? { body: JSON.stringify(input) } : {}),
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

  async setRunItTwice(
    code: string,
    input: SetRunItTwiceInput,
    tokens: StoredSessionTokens,
  ): Promise<SetRunItTwiceResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/hand/run-it-twice`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(tokens),
      },
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<SetRunItTwiceResponse>(res);
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

  async createCashOutRequest(
    code: string,
    input: CreateCashOutRequestInput,
    tokens: StoredSessionTokens,
  ): Promise<CreateCashOutRequestResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/cash-out-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(tokens),
      },
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<CreateCashOutRequestResponse>(res);
  },

  async approveCashOutRequest(
    code: string,
    requestId: string,
    tokens: StoredSessionTokens,
  ): Promise<ApproveCashOutRequestResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/cash-out-requests/${encodeURIComponent(requestId)}/approve`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<ApproveCashOutRequestResponse>(res);
  },

  async rejectCashOutRequest(
    code: string,
    requestId: string,
    tokens: StoredSessionTokens,
  ): Promise<RejectCashOutRequestResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/cash-out-requests/${encodeURIComponent(requestId)}/reject`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<RejectCashOutRequestResponse>(res);
  },

  async directCashOut(
    code: string,
    seatNumber: number,
    tokens: StoredSessionTokens,
  ): Promise<DirectCashOutResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(normalized)}/seats/${seatNumber}/cash-out`,
      {
        method: "POST",
        headers: authHeaders(tokens),
      },
    );
    return parseJsonOrThrow<DirectCashOutResponse>(res);
  },

  async settleSession(code: string, tokens: StoredSessionTokens): Promise<SettleSessionResponse> {
    const normalized = normalizeSessionCode(code);
    const res = await fetch(`/api/sessions/${encodeURIComponent(normalized)}/settle`, {
      method: "POST",
      headers: authHeaders(tokens),
    });
    return parseJsonOrThrow<SettleSessionResponse>(res);
  },
};
