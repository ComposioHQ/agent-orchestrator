import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCallerType, isHumanCaller, type CallerType } from "../../src/lib/caller-context.js";

let envBackup: string | undefined;
let ttyBackup: boolean | undefined;

beforeEach(() => {
  envBackup = process.env["AO_CALLER_TYPE"];
  ttyBackup = process.stdout.isTTY;
});

afterEach(() => {
  if (envBackup === undefined) {
    delete process.env["AO_CALLER_TYPE"];
  } else {
    process.env["AO_CALLER_TYPE"] = envBackup;
  }
  Object.defineProperty(process.stdout, "isTTY", {
    value: ttyBackup,
    writable: true,
    configurable: true,
  });
});

describe("getCallerType", () => {
  it('returns "orchestrator" when AO_CALLER_TYPE is "orchestrator"', () => {
    process.env["AO_CALLER_TYPE"] = "orchestrator";
    expect(getCallerType()).toBe("orchestrator");
  });

  it('returns "agent" when AO_CALLER_TYPE is "agent"', () => {
    process.env["AO_CALLER_TYPE"] = "agent";
    expect(getCallerType()).toBe("agent");
  });

  it('returns "human" when AO_CALLER_TYPE is "human"', () => {
    process.env["AO_CALLER_TYPE"] = "human";
    expect(getCallerType()).toBe("human");
  });

  it('returns "human" when stdout is a TTY and env is not set', () => {
    delete process.env["AO_CALLER_TYPE"];
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    expect(getCallerType()).toBe("human");
  });

  it('returns "agent" when stdout is not a TTY and env is not set', () => {
    delete process.env["AO_CALLER_TYPE"];
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    expect(getCallerType()).toBe("agent");
  });

  it('returns "agent" when stdout.isTTY is undefined and env is not set', () => {
    delete process.env["AO_CALLER_TYPE"];
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(getCallerType()).toBe("agent");
  });

  it("ignores invalid AO_CALLER_TYPE values and falls back to TTY check", () => {
    process.env["AO_CALLER_TYPE"] = "invalid-value";
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    expect(getCallerType()).toBe("human");
  });

  it("ignores empty string AO_CALLER_TYPE", () => {
    process.env["AO_CALLER_TYPE"] = "";
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    expect(getCallerType()).toBe("agent");
  });
});

describe("isHumanCaller", () => {
  it("returns true when caller is human", () => {
    process.env["AO_CALLER_TYPE"] = "human";
    expect(isHumanCaller()).toBe(true);
  });

  it("returns false when caller is agent", () => {
    process.env["AO_CALLER_TYPE"] = "agent";
    expect(isHumanCaller()).toBe(false);
  });

  it("returns false when caller is orchestrator", () => {
    process.env["AO_CALLER_TYPE"] = "orchestrator";
    expect(isHumanCaller()).toBe(false);
  });

  it("returns true when TTY and no env override", () => {
    delete process.env["AO_CALLER_TYPE"];
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    expect(isHumanCaller()).toBe(true);
  });

  it("returns false when not TTY and no env override", () => {
    delete process.env["AO_CALLER_TYPE"];
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    expect(isHumanCaller()).toBe(false);
  });
});

describe("CallerType", () => {
  it('covers all valid CallerType values: "human", "orchestrator", "agent"', () => {
    const validTypes: CallerType[] = ["human", "orchestrator", "agent"];
    for (const t of validTypes) {
      process.env["AO_CALLER_TYPE"] = t;
      expect(getCallerType()).toBe(t);
    }
  });
});
