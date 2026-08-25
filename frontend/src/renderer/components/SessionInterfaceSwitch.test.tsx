import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionInterfaceTransition } from "../hooks/useSessionInterfaceTransition";
import {
	SessionInterfaceSwitchButton,
	SessionInterfaceSwitchDialog,
	SessionInterfaceTransitionNotice,
} from "./SessionInterfaceSwitch";
import { TooltipProvider } from "./ui/tooltip";

function renderSwitchButton(target: "chat" | "tui", onClick = vi.fn()) {
	return {
		onClick,
		...render(
			<TooltipProvider>
				<SessionInterfaceSwitchButton target={target} supported onClick={onClick} />
			</TooltipProvider>,
		),
	};
}

function transition(phase: SessionInterfaceTransition["phase"]): SessionInterfaceTransition {
	return {
		id: "switch-1",
		sessionId: "project-1",
		sourceMode: "tui",
		targetMode: "chat",
		policy: "drain",
		historyPolicy: "strict",
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

	it.each([
		["chat", "Switch to chat UI", "lucide-message-square"],
		["tui", "Switch to terminal UI", "lucide-square-terminal"],
	] as const)("uses an icon-only %s destination control", (target, label, iconClass) => {
		const { onClick } = renderSwitchButton(target);

		const button = screen.getByRole("button", { name: label });
		expect(button.classList.contains("topbar-control--icon")).toBe(true);
		expect(button.textContent).toBe("");
		expect(button.querySelector(`.${iconClass}`)).not.toBeNull();
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("describes recovered history accurately and hides it after durable acknowledgement", () => {
		const recovered = { ...transition("recovery_required"), errorCode: "DAEMON_RESTARTED" };
		const { rerender } = render(
			<SessionInterfaceTransitionNotice transition={recovered} onDismiss={vi.fn()} />,
		);

		expect(screen.getByText("Interface switch recovered")).toBeInTheDocument();
		expect(screen.queryByText("Interface switch needs recovery")).not.toBeInTheDocument();

		rerender(
			<SessionInterfaceTransitionNotice
				transition={{ ...recovered, noticeAcknowledgedAt: "2026-08-13T08:00:00Z" }}
				onDismiss={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Interface switch recovered")).not.toBeInTheDocument();
	});

	it("does not claim an unresolved recovery-required transition was recovered", () => {
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("recovery_required"),
					errorCode: "SOURCE_STOP_UNCERTAIN",
				}}
				onDismiss={vi.fn()}
			/>,
		);

		expect(screen.getByText("Interface switch needs attention")).toBeInTheDocument();
		expect(screen.queryByText("Interface switch recovered")).not.toBeInTheDocument();
	});
});

describe("SessionInterfaceSwitchDialog", () => {
	it("discloses that interrupting discards an unsent terminal draft", () => {
		render(<SessionInterfaceSwitchDialog open target="chat" onOpenChange={vi.fn()} onChoose={vi.fn()} />);

		expect(screen.getByText(/Any unsent Terminal UI draft is discarded/)).toBeInTheDocument();
	});
});

describe("SessionInterfaceTransitionNotice", () => {
	it("announces unsettled history and offers retry or stay actions", () => {
		const onRetry = vi.fn();
		const onDismiss = vi.fn();
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("failed"),
					errorCode: "TARGET_HISTORY_UNSETTLED",
					errorDetail: "Interface switch failed (AO-2L): target history is not settled.",
				}}
				onDismiss={onDismiss}
				onRetry={onRetry}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("AO-2L");
		fireEvent.click(screen.getByRole("button", { name: "Retry switch to Chat UI" }));
		expect(onRetry).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Use provider history and switch" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Stay in Terminal" }));
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("offers provider-history recovery only for a legacy text mismatch", () => {
		const onRetry = vi.fn();
		const onUseProviderHistory = vi.fn();
		const onDismiss = vi.fn();
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("failed"),
					errorCode: "TARGET_HISTORY_UNTRUSTED_TEXT_MISMATCH",
					errorDetail: "Interface switch failed (AO-2L): legacy checkpoint text did not match.",
				}}
				onDismiss={onDismiss}
				onRetry={onRetry}
				onUseProviderHistory={onUseProviderHistory}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("AO-2L");
		fireEvent.click(screen.getByRole("button", { name: "Retry switch to Chat UI" }));
		fireEvent.click(screen.getByRole("button", { name: "Use provider history and switch" }));
		fireEvent.click(screen.getByRole("button", { name: "Stay in Terminal" }));
		expect(onRetry).toHaveBeenCalledOnce();
		expect(onUseProviderHistory).toHaveBeenCalledOnce();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("retains explicit provider-history recovery after daemon restart", () => {
		const onRetry = vi.fn();
		const onUseProviderHistory = vi.fn();
		const onDismiss = vi.fn();
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("recovery_required"),
					historyPolicy: "provider_history",
					errorCode: "DAEMON_RESTARTED",
					errorDetail: "AO restored Terminal after the daemon restarted.",
				}}
				onDismiss={onDismiss}
				onRetry={onRetry}
				onUseProviderHistory={onUseProviderHistory}
			/>,
		);

		expect(screen.getByRole("status")).toHaveTextContent("AO restored Terminal");
		fireEvent.click(screen.getByRole("button", { name: "Retry switch to Chat UI" }));
		fireEvent.click(screen.getByRole("button", { name: "Use provider history and switch" }));
		fireEvent.click(screen.getByRole("button", { name: "Stay in Terminal" }));
		expect(onRetry).toHaveBeenCalledOnce();
		expect(onUseProviderHistory).toHaveBeenCalledOnce();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("announces a rejected recovery attempt inside AO-2L", () => {
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("failed"),
					errorCode: "TARGET_HISTORY_UNTRUSTED_TEXT_MISMATCH",
					errorDetail: "Interface switch failed (AO-2L).",
				}}
				onDismiss={vi.fn()}
				onRetry={vi.fn()}
				recoveryError="Terminal history changed; retry with a fresh choice."
			/>,
		);

		expect(screen.getByText(/Recovery attempt failed/)).toHaveAttribute("role", "alert");
		expect(screen.getByText(/Recovery attempt failed/)).toHaveTextContent("Terminal history changed");
	});

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

	it("offers an explicit cancellation action when a provider decision blocks drain", () => {
		const onSwitchWithInterrupt = vi.fn();
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("failed"),
					errorCode: "DRAIN_DECISION_PENDING",
					errorDetail: "AO found a provider decision waiting in Terminal.",
				}}
				onDismiss={vi.fn()}
				onSwitchWithInterrupt={onSwitchWithInterrupt}
			/>,
		);

		const action = screen.getByRole("button", {
			name: "Cancel request and switch",
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

	it("does not offer a destructive retry when terminal quiescence is unverified", () => {
		render(
			<SessionInterfaceTransitionNotice
				transition={{
					...transition("failed"),
					errorCode: "DRAIN_QUIESCENCE_UNVERIFIED",
					errorDetail: "AO could not classify the current Terminal screen.",
				}}
				onDismiss={vi.fn()}
				onSwitchWithInterrupt={vi.fn()}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Stop now and switch" })).not.toBeInTheDocument();
	});
});
