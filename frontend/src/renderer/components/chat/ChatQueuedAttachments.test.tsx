import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "./ChatWorkspace";
import { chatFixture } from "../../lib/chat-fixture";
import { typeInLexicalEditor } from "../../test/lexical";
import { TooltipProvider } from "../ui/tooltip";
import type { ConversationContentSummary, ConversationSnapshot } from "../../types/conversation";

const path = ".ao/attachments/attachment-shot.png";
const suffix = `Attached files (read these files in the workspace):\n- ${path}`;

function setup(text = "inspect this", content: ConversationContentSummary[] = []) {
	const edit = vi.fn().mockResolvedValue(undefined);
	const send = vi.fn().mockResolvedValue(undefined);
	const stage = vi.fn().mockResolvedValue([path]);
	const snapshot: ConversationSnapshot = {
		...chatFixture,
		turns: [{ id: "q1", state: "queued" as const, requestedAt: "2026-09-06T10:00:00Z" }],
		items: [
			{
				kind: "message" as const,
				id: "m1",
				turnId: "q1",
				sequence: 1,
				revision: 0,
				role: "user" as const,
				origin: "human" as const,
				text,
				content,
				streaming: false,
				createdAt: "2026-09-06T10:00:00Z",
			},
		],
	};
	const view = render(
		<TooltipProvider>
			<ChatWorkspace
				snapshot={snapshot}
				onSend={send}
				onEditQueuedTurn={edit}
				onStageAttachments={stage}
				nativeImages
			/>
		</TooltipProvider>,
	);
	return {
		edit,
		send,
		stage,
		snapshot,
		field: screen.getByRole("combobox"),
		rerenderSnapshot: (next: ConversationSnapshot) =>
			view.rerender(
				<TooltipProvider>
					<ChatWorkspace
						snapshot={next}
						onSend={send}
						onEditQueuedTurn={edit}
						onStageAttachments={stage}
						nativeImages
					/>
				</TooltipProvider>,
			),
	};
}

async function beginEdit() {
	await userEvent.click(
		within(screen.getByTestId("queued-message-q1")).getByRole("button", { name: "Edit queued message" }),
	);
}

async function pasteImage(field: HTMLElement, name = "shot.png") {
	fireEvent.paste(field, {
		clipboardData: {
			files: [new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" })],
			items: [],
		},
	});
	await screen.findByLabelText(`Remove ${name}`);
}

describe("queued message attachments", () => {
	it("saves newly attached image bytes and their staged reference to the queued turn", async () => {
		const { edit, send, stage, field } = setup();
		await beginEdit();
		await pasteImage(field);
		await userEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() =>
			expect(edit).toHaveBeenCalledWith("q1", `inspect this\n\n${suffix}`, {
				attachments: [{ mimeType: "image/png", data: expect.any(String) }],
				retainedContent: [],
				expectedRevision: 0,
			}),
		);
		expect(stage).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("opens existing images as chips and retains their server-owned bytes when text changes", async () => {
		const { edit, field } = setup(`inspect this\n\n${suffix}`, [{ type: "image", mimeType: "image/png" }]);
		await beginEdit();
		expect(screen.getByLabelText("Remove attachment-shot.png")).toBeInTheDocument();
		expect(field).not.toHaveTextContent(".ao/attachments");
		await typeInLexicalEditor(field, " carefully");
		await userEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() =>
			expect(edit).toHaveBeenCalledWith("q1", `inspect this carefully\n\n${suffix}`, {
				retainedContent: [0],
				expectedRevision: 0,
			}),
		);
	});

	it("removes an existing image's reference and native content together", async () => {
		const { edit } = setup(`inspect this\n\n${suffix}`, [{ type: "image", mimeType: "image/png" }]);
		await beginEdit();
		await userEvent.click(screen.getByLabelText("Remove attachment-shot.png"));
		await userEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() =>
			expect(edit).toHaveBeenCalledWith("q1", "inspect this", {
				retainedContent: [],
				expectedRevision: 0,
			}),
		);
	});

	it.each(["cancel", "save"])("isolates the ordinary draft and restores it after %s", async (action) => {
		const { field, edit } = setup();
		await typeInLexicalEditor(field, "unrelated draft");
		await pasteImage(field, "unrelated.png");
		await beginEdit();
		expect(field).toHaveTextContent("inspect this");
		expect(screen.queryByLabelText("Remove unrelated.png")).not.toBeInTheDocument();
		if (action === "save") {
			await userEvent.click(screen.getByRole("button", { name: "Send message" }));
			await waitFor(() => expect(edit).toHaveBeenCalledOnce());
		} else {
			await userEvent.click(field);
			await userEvent.keyboard("{Escape}");
		}
		await waitFor(() => expect(field).toHaveTextContent("unrelated draft"));
		expect(screen.getByLabelText("Remove unrelated.png")).toBeInTheDocument();
	});

	it("keeps a failed edit for retry without staging the same image twice", async () => {
		const { edit, send, stage, field } = setup();
		edit.mockRejectedValueOnce(new Error("Could not save queued message edit"));
		await beginEdit();
		await pasteImage(field);
		await userEvent.click(screen.getByRole("button", { name: "Send message" }));
		await screen.findByText("Could not save queued message edit");
		expect(field).toHaveTextContent("inspect this");
		expect(screen.getByLabelText("Remove shot.png")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
		expect(edit.mock.calls[1]).toEqual(edit.mock.calls[0]);
		expect(stage).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.queryByText("Editing queued message")).not.toBeInTheDocument());
	});

	it("keeps the edit target and draft when the turn dispatches before saving", async () => {
		const { edit, send, snapshot, rerenderSnapshot, field } = setup();
		edit.mockRejectedValueOnce(new Error("that message is no longer queued"));
		await beginEdit();
		await pasteImage(field);
		rerenderSnapshot({ ...snapshot, turns: snapshot.turns.map((turn) => ({ ...turn, state: "running" })) });
		await waitFor(() => expect(screen.queryByTestId("queued-message-q1")).not.toBeInTheDocument());
		expect(screen.getByText("Editing queued message")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Send message" }));
		await screen.findByText("that message is no longer queued");
		expect(edit).toHaveBeenCalledWith(
			"q1",
			expect.any(String),
			expect.objectContaining({ expectedRevision: 0 }),
		);
		expect(send).not.toHaveBeenCalled();
		expect(field).toHaveTextContent("inspect this");
		expect(screen.getByLabelText("Remove shot.png")).toBeInTheDocument();
	});
});
