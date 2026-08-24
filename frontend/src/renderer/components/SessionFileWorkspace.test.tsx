import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionFileWorkspace } from "./SessionFileWorkspace";

const { begin } = vi.hoisted(() => ({ begin: vi.fn() }));
vi.mock("../hooks/useFileAnnotation", () => ({
	useFileAnnotation: () => ({ target: null, draft: "", status: "idle", error: "", begin }),
}));
vi.mock("./FileContentPane", () => ({ FileContentPane: () => <div /> }));
vi.mock("./WorkspaceEntryIcon", () => ({ WorkspaceEntryIcon: () => <svg data-testid="file-icon" /> }));

describe("SessionFileWorkspace", () => {
	it("aligns its toolbar height with the Files inspector toolbar", () => {
		render(<SessionFileWorkspace path="src/App.tsx" sessionId="sess-1" />);

		expect(screen.getByTestId("session-file-workspace").querySelector("header")).toHaveClass("h-10");
	});

	it("starts whole-file feedback from the opened file header", async () => {
		render(<SessionFileWorkspace path="src/App.tsx" sessionId="sess-1" />);

		await userEvent.click(screen.getByRole("button", { name: "Add feedback for file src/App.tsx" }));
		expect(begin).toHaveBeenCalledWith({ path: "src/App.tsx", side: "file" });
	});
});
