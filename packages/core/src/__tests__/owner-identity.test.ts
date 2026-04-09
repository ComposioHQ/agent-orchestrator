import { describe, it, expect } from "vitest";
import { resolveOwnerIdentity } from "../owner-identity.js";

describe("resolveOwnerIdentity", () => {
  it("prefers AO_TERMINAL_ACTOR_ID over other values", () => {
    const originalTerminalActor = process.env.AO_TERMINAL_ACTOR_ID;
    const originalSessionOwner = process.env.AO_SESSION_OWNER_ID;
    const originalUser = process.env.USER;

    process.env.AO_TERMINAL_ACTOR_ID = "  terminal-owner  ";
    process.env.AO_SESSION_OWNER_ID = "session-owner";
    process.env.USER = "shell-user";

    try {
      expect(resolveOwnerIdentity()).toEqual({
        id: "terminal-owner",
        source: "env:AO_TERMINAL_ACTOR_ID",
      });
    } finally {
      if (originalTerminalActor === undefined) {
        Reflect.deleteProperty(process.env, "AO_TERMINAL_ACTOR_ID");
      } else {
        process.env.AO_TERMINAL_ACTOR_ID = originalTerminalActor;
      }

      if (originalSessionOwner === undefined) {
        Reflect.deleteProperty(process.env, "AO_SESSION_OWNER_ID");
      } else {
        process.env.AO_SESSION_OWNER_ID = originalSessionOwner;
      }

      if (originalUser === undefined) {
        Reflect.deleteProperty(process.env, "USER");
      } else {
        process.env.USER = originalUser;
      }
    }
  });

  it("uses AO_SESSION_OWNER_ID when terminal actor env var is missing", () => {
    const originalTerminalActor = process.env.AO_TERMINAL_ACTOR_ID;
    const originalSessionOwner = process.env.AO_SESSION_OWNER_ID;
    const originalUser = process.env.USER;

    Reflect.deleteProperty(process.env, "AO_TERMINAL_ACTOR_ID");
    process.env.AO_SESSION_OWNER_ID = "  session-owner  ";
    process.env.USER = "shell-user";

    try {
      expect(resolveOwnerIdentity()).toEqual({
        id: "session-owner",
        source: "env:AO_SESSION_OWNER_ID",
      });
    } finally {
      if (originalTerminalActor === undefined) {
        Reflect.deleteProperty(process.env, "AO_TERMINAL_ACTOR_ID");
      } else {
        process.env.AO_TERMINAL_ACTOR_ID = originalTerminalActor;
      }

      if (originalSessionOwner === undefined) {
        Reflect.deleteProperty(process.env, "AO_SESSION_OWNER_ID");
      } else {
        process.env.AO_SESSION_OWNER_ID = originalSessionOwner;
      }

      if (originalUser === undefined) {
        Reflect.deleteProperty(process.env, "USER");
      } else {
        process.env.USER = originalUser;
      }
    }
  });

  it("uses USER when owner-specific env vars are missing", () => {
    const originalTerminalActor = process.env.AO_TERMINAL_ACTOR_ID;
    const originalSessionOwner = process.env.AO_SESSION_OWNER_ID;
    const originalUser = process.env.USER;

    Reflect.deleteProperty(process.env, "AO_TERMINAL_ACTOR_ID");
    Reflect.deleteProperty(process.env, "AO_SESSION_OWNER_ID");
    process.env.USER = "  shell-user  ";

    try {
      expect(resolveOwnerIdentity()).toEqual({
        id: "shell-user",
        source: "env:USER",
      });
    } finally {
      if (originalTerminalActor === undefined) {
        Reflect.deleteProperty(process.env, "AO_TERMINAL_ACTOR_ID");
      } else {
        process.env.AO_TERMINAL_ACTOR_ID = originalTerminalActor;
      }

      if (originalSessionOwner === undefined) {
        Reflect.deleteProperty(process.env, "AO_SESSION_OWNER_ID");
      } else {
        process.env.AO_SESSION_OWNER_ID = originalSessionOwner;
      }

      if (originalUser === undefined) {
        Reflect.deleteProperty(process.env, "USER");
      } else {
        process.env.USER = originalUser;
      }
    }
  });

  it("falls back to os.userInfo when env vars are unavailable", () => {
    const originalTerminalActor = process.env.AO_TERMINAL_ACTOR_ID;
    const originalSessionOwner = process.env.AO_SESSION_OWNER_ID;
    const originalUser = process.env.USER;

    Reflect.deleteProperty(process.env, "AO_TERMINAL_ACTOR_ID");
    Reflect.deleteProperty(process.env, "AO_SESSION_OWNER_ID");
    Reflect.deleteProperty(process.env, "USER");

    try {
      const resolved = resolveOwnerIdentity();
      expect(resolved.source).toBe("os:userInfo");
      expect(resolved.id).toBeTruthy();
    } finally {
      if (originalTerminalActor === undefined) {
        Reflect.deleteProperty(process.env, "AO_TERMINAL_ACTOR_ID");
      } else {
        process.env.AO_TERMINAL_ACTOR_ID = originalTerminalActor;
      }

      if (originalSessionOwner === undefined) {
        Reflect.deleteProperty(process.env, "AO_SESSION_OWNER_ID");
      } else {
        process.env.AO_SESSION_OWNER_ID = originalSessionOwner;
      }

      if (originalUser === undefined) {
        Reflect.deleteProperty(process.env, "USER");
      } else {
        process.env.USER = originalUser;
      }
    }
  });
});
