import { describe, it, expect } from "vitest";
import { parseResourceArg } from "../parse-resource-arg.js";

describe("parseResourceArg", () => {
  it("parses bare Linear identifier", () => {
    expect(parseResourceArg("POS-863")).toEqual({ source: null, id: "POS-863" });
  });

  it("parses multi-letter team prefix", () => {
    expect(parseResourceArg("INT-1327")).toEqual({ source: null, id: "INT-1327" });
  });

  it("parses linear:id format", () => {
    expect(parseResourceArg("linear:POS-863")).toEqual({
      source: "linear",
      id: "POS-863",
    });
  });

  it("parses github:id format", () => {
    expect(parseResourceArg("github:456")).toEqual({
      source: "github",
      id: "456",
    });
  });

  it("parses notion:id format", () => {
    expect(parseResourceArg("notion:page-abc")).toEqual({
      source: "notion",
      id: "page-abc",
    });
  });

  it("parses full URL as url source", () => {
    const url = "https://linear.app/team/issue/POS-863";
    expect(parseResourceArg(url)).toEqual({ source: "url", id: url });
  });

  it("parses http URL", () => {
    const url = "http://localhost:3000/issues/42";
    expect(parseResourceArg(url)).toEqual({ source: "url", id: url });
  });

  it("throws for empty string", () => {
    expect(() => parseResourceArg("")).toThrow("Resource argument is required");
  });

  it("parses bare number as null source", () => {
    expect(parseResourceArg("42")).toEqual({ source: null, id: "42" });
  });

  it("parses bare word as null source", () => {
    expect(parseResourceArg("my-issue")).toEqual({ source: null, id: "my-issue" });
  });
});
