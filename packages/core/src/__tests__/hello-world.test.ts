import { describe, expect, it } from "vitest";

import { helloWorld } from "../hello-world.js";

describe("helloWorld", () => {
  it("returns the hello world string", () => {
    expect(helloWorld()).toBe("Hello, world!");
  });
});
