import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationTurn } from "./ConversationTurn";

describe("ConversationTurn", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// @ts-expect-error test shim
		global.fetch = vi.fn();
		vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:3001" } } as unknown as Window & typeof globalThis);
		// Mock getApiBaseUrl to return ""
		vi.mock("../lib/api-client", async () => {
			const actual = await vi.importActual<typeof import("../lib/api-client")>("../lib/api-client");
			return { ...actual, getApiBaseUrl: () => "", apiErrorMessage: (e: unknown) => String((e as {error:string}).error) };
		});
	});

	it("renders Steer now for queued human message", () => {
		render(<ConversationTurn sessionId="sess-1" turnId="t1" text="hello" state="queued" />);
		expect(screen.getByTestId("steer-now")).toBeTruthy();
	});

	it("disables while pending and shows promoted on success", async () => {
		(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ promotedTurn: { id: "t1", state: "promoted" } }),
		});
		render(<ConversationTurn sessionId="sess-1" turnId="t1" text="hello" state="queued" />);
		const btn = screen.getByTestId("steer-now") as HTMLButtonElement;
		fireEvent.click(btn);
		expect(btn.disabled).toBe(true);
		await waitFor(() => expect(screen.getByTestId("turn-promoted")).toBeTruthy());
		expect(screen.getByText("Steered into the running turn.")).toBeTruthy();
	});

	it("shows actionable error on refusal and leaves queued", async () => {
		(global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			status: 409,
			json: async () => ({ code: "NO_STEERABLE_TURN", message: "No steerable turn is currently running" }),
		});
		render(<ConversationTurn sessionId="sess-1" turnId="t1" text="hello" state="queued" />);
		fireEvent.click(screen.getByTestId("steer-now"));
		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(screen.getByTestId("turn-queued")).toBeTruthy();
	});

	it("hides non-human and non-queued", () => {
		const { rerender } = render(<ConversationTurn sessionId="s1" turnId="t1" text="x" state="queued" role="agent" />);
		expect(screen.queryByTestId("steer-now")).toBeNull();
		rerender(<ConversationTurn sessionId="s1" turnId="t1" text="x" state="completed" />);
		expect(screen.queryByTestId("steer-now")).toBeNull();
	});
});
