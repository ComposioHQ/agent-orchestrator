import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import { ChatWorkspace } from "./ChatWorkspace";
import { chatFixture } from "../../lib/chat-fixture";

const png = (name = "shot.png") =>
	new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

// Steering sends guidance INTO the running turn instead of queueing behind it.
// Enter queues (matching `ao send`); Cmd/Ctrl+Enter steers. The delivery chips
// only highlight which shortcut is armed — they are not toggle buttons.

describe("ChatComposer steering", () => {
	function composer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
		return render(
			<ChatComposer onSend={vi.fn()} willQueue onSteer={vi.fn()} canSteer {...props} />,
		);
	}

	function deliveryStatus() {
		return screen.getByRole("status", {
			name: "Where this message goes while the agent is working",
		});
	}

	it("names both destinations while a turn is running", () => {
		composer();
		const delivery = deliveryStatus();
		expect(within(delivery).getByText("Queue")).toBeInTheDocument();
		expect(within(delivery).getByText("Steer")).toBeInTheDocument();
	});

	it("defaults Enter to the durable queue path used by ao send", () => {
		composer();
		expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
			"title",
			"⏎ queue · ⌘⏎ steer",
		);
	});

	it("queues by default while a turn is running", async () => {
		const onSteer = vi.fn().mockResolvedValue(undefined);
		const onSend = vi.fn();
		composer({ onSteer, onSend });

		await userEvent.type(screen.getByRole("combobox"), "use the unit tests only{Enter}");
		expect(onSend).toHaveBeenCalledWith("use the unit tests only");
		expect(onSteer).not.toHaveBeenCalled();
	});

	it("steers when the user holds the modifier and presses Enter", async () => {
		const onSteer = vi.fn().mockResolvedValue(undefined);
		const onSend = vi.fn();
		composer({ onSteer, onSend });

		const field = screen.getByRole("combobox");
		await userEvent.type(field, "and then ship it");
		fireEvent.keyDown(field, { key: "Enter", metaKey: true });
		await waitFor(() => expect(onSteer).toHaveBeenCalledWith("and then ship it"));
		expect(onSend).not.toHaveBeenCalled();
	});

	it("highlights steer while the modifier is held", () => {
		composer();
		const delivery = deliveryStatus();
		const queue = within(delivery).getByText("Queue").closest("span");
		const steer = within(delivery).getByText("Steer").closest("span");
		expect(queue).toHaveClass("bg-white/5");
		expect(steer).not.toHaveClass("bg-white/5");

		fireEvent.keyDown(window, { key: "Meta", metaKey: true });
		expect(within(deliveryStatus()).getByText("Steer").closest("span")).toHaveClass(
			"bg-white/5",
		);
		expect(within(deliveryStatus()).getByText("Queue").closest("span")).not.toHaveClass(
			"bg-white/5",
		);

		fireEvent.keyUp(window, { key: "Meta", metaKey: false });
		expect(within(deliveryStatus()).getByText("Queue").closest("span")).toHaveClass(
			"bg-white/5",
		);
	});

	it("clears the composer only once the provider has taken the guidance", async () => {
		let settle = () => {};
		const onSteer = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
		);
		composer({ onSteer });

		const field = screen.getByRole("combobox");
		await userEvent.type(field, "stop after the tests");
		fireEvent.keyDown(field, { key: "Enter", metaKey: true });
		// Still in the box: the turn is already running, so a refusal is a real
		// possibility and clearing early would lose what the user typed.
		expect(field).toHaveValue("stop after the tests");
		settle();
		await waitFor(() => expect(field).toHaveValue(""));
	});

	it("keeps the text when the steer is refused", async () => {
		const onSteer = vi.fn().mockRejectedValue(new Error("not steerable"));
		composer({ onSteer });
		const field = screen.getByRole("combobox");
		await userEvent.type(field, "actually, skip it");
		fireEvent.keyDown(field, { key: "Enter", metaKey: true });
		await waitFor(() => expect(onSteer).toHaveBeenCalled());
		expect(field).toHaveValue("actually, skip it");
	});

	it("keeps attachment-only drafts out of steer and available to queue", async () => {
		const onSteer = vi.fn().mockResolvedValue(undefined);
		const onSend = vi.fn();
		const stage = vi.fn().mockResolvedValue([".ao/attachments/shot.png"]);
		composer({ onSteer, onSend, onStageAttachments: stage });

		const field = screen.getByRole("combobox");
		await userEvent.click(field);
		fireEvent.paste(field, { clipboardData: { files: [png()], items: [] } });
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));

		// Steer needs a text body; Cmd+Enter with only an attachment is a no-op.
		fireEvent.keyDown(field, { key: "Enter", metaKey: true });
		expect(onSteer).not.toHaveBeenCalled();
		expect(onSend).not.toHaveBeenCalled();
		expect(stage).not.toHaveBeenCalled();
		expect(screen.getAllByRole("listitem")).toHaveLength(1);

		await userEvent.keyboard("{Enter}");

		await waitFor(() => expect(stage).toHaveBeenCalledOnce());
		expect(onSend).toHaveBeenCalledWith(
			"Attached files (read these files in the workspace):\n- .ao/attachments/shot.png",
		);
		await waitFor(() => expect(screen.queryAllByRole("listitem")).toHaveLength(0));
	});

	it("reports the daemon's refusal without a second message of its own", () => {
		composer({ steerRefusal: "A compaction turn is running. Try again once it finishes." });
		expect(screen.getByText(/compaction turn is running/)).toBeInTheDocument();
	});

	// Claude answers CHAT_STEER_UNSUPPORTED. A control that only ever fails is worse
	// than none, so the surface withdraws it rather than disabling it.
	it("offers nothing when the harness cannot steer", () => {
		composer({ onSteer: undefined, canSteer: false });
		expect(
			screen.queryByRole("status", {
				name: "Where this message goes while the agent is working",
			}),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
			"title",
			"⏎ queue · ⌘⏎ steer",
		);
	});

	it("offers nothing when no turn is in flight to steer", () => {
		composer({ canSteer: false, willQueue: false });
		expect(
			screen.queryByRole("status", {
				name: "Where this message goes while the agent is working",
			}),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
			"title",
			"Enter to send",
		);
	});
});

