import { afterEach, describe, expect, it } from "vitest";
import { apiPath, getBasePath } from "../api-path";

const originalBasePath = process.env.NEXT_PUBLIC_BASE_PATH;

afterEach(() => {
  if (originalBasePath === undefined) {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    return;
  }

  process.env.NEXT_PUBLIC_BASE_PATH = originalBasePath;
});

describe("getBasePath", () => {
  it("returns an empty string when unset", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(getBasePath()).toBe("");
  });

  it("normalizes leading and trailing slashes", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "///ao///";
    expect(getBasePath()).toBe("/ao");
  });

  it("trims surrounding whitespace", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "  /ao/  ";
    expect(getBasePath()).toBe("/ao");
  });

  it("returns an empty string for whitespace-only input", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "   ";
    expect(getBasePath()).toBe("");
  });

  it("rejects slash-only input to match next.config normalization", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "///";
    expect(() => getBasePath()).toThrow(/NEXT_PUBLIC_BASE_PATH/);
  });
});

describe("apiPath", () => {
  it("prepends the normalized base path", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/ao";
    expect(apiPath("/api/sessions")).toBe("/ao/api/sessions");
  });

  it("adds a leading slash when the input path does not have one", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/ao";
    expect(apiPath("api/sessions")).toBe("/ao/api/sessions");
  });

  it("returns the original path when no base path is set", () => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    expect(apiPath("/api/sessions")).toBe("/api/sessions");
  });
});
