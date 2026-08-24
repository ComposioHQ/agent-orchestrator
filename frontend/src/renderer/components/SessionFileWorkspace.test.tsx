import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionFileWorkspace } from "./SessionFileWorkspace";

vi.mock("../hooks/useFileAnnotation", () => ({ useFileAnnotation: () => ({}) }));
vi.mock("./FileContentPane", () => ({ FileContentPane: () => <div /> }));
vi.mock("./WorkspaceEntryIcon", () => ({ WorkspaceEntryIcon: () => <svg data-testid="file-icon" /> }));

describe("SessionFileWorkspace", () => {
	it("aligns its toolbar height with the Files inspector toolbar", () => {
		render(<SessionFileWorkspace path="src/App.tsx" sessionId="sess-1" />);

		expect(screen.getByTestId("session-file-workspace").querySelector("header")).toHaveClass("h-10");
	});
});
