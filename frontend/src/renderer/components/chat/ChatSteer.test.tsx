import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import { ChatWorkspace } from "./ChatWorkspace";
import { chatFixture } from "../../lib/chat-fixture";
import { typeInLexicalEditor } from "../../test/lexical";

// Steering sends guidance INTO the running turn instead of queueing behind it. The
// thing these tests protect is that the choice is legible: Enter changing meaning
// silently would be worse than the queueing it replaces.

describe("ChatComposer steering", () => {
	function composer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
		return render(
			<ChatComposer onSend={vi.fn()} willQueue onSteer={vi.fn()} canSteer {...props} />,
		);
	}

	it("shows delivery indicators while a turn is running", () => {
		composer();
		const delivery = screen.getByRole("group", { name: /where this message goes/i });
		expect(within(delivery).getByText("Queue")).toBeInTheDocument();
		expect(within(delivery).getByText("Steer")).toBeInTheDocument();
	});

	it("queues by default while a turn is running", async () => {
		const onSteer = vi.fn().mockResolvedValue(undefined);
		const onSend = vi.fn();
		composer({ onSteer, onSend });

		await typeInLexicalEditor(screen.getByRole("combobox"), "use the unit tests only");
		await userEvent.keyboard("{Enter}");
		expect(onSend).toHaveBeenCalledWith("use the unit tests only");
		expect(onSteer).not.toHaveBeenCalled();
	});

	it("reports the daemon's refusal without a second message of its own", () => {
		composer({ steerRefusal: "A compaction turn is running. Try again once it finishes." });
		expect(screen.getByRole("status")).toHaveTextContent(/compaction turn is running/);
	});

	it("hides delivery indicators when the harness cannot steer", () => {
		composer({ onSteer: undefined, canSteer: false });
		expect(screen.queryByText("Steer")).not.toBeInTheDocument();
	});

	it("hides delivery indicators when no turn is in flight", () => {
		composer({ canSteer: false, willQueue: false });
		expect(screen.queryByText("Steer")).not.toBeInTheDocument();
	});
});

