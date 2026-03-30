import { describe, it, expect } from "vitest";
import { parseKeyValueContent } from "../key-value.js";

describe("parseKeyValueContent", () => {
  it("parses standard key=value pairs", () => {
    const result = parseKeyValueContent("key1=value1\nkey2=value2\n");
    expect(result).toEqual({ key1: "value1", key2: "value2" });
  });

  it("skips empty lines", () => {
    const result = parseKeyValueContent("key1=value1\n\n\nkey2=value2\n");
    expect(result).toEqual({ key1: "value1", key2: "value2" });
  });

  it("skips comment lines starting with #", () => {
    const result = parseKeyValueContent("# comment\nkey1=value1\n# another comment\n");
    expect(result).toEqual({ key1: "value1" });
  });

  it("skips lines without = delimiter", () => {
    const result = parseKeyValueContent("key1=value1\nno-equals-here\nkey2=value2\n");
    expect(result).toEqual({ key1: "value1", key2: "value2" });
  });

  it("uses first = as delimiter, preserving = in values", () => {
    const result = parseKeyValueContent("key1=value=with=equals\n");
    expect(result).toEqual({ key1: "value=with=equals" });
  });

  it("trims whitespace from keys and values", () => {
    const result = parseKeyValueContent("  key1  =  value1  \n");
    expect(result).toEqual({ key1: "value1" });
  });

  it("skips lines with empty keys (= at start of line)", () => {
    const result = parseKeyValueContent("=no-key\nkey1=value1\n");
    expect(result).toEqual({ key1: "value1" });
  });

  it("returns empty record for empty content", () => {
    const result = parseKeyValueContent("");
    expect(result).toEqual({});
  });

  it("handles whitespace-only lines", () => {
    const result = parseKeyValueContent("   \n  \t  \nkey1=value1\n");
    expect(result).toEqual({ key1: "value1" });
  });
});
