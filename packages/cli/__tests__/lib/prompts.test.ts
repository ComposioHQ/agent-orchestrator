import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockConfirm, mockSelect, mockIsCancel } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockSelect: vi.fn(),
  mockIsCancel: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: mockConfirm,
  select: mockSelect,
  isCancel: mockIsCancel,
}));

import { promptConfirm, promptSelect } from "../../src/lib/prompts.js";

beforeEach(() => {
  mockConfirm.mockReset();
  mockSelect.mockReset();
  mockIsCancel.mockReset();
  mockIsCancel.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// promptConfirm()
// ---------------------------------------------------------------------------

describe("promptConfirm", () => {
  it("returns true when user confirms", async () => {
    mockConfirm.mockResolvedValue(true);

    const result = await promptConfirm("Continue?");

    expect(result).toBe(true);
    expect(mockConfirm).toHaveBeenCalledWith({
      message: "Continue?",
      initialValue: true,
    });
  });

  it("returns false when user declines", async () => {
    mockConfirm.mockResolvedValue(false);

    const result = await promptConfirm("Continue?");

    expect(result).toBe(false);
  });

  it("passes custom initialValue", async () => {
    mockConfirm.mockResolvedValue(false);

    await promptConfirm("Delete?", false);

    expect(mockConfirm).toHaveBeenCalledWith({
      message: "Delete?",
      initialValue: false,
    });
  });

  it("defaults initialValue to true", async () => {
    mockConfirm.mockResolvedValue(true);

    await promptConfirm("Proceed?");

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: true }),
    );
  });

  it("exits process when user cancels (Ctrl+C)", async () => {
    const cancelSymbol = Symbol("cancel");
    mockConfirm.mockResolvedValue(cancelSymbol);
    mockIsCancel.mockReturnValue(true);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(promptConfirm("Continue?")).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// promptSelect()
// ---------------------------------------------------------------------------

describe("promptSelect", () => {
  const options = [
    { value: "a" as const, label: "Option A" },
    { value: "b" as const, label: "Option B" },
  ];

  it("returns selected value", async () => {
    mockSelect.mockResolvedValue("a");

    const result = await promptSelect("Pick one:", options);

    expect(result).toBe("a");
  });

  it("passes message and options to @clack/prompts select", async () => {
    mockSelect.mockResolvedValue("b");

    await promptSelect("Choose:", options);

    expect(mockSelect).toHaveBeenCalledWith({
      message: "Choose:",
      options,
    });
  });

  it("passes initialValue when provided", async () => {
    mockSelect.mockResolvedValue("b");

    await promptSelect("Choose:", options, "b");

    expect(mockSelect).toHaveBeenCalledWith({
      message: "Choose:",
      options,
      initialValue: "b",
    });
  });

  it("does not include initialValue when not provided", async () => {
    mockSelect.mockResolvedValue("a");

    await promptSelect("Choose:", options);

    const callArg = mockSelect.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("initialValue");
  });

  it("exits process when user cancels (Ctrl+C)", async () => {
    const cancelSymbol = Symbol("cancel");
    mockSelect.mockResolvedValue(cancelSymbol);
    mockIsCancel.mockReturnValue(true);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(promptSelect("Pick:", options)).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("logs 'Request Cancelled.' message on cancel", async () => {
    const cancelSymbol = Symbol("cancel");
    mockSelect.mockResolvedValue(cancelSymbol);
    mockIsCancel.mockReturnValue(true);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(promptSelect("Pick:", options)).rejects.toThrow("process.exit");

    // The console.log call should contain "Cancelled" (from chalk output)
    expect(consoleSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
