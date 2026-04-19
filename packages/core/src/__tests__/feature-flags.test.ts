import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPortfolioEnabled } from "../feature-flags.js";

const ENV_KEY = "AO_ENABLE_PORTFOLIO";

describe("isPortfolioEnabled", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("defaults to enabled when the var is unset", () => {
    expect(isPortfolioEnabled()).toBe(true);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["yes", true],
    ["", true],
    ["0", false],
    ["false", false],
  ])("returns %s=%s", (value, expected) => {
    process.env[ENV_KEY] = value;
    expect(isPortfolioEnabled()).toBe(expected);
  });
});
