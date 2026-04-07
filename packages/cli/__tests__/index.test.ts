import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let parseAsync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  parseAsync = vi.fn().mockResolvedValue(undefined);
  vi.doMock("../src/program.js", () => ({
    createProgram: () => ({ parseAsync }),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli entrypoint", () => {
  it("parses the created program", async () => {
    await import("../src/index.js");
    expect(parseAsync).toHaveBeenCalledOnce();
  });

  it("prints a clean message and exits 1 on ConfigNotFoundError", async () => {
    const { ConfigNotFoundError } = await import("@composio/ao-core");
    const error = new ConfigNotFoundError();
    parseAsync.mockRejectedValue(error);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await import("../src/index.js");
    await new Promise((r) => setTimeout(r, 0));

    expect(errorSpy).toHaveBeenCalledWith(error.message);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("re-throws non-ConfigNotFoundError errors", async () => {
    const error = new Error("unexpected");
    parseAsync.mockRejectedValue(error);

    const caught: Error[] = [];
    const nodeHandler = (reason: unknown) => {
      caught.push(reason as Error);
    };
    process.on("unhandledRejection", nodeHandler);

    await import("../src/index.js");
    await new Promise((r) => setTimeout(r, 50));

    process.off("unhandledRejection", nodeHandler);

    expect(caught).toContain(error);
  });
});
