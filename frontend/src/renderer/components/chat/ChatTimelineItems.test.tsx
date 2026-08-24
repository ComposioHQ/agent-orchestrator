import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { ActivityRow, AssistantMessage, TurnOutcome } from "./ChatTimelineItems";
import type { ConversationMessage } from "../../types/conversation";

let nextFrame = 1;
let frames = new Map<number, FrameRequestCallback>();

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
	return {
		kind: "message",
		id: "assistant-1",
		sequence: 1,
		revision: 1,
		role: "assistant",
		origin: "provider",
		text: "a",
		streaming: true,
		createdAt: "2026-08-24T00:00:00Z",
		...overrides,
	};
}

function runFrame(now: number) {
	const [id, callback] = frames.entries().next().value ?? [];
	if (id === undefined || callback === undefined) throw new Error("No animation frame scheduled");
	frames.delete(id);
	act(() => callback(now));
}

beforeEach(() => {
	nextFrame = 1;
	frames = new Map();
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		const id = nextFrame++;
		frames.set(id, callback);
		return id;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
		frames.delete(id);
	});
});

afterEach(() => vi.restoreAllMocks());

describe("TurnOutcome", () => {
	it("keeps a recovered historical turn distinct from success", () => {
		render(<TurnOutcome state="recovered" />);
		expect(screen.getByText("This turn was recovered from an earlier session")).toBeInTheDocument();
		expect(screen.queryByText("Done")).not.toBeInTheDocument();
	});

	it("shows the message above a full-width rule", () => {
		const { container } = render(<TurnOutcome state="failed" error="Provider error" />);

		expect(screen.getByText("The agent ran into a problem")).toBeInTheDocument();
		expect(screen.getByText("Provider error")).toBeInTheDocument();
		expect(container.querySelector(".h-px.w-full.bg-border")).toBeInTheDocument();
	});
});

describe("AssistantMessage streaming", () => {
	it("does not force a character on high-refresh frames", () => {
		const view = render(<AssistantMessage message={message()} />);
		view.rerender(<AssistantMessage message={message({ text: "abcdefghij" })} />);

		runFrame(0);
		runFrame(8);

		expect(screen.getByText("a")).toBeInTheDocument();
		expect(screen.queryByText("ab")).not.toBeInTheDocument();
	});

	it("clamps an occluded-tab frame before appending backlog", () => {
		const view = render(<AssistantMessage message={message()} />);
		view.rerender(<AssistantMessage message={message({ text: "a".padEnd(2000, "x") })} />);

		runFrame(0);
		runFrame(5 * 60 * 1000);
		const rendered = document.querySelector("p");

		expect(rendered?.textContent?.length).toBeLessThan(100);
	});

	it("flushes buffered text when streaming completes and restores actions", () => {
		const view = render(<AssistantMessage message={message()} showCopy />);
		view.rerender(<AssistantMessage message={message({ text: "aThe complete answer", streaming: true })} showCopy />);
		runFrame(0);
		view.rerender(
			<AssistantMessage message={message({ text: "aThe complete answer", streaming: false })} showCopy />,
		);

		expect(screen.getByText("aThe complete answer")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy message as markdown" })).toBeInTheDocument();
	});

	it("hides message actions while text is still buffered", () => {
		const view = render(<AssistantMessage message={message()} showCopy />);
		view.rerender(<AssistantMessage message={message({ text: "a buffered answer" })} showCopy />);

		expect(screen.queryByRole("button", { name: "Copy message as markdown" })).not.toBeInTheDocument();
	});

	it("shows the message timestamp on hover", () => {
		const view = render(
			<AssistantMessage
				message={message({ createdAt: new Date().toISOString(), text: "Timestamped answer", streaming: false })}
				showCopy
			/>,
		);

		expect(view.container.querySelector("[title]")?.getAttribute("title")).toMatch(/^\d{2}:\d{2}$/);
		expect(screen.getByLabelText(/^Sent \d{2}:\d{2}$/)).toBeInTheDocument();
	});

	it("survives StrictMode effect cleanup and keeps draining", () => {
		const view = render(
			<StrictMode>
				<AssistantMessage message={message()} />
			</StrictMode>,
		);
		view.rerender(
			<StrictMode>
				<AssistantMessage message={message({ text: "abcdefghij" })} />
			</StrictMode>,
		);
		runFrame(0);
		runFrame(100);

		expect(document.querySelector("p")?.textContent).toBe("abcdef");
	});
});

describe("ActivityRow", () => {
	it("does not present a recovered historical activity as failed", () => {
		render(
			<ActivityRow
				activity={{
					kind: "activity",
					id: "activity-1",
					sequence: 1,
					revision: 0,
					createdAt: "2026-08-23T00:00:00Z",
					activityKind: "command",
					status: "recovered",
					summary: "Run tests",
				}}
			/>,
		);
		expect(screen.getByText("outcome unknown")).toBeInTheDocument();
		expect(screen.queryByText("failed")).not.toBeInTheDocument();
	});
});
