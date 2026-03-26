import { describe, expect, it } from "vitest";
import { arrowSeq, ctrlChar, escSeq, pgDnSeq, pgUpSeq, tabSeq } from "@/lib/terminal-keys";

describe("terminal-keys helpers", () => {
  it("returns esc and tab", () => {
    expect(escSeq()).toBe("\x1b");
    expect(tabSeq()).toBe("\t");
  });

  it("returns arrow sequences", () => {
    expect(arrowSeq("up")).toBe("\x1b[A");
    expect(arrowSeq("down")).toBe("\x1b[B");
    expect(arrowSeq("left")).toBe("\x1b[D");
    expect(arrowSeq("right")).toBe("\x1b[C");
  });

  it("returns page sequences", () => {
    expect(pgUpSeq()).toBe("\x1b[5~");
    expect(pgDnSeq()).toBe("\x1b[6~");
  });

  it("maps ctrl chords", () => {
    expect(ctrlChar("c")).toBe("\x03");
    expect(ctrlChar("z")).toBe("\x1a");
    expect(ctrlChar("[")).toBe("\x1b");
    expect(ctrlChar("1")).toBe("1");
  });
});
