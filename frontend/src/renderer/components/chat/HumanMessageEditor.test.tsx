import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HumanMessageEditor } from "./HumanMessageEditor";

describe("HumanMessageEditor", () => {
	it("sends with Cmd+Enter while Enter inserts a newline", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn(async () => undefined);
		render(
			<HumanMessageEditor
				text="original prompt"
				content={[]}
				pending={false}
				busy={false}
				onCancel={vi.fn()}
				onSend={onSend}
			/>,
		);
		const editor = screen.getByRole("textbox", { name: "Edit message" });
		expect(editor).toHaveFocus();
		await user.clear(editor);
		await user.type(editor, "line one{enter}line two");
		expect(editor).toHaveValue("line one\nline two");
		fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
		await waitFor(() => expect(onSend).toHaveBeenCalledWith("line one\nline two"));
	});

	it("also sends with Ctrl+Enter and Escape cancels", () => {
		const onSend = vi.fn();
		const onCancel = vi.fn();
		const { rerender } = render(
			<HumanMessageEditor text="prompt" content={[]} pending={false} busy={false} onCancel={onCancel} onSend={onSend} />,
		);
		const editor = screen.getByRole("textbox", { name: "Edit message" });
		fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
		expect(onSend).toHaveBeenCalledWith("prompt");
		rerender(<HumanMessageEditor text="prompt" content={[]} pending={false} busy={false} onCancel={onCancel} onSend={onSend} />);
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit message" }), { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("preserves content chips and disables blank or busy sends", async () => {
		const user = userEvent.setup();
		render(
			<HumanMessageEditor
				text="prompt"
				content={[
					{ type: "image", mimeType: "image/png" },
					{ type: "resource", name: "notes.md", uri: "file:///notes.md" },
				]}
				pending={false}
				busy
				onCancel={vi.fn()}
				onSend={vi.fn()}
			/>,
		);
		expect(screen.getByText("image/png")).toBeVisible();
		expect(screen.getByText("notes.md")).toBeVisible();
		const send = screen.getByRole("button", { name: "Send edited message" });
		expect(send).toBeDisabled();
		expect(send).toHaveAttribute("title", "Stop the current turn before branching");
		await user.clear(screen.getByRole("textbox", { name: "Edit message" }));
		expect(send).toBeDisabled();
	});

	it("retains the editor and shows a mutation error", () => {
		render(
			<HumanMessageEditor text="prompt" content={[]} pending={false} busy={false} error="branch failed" onCancel={vi.fn()} onSend={vi.fn()} />,
		);
		expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveValue("prompt");
		expect(screen.getByRole("alert")).toHaveTextContent("branch failed");
	});
});
