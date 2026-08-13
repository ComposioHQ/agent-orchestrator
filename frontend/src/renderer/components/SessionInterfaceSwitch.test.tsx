import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionInterfaceTransition } from "../hooks/useSessionInterfaceTransition";
import {
	SessionInterfaceSwitchButton,
	SessionInterfaceSwitchDialog,
	SessionInterfaceTransitionNotice,
} from "./SessionInterfaceSwitch";

function transition(phase: SessionInterfaceTransition["phase"]): SessionInterfaceTransition {
	return {
		id: "switch-1",
		sessionId: "project-1",
		sourceMode: "tui",
		targetMode: "chat",
		policy: "drain",
		phase,
		createdAt: "2026-08-05T10:00:00Z",
		updatedAt: "2026-08-05T10:00:01Z",
	};
}

describe("SessionInterfaceSwitchButton", () => {
	it("keeps a draining switch in the top bar with an adjacent Cancel action", () => {
		const onCancel = vi.fn();
		render(
			<SessionInterfaceSwitchButton
				target="chat"
				supported
				transition={transition("draining")}
				onClick={vi.fn()}
				onCancel={onCancel}
			/>,
		);

		expect(screen.getByRole("status")).toHaveTextContent("Waiting to switch… Chat UI");
		const cancel = screen.getByRole("button", { name: "Cancel switch to Chat UI" });
		fireEvent.click(cancel);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("stays non-interactive after the source controller begins stopping", () => {
		render(
			<SessionInterfaceSwitchButton
				target="chat"
				supported
				transition={transition("source_stopping")}
				onClick={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		expect(screen.getByRole("status")).toHaveTextContent("Stopping controller… Chat UI");
		expect(screen.queryByRole("button", { name: "Cancel switch to Chat UI" })).not.toBeInTheDocument();
	});

	it("shows explicit switch copy for the target interface", () => {
		const onClick = vi.fn();
		render(<SessionInterfaceSwitchButton target="tui" supported onClick={onClick} />);

		const button = screen.getByRole("button", { name: "Switch to terminal UI" });
		expect(button).toHaveTextContent("Switch to terminal UI");
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledOnce();
	});
});

describe("SessionInterfaceSwitchDialog", () => {
	it("discloses that interrupting discards an unsent terminal draft", () => {
		render(<SessionInterfaceSwitchDialog open target="chat" onOpenChange={vi.fn()} onChoose={vi.fn()} />);

		expect(screen.getByText(/Any unsent Terminal UI draft is discarded/)).toBeInTheDocument();
	});
});

describe("SessionInterfaceTransitionNotice", () => {
	it("offers an explicit discard action when drain preserves a draft", () => {
		const onSwitchWithInterrupt = vi.fn();
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("failed"),
					errorCode: "DRAIN_DRAFT_PRESENT",
					errorDetail: "AO found unsent text and left the source untouched.",
				}}
				onDismiss={vi.fn()}
				onSwitchWithInterrupt={onSwitchWithInterrupt}
			/>,
		);

		const action = screen.getByRole("button", {
			name: "Discard draft and switch",
		});
		fireEvent.click(action);
		expect(onSwitchWithInterrupt).toHaveBeenCalledOnce();
	});

	it("does not offer a destructive retry for unrelated failures", () => {
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("failed"),
					errorCode: "TARGET_UNAVAILABLE",
				}}
				onDismiss={vi.fn()}
				onSwitchWithInterrupt={vi.fn()}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Stop now and switch" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Discard draft and switch" })).not.toBeInTheDocument();
	});
});
