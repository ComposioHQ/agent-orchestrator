import { describe, it, expect } from "vitest";
import { parseKeyValueContent } from "../key-value.js";

describe("parseKeyValueContent", () => {
  it("parses simple key=value pairs", () => {
    expect(parseKeyValueContent("foo=bar\nbaz=qux")).toEqual({
      foo: "bar",
      baz: "qux",
    });
  });

  it("skips comment lines", () => {
    expect(parseKeyValueContent("# comment\nfoo=bar")).toEqual({ foo: "bar" });
  });

  it("skips empty lines", () => {
    expect(parseKeyValueContent("foo=bar\n\nbaz=qux\n")).toEqual({
      foo: "bar",
      baz: "qux",
    });
  });

  it("handles values containing equals signs", () => {
    expect(parseKeyValueContent("url=https://example.com?a=1&b=2")).toEqual({
      url: "https://example.com?a=1&b=2",
    });
  });

  it("trims whitespace around keys and values", () => {
    expect(parseKeyValueContent("  key  =  value  ")).toEqual({ key: "value" });
  });

  it("skips lines without an equals sign", () => {
    expect(parseKeyValueContent("no-equals\nfoo=bar")).toEqual({ foo: "bar" });
  });

  it("returns empty record for empty content", () => {
    expect(parseKeyValueContent("")).toEqual({});
  });

  it("skips lines where key is empty after trimming", () => {
    expect(parseKeyValueContent("=value")).toEqual({});
  });
});
