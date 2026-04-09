import { userInfo } from "node:os";

export interface OwnerIdentity {
  id: string;
  source: string;
}

const OWNER_ENV_CANDIDATES = [
  ["AO_TERMINAL_ACTOR_ID", "env:AO_TERMINAL_ACTOR_ID"],
  ["AO_SESSION_OWNER_ID", "env:AO_SESSION_OWNER_ID"],
  ["USER", "env:USER"],
] as const;

export function resolveOwnerIdentity(): OwnerIdentity {
  for (const [envVar, source] of OWNER_ENV_CANDIDATES) {
    const value = process.env[envVar]?.trim();
    if (value) {
      return { id: value, source };
    }
  }

  return { id: userInfo().username, source: "os:userInfo" };
}
