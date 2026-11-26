import type { SessionSnapshot, ViewerIdentity } from "./session.ts";

export interface SubscribeMessage {
  type: "subscribe";
  code: string;
  hostToken?: string | null | undefined;
  seatToken?: string | null | undefined;
}

export type ClientWsMessage = SubscribeMessage;

export type ServerWsMessage =
  | {
      type: "snapshot";
      session: SessionSnapshot;
      viewer: ViewerIdentity;
    }
  | {
      type: "error";
      error: string;
    };
