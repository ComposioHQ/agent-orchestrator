import { afterEach, describe, expect, it } from "vitest";
import {
  buildDashboardEnv,
  getExposureWarningLines,
  isLoopbackHost,
} from "../../src/lib/web-dir.js";

const SAVED_HOST = process.env["HOST"];
const SAVED_AO_DASHBOARD_HOST = process.env["AO_DASHBOARD_HOST"];
const SAVED_AO_DIRECT_TERMINAL_HOST = process.env["AO_DIRECT_TERMINAL_HOST"];

afterEach(() => {
  if (SAVED_HOST === undefined) {
    Reflect.deleteProperty(process.env, "HOST");
  } else {
    process.env["HOST"] = SAVED_HOST;
  }

  if (SAVED_AO_DASHBOARD_HOST === undefined) {
    Reflect.deleteProperty(process.env, "AO_DASHBOARD_HOST");
  } else {
    process.env["AO_DASHBOARD_HOST"] = SAVED_AO_DASHBOARD_HOST;
  }

  if (SAVED_AO_DIRECT_TERMINAL_HOST === undefined) {
    Reflect.deleteProperty(process.env, "AO_DIRECT_TERMINAL_HOST");
  } else {
    process.env["AO_DIRECT_TERMINAL_HOST"] = SAVED_AO_DIRECT_TERMINAL_HOST;
  }
});

describe("buildDashboardEnv", () => {
  it("defaults dashboard and terminal hosts to loopback", async () => {
    Reflect.deleteProperty(process.env, "HOST");
    Reflect.deleteProperty(process.env, "AO_DASHBOARD_HOST");
    Reflect.deleteProperty(process.env, "AO_DIRECT_TERMINAL_HOST");

    const env = await buildDashboardEnv(3000, null, 14800, 14801);

    expect(env["HOST"]).toBe("127.0.0.1");
    expect(env["AO_DASHBOARD_HOST"]).toBe("127.0.0.1");
    expect(env["AO_DIRECT_TERMINAL_HOST"]).toBe("127.0.0.1");
    expect(env["NEXT_PUBLIC_DIRECT_TERMINAL_HOST"]).toBe("127.0.0.1");
  });

  it("preserves explicit remote exposure overrides", async () => {
    process.env["AO_DASHBOARD_HOST"] = "0.0.0.0";
    process.env["AO_DIRECT_TERMINAL_HOST"] = "0.0.0.0";

    const env = await buildDashboardEnv(3000, null, 14800, 14801);

    expect(env["HOST"]).toBe("0.0.0.0");
    expect(env["AO_DASHBOARD_HOST"]).toBe("0.0.0.0");
    expect(env["AO_DIRECT_TERMINAL_HOST"]).toBe("0.0.0.0");
  });

  it("lets direct terminal inherit legacy HOST exposure when no override is set", async () => {
    process.env["HOST"] = "0.0.0.0";
    Reflect.deleteProperty(process.env, "AO_DASHBOARD_HOST");
    Reflect.deleteProperty(process.env, "AO_DIRECT_TERMINAL_HOST");

    const env = await buildDashboardEnv(3000, null, 14800, 14801);

    expect(env["HOST"]).toBe("0.0.0.0");
    expect(env["AO_DASHBOARD_HOST"]).toBe("0.0.0.0");
    expect(env["AO_DIRECT_TERMINAL_HOST"]).toBe("0.0.0.0");
    expect(env["NEXT_PUBLIC_DIRECT_TERMINAL_HOST"]).toBe("0.0.0.0");
  });
});

describe("exposure helpers", () => {
  it("recognizes loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("returns warnings only for non-loopback exposure", () => {
    expect(getExposureWarningLines("127.0.0.1", "127.0.0.1")).toEqual([]);
    expect(getExposureWarningLines("0.0.0.0", "127.0.0.1")).toEqual([
      "Security warning: dashboard HTTP API is bound to 0.0.0.0 without built-in auth.",
    ]);
  });
});
