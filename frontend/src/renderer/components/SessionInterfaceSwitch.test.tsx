import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SessionInterfaceTransition } from "../hooks/useSessionInterfaceTransition";
import { SessionInterfaceSwitchButton } from "./SessionInterfaceSwitch";
import { TooltipProvider } from "./ui/tooltip";

function renderSwitch(props: ComponentProps<typeof SessionInterfaceSwitchButton>) {
	return render(
		<TooltipProvider delayDuration={0}>
			<SessionInterfaceSwitchButton {...props} />
		</TooltipProvider>,
	);
}

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
		renderSwitch({
			target: "chat",
			supported: true,
			transition: transition("draining"),
			onClick: vi.fn(),
			onCancel,
		});

		expect(screen.getByRole("status")).toHaveTextContent("Waiting to switch… Chat UI");
		const cancel = screen.getByRole("button", { name: "Cancel switch to Chat UI" });
		fireEvent.click(cancel);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("stays non-interactive after the source controller begins stopping", () => {
		renderSwitch({
			target: "chat",
			supported: true,
			transition: transition("source_stopping"),
			onClick: vi.fn(),
			onCancel: vi.fn(),
		});

		expect(screen.getByRole("status")).toHaveTextContent("Stopping controller… Chat UI");
		expect(screen.queryByRole("button", { name: "Cancel switch to Chat UI" })).not.toBeInTheDocument();
	});

	it.each([
		["chat", "Switch to chat UI", "lucide-message-square"],
		["tui", "Switch to terminal UI", "lucide-square-terminal"],
	] as const)("uses an icon-only destination control for %s", (target, label, iconClass) => {
		const onClick = vi.fn();
		renderSwitch({ target, supported: true, onClick });

		const button = screen.getByRole("button", { name: label });
		expect(button).toHaveTextContent(/^$/);
		expect(button.querySelector("svg")).toHaveClass(iconClass);
		expect(button).toHaveAttribute("title", `${label} using this agent's native conversation`);
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("explains the UI switch on hover", async () => {
		renderSwitch({ target: "chat", supported: true, onClick: vi.fn() });

		await userEvent.hover(screen.getByRole("button", { name: "Switch to chat UI" }));
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			"Switch to chat UI using this agent's native conversation",
		);
	});
});