describe("ChatWorkspace steering", () => {
	function withQueuedMessages() {
		return {
			...chatFixture,
			turns: [
				...chatFixture.turns,
				{ id: "queued-1", state: "queued" as const, requestedAt: "2026-08-11T10:01:00Z" },
				{ id: "queued-2", state: "queued" as const, requestedAt: "2026-08-11T10:02:00Z" },
			],
			items: [
				...chatFixture.items,
				{
					kind: "message" as const,
					id: "queued-message-1",
					turnId: "queued-1",
					sequence: 100,
					revision: 0,
					role: "user" as const,
					origin: "human" as const,
					text: "first queued",
					streaming: false,
					createdAt: "2026-08-11T10:01:00Z",
				},
				{
					kind: "message" as const,
					id: "queued-message-2",
					turnId: "queued-2",
					sequence: 101,
					revision: 0,
					role: "user" as const,
					origin: "human" as const,
					text: "second queued",
					streaming: false,
					createdAt: "2026-08-11T10:02:00Z",
				},
			],
		};
	}

	it("docks queued messages above the composer with the next turn marked", () => {
		render(
			<ChatWorkspace
				snapshot={withQueuedMessages()}
				onSteer={vi.fn()}
			/>,
		);
		const dock = screen.getByTestId("queued-message-dock");
		expect(within(dock).getByText("first queued")).toBeVisible();
		expect(within(dock).getByText("second queued")).toBeVisible();
		expect(dock).toHaveClass("rounded-t-[var(--radius-chat-composer)]");
		expect(dock.nextElementSibling).toHaveAttribute("data-attached-top", "true");
		// Newest first; the soonest-to-run (oldest) row carries the next-turn marker.
		const nextUp = screen.getByTestId("queued-message-queued-1");
		const later = screen.getByTestId("queued-message-queued-2");
		expect(dock.firstElementChild).toBe(later);
		expect(nextUp.querySelector("svg")).toBeTruthy();
		expect(later.querySelector("svg")).toBeFalsy();
		expect(within(dock).queryByRole("button")).toBeNull();
	});

	it("keeps queued messages docked after the conversation branches", () => {
		render(
			<ChatWorkspace
				snapshot={{ ...withQueuedMessages(), branchedFromEarlierMessage: true }}
				onSteer={vi.fn()}
			/>,
		);

		const dock = screen.getByTestId("queued-message-dock");
		expect(within(dock).getByText("first queued")).toBeVisible();
		expect(within(dock).getByText("second queued")).toBeVisible();
	});

	it("offers steering only into a turn the provider is actually running", () => {
		render(<ChatWorkspace snapshot={chatFixture} onSteer={vi.fn()} />);
		// The live fixture is mid-turn.
		expect(
			screen.getByRole("status", {
				name: "Where this message goes while the agent is working",
			}),
		).toBeInTheDocument();
	});

	it("does not offer steering on a settled conversation", () => {
		render(
			<ChatWorkspace
				snapshot={{ ...chatFixture, turns: chatFixture.turns.map((t) => ({ ...t, state: "completed" as const })) }}
				onSteer={vi.fn()}
			/>,
		);
		expect(
			screen.queryByRole("status", {
				name: "Where this message goes while the agent is working",
			}),
		).not.toBeInTheDocument();
		expect(screen.queryByTestId("queued-message-dock")).not.toBeInTheDocument();
	});

	// A queued turn has not reached the provider, so there is nothing to steer.
	it("does not offer steering into a turn that is only queued", () => {
		render(
			<ChatWorkspace
				snapshot={{
					...chatFixture,
					turns: chatFixture.turns.map((t) =>
						t.state === "running" ? { ...t, state: "queued" as const } : t,
					),
				}}
				onSteer={vi.fn()}
			/>,
		);
		expect(
			screen.queryByRole("status", {
				name: "Where this message goes while the agent is working",
			}),
		).not.toBeInTheDocument();
	});

	it("renders a landed steer as the user's own words", () => {
		render(<ChatWorkspace snapshot={chatFixture} />);
		expect(screen.getByText(/Steered into the running turn/)).toBeInTheDocument();
	});

	it("renders every promoted steer content block on the running turn", () => {
		const snapshot = {
			...chatFixture,
			items: chatFixture.items.map((item) =>
				item.kind === "activity" && item.id === "a-steer-1"
					? {
							...item,
							detail: {
								...item.detail,
								content: [
									{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
									{ type: "resource_link", name: "reference.md", uri: "file:///reference.md" },
									{ type: "resource", name: "notes.md", uri: "file:///notes.md", text: "details" },
								],
							},
						}
					: item,
			),
		};
		render(<ChatWorkspace snapshot={snapshot} />);
		const image = screen.getByRole("img", { name: "Steered attachment 1" });
		expect(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
		const attachments = screen.getByRole("list", { name: "Steered attachments" });
		expect(within(attachments).getByTitle("file:///reference.md")).toHaveTextContent("reference.md");
		expect(within(attachments).getByTitle("file:///notes.md")).toHaveTextContent("notes.md");
	});
});