describe("ChatWorkspace steering", () => {
	function withQueuedMessages() {
		return {
			...chatFixture,
			queuedTurns: [
				{ turnId: "queued-1", text: "first queued", origin: "human" as const },
				{ turnId: "queued-2", text: "second queued", origin: "human" as const },
			],
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

	it("docks queued messages above the composer", () => {
		render(
			<ChatWorkspace
				snapshot={withQueuedMessages()}
				onSteer={vi.fn()}
			/>,
		);
		const dock = screen.getByTestId("queued-message-dock");
		expect(within(dock).getByText("first queued")).toBeVisible();
		expect(within(dock).getByText("second queued")).toBeVisible();
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

	it("renders automation and unpaged durable queue items with cancel-only controls", async () => {
		const snapshot = {
			...withQueuedMessages(),
			queuedTurns: [
				{ turnId: "queued-automation", text: "relay follow-up", origin: "automation" as const },
				{ turnId: "queued-unpaged", text: "not in this history page", origin: "human" as const },
				{ turnId: "queued-fallback", text: "" },
			],
		};
		const onCancelQueuedTurn = vi.fn().mockResolvedValue(undefined);
		render(
			<ChatWorkspace
				snapshot={snapshot}
				onCancelQueuedTurn={onCancelQueuedTurn}
				onPromoteQueuedTurn={vi.fn()}
			/>,
		);

		const dock = screen.getByTestId("queued-message-dock");
		expect(within(dock).getByText("relay follow-up")).toBeVisible();
		expect(within(dock).getByText("not in this history page")).toBeVisible();
		expect(within(dock).getByText("Queued work")).toBeVisible();
		expect(
			within(dock).getByRole("button", { name: "Cancel queued work: Queued work" }),
		).toBeVisible();
		expect(
			within(dock).queryByRole("button", { name: "Use as next message: relay follow-up" }),
		).not.toBeInTheDocument();
		await userEvent.click(
			within(dock).getByRole("button", { name: "Cancel queued automation: relay follow-up" }),
		);
		expect(onCancelQueuedTurn).toHaveBeenCalledWith("queued-automation");
	});

	it("keeps cancel controls visible in a queued-only recovery snapshot", () => {
		const queued = withQueuedMessages();
		render(
			<ChatWorkspace
				snapshot={{
					...queued,
					controller: { state: "recovering" as const },
					turns: queued.turns.filter((turn) => turn.state === "queued"),
				}}
				onCancelQueuedTurn={vi.fn().mockResolvedValue(undefined)}
				onPromoteQueuedTurn={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		expect(screen.getByTestId("queued-message-dock")).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Cancel queued message: first queued" }),
		).toBeVisible();
		expect(
			screen.queryByRole("button", { name: "Use as next message: first queued" }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
	});

	it("refuses Stop when the daemon does not report the authoritative queue", () => {
		const onInterrupt = vi.fn();
		render(
			<ChatWorkspace
				snapshot={{
					...chatFixture,
					queuedTurns: undefined,
					items: chatFixture.items.filter(
						(item) =>
							!(item.kind === "activity" && item.activityKind === "approval" && item.status === "pending"),
					),
				}}
				onInterrupt={onInterrupt}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(
			/stop is unavailable because this ao daemon does not report the complete queued work/i,
		);
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
		expect(onInterrupt).not.toHaveBeenCalled();
	});

	it("controls one queued message at a time and confirms Stop's queue consequence", async () => {
		const queued = withQueuedMessages();
		const snapshot = {
			...queued,
			items: queued.items.filter(
				(item) =>
					!(item.kind === "activity" && item.activityKind === "approval" && item.status === "pending"),
			),
		};
		const onCancelQueuedTurn = vi.fn().mockResolvedValue(undefined);
		const onPromoteQueuedTurn = vi.fn().mockResolvedValue(undefined);
		const onInterrupt = vi.fn().mockResolvedValue(undefined);
		const { rerender } = render(
			<ChatWorkspace
				snapshot={snapshot}
				onInterrupt={onInterrupt}
				onCancelQueuedTurn={onCancelQueuedTurn}
				onPromoteQueuedTurn={onPromoteQueuedTurn}
			/>,
		);

		await userEvent.click(
			screen.getByRole("button", { name: "Cancel queued message: first queued" }),
		);
		expect(onCancelQueuedTurn).toHaveBeenCalledWith("queued-1");
		expect(onPromoteQueuedTurn).not.toHaveBeenCalled();
		expect(onInterrupt).not.toHaveBeenCalled();

		await userEvent.click(
			screen.getByRole("button", { name: "Use as next message: second queued" }),
		);
		expect(onPromoteQueuedTurn).toHaveBeenCalledWith("queued-2");
		expect(onCancelQueuedTurn).toHaveBeenCalledTimes(1);
		expect(onInterrupt).not.toHaveBeenCalled();

		const stop = screen.getByRole("button", {
			name: "Stop turn and cancel 2 queued messages",
		});
		expect(stop).toHaveAccessibleDescription(/also cancels 2 queued messages/i);
		await userEvent.click(stop);
		const stopDialog = screen.getByRole("dialog", {
			name: "Stop turn and cancel 2 queued messages?",
		});
		expect(stopDialog).toHaveTextContent(
			"The active turn and both queued messages will be stopped",
		);
		expect(onInterrupt).not.toHaveBeenCalled();

		// Polling may settle one queue item while the destructive confirmation is
		// open. Its copy must keep describing the scope the user chose to confirm.
		rerender(
			<ChatWorkspace
				snapshot={{
					...snapshot,
					queuedTurns: snapshot.queuedTurns.filter((turn) => turn.turnId !== "queued-2"),
					turns: snapshot.turns.map((turn) =>
						turn.id === "queued-2" ? { ...turn, state: "interrupted" as const } : turn,
					),
				}}
				onInterrupt={onInterrupt}
				onCancelQueuedTurn={onCancelQueuedTurn}
				onPromoteQueuedTurn={onPromoteQueuedTurn}
			/>,
		);
		const stableDialog = screen.getByRole("dialog", {
			name: "Stop turn and cancel 2 queued messages?",
		});
		expect(screen.getByText("This queued message was cancelled")).toBeInTheDocument();
		await userEvent.click(within(stableDialog).getByRole("button", { name: "Stop all" }));
		expect(onInterrupt).toHaveBeenCalledWith(["queued-1", "queued-2"]);
	});

	it("shows the delivery indicator only for a running turn without a pending approval", () => {
		const snapshot = {
			...chatFixture,
			items: chatFixture.items.filter(
				(item) =>
					!(item.kind === "activity" && item.activityKind === "approval" && item.status === "pending"),
			),
		};
		render(<ChatWorkspace snapshot={snapshot} onSteer={vi.fn()} />);
		expect(screen.getByText("Steer")).toBeInTheDocument();
		expect(screen.getByText("Queue")).toBeInTheDocument();
	});

	it("does not show delivery indicator on a settled conversation", () => {
		render(
			<ChatWorkspace
				snapshot={{ ...chatFixture, turns: chatFixture.turns.map((t) => ({ ...t, state: "completed" as const })) }}
				onSteer={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Steer")).not.toBeInTheDocument();
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
		expect(screen.queryByRole("button", { name: "Steer this turn" })).not.toBeInTheDocument();
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
