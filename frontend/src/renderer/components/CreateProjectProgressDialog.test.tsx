import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CreateProjectProgressDialog from "./CreateProjectProgressDialog";

describe("CreateProjectProgressDialog", () => {
	it("cannot be dismissed while project creation is running", () => {
		render(<CreateProjectProgressDialog message="Cloning repository" open progress={42} />);

		const dialog = screen.getByRole("dialog", { name: "Creating the project" });
		expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(dialog).toBeInTheDocument();
	});
});
