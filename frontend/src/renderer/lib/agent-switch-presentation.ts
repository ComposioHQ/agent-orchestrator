import { agentSwitchErrorLabelKeys, type AgentSwitchErrorCode } from "../i18n/key-maps";
import type { MessageKey } from "../i18n/messages";
import type { AgentSwitchSummary, WorkspaceSession } from "../types/workspace";
import { agentLabel } from "./agent-options";

export type AgentSwitchPresentation = {
	stage:
		| "preparing"
		| "stopping_source"
		| "starting_target"
		| "confirming_takeover"
		| "needs_attention"
		| null;
	outcome: "in_progress" | "success" | "failure" | "recovery";
	compactLabelKey: MessageKey;
	titleKey: MessageKey;
	descriptionKey: MessageKey;
	values: {
		source: string;
		target: string;
	};
	tone: "working" | "success" | "warning" | "danger";
	animate: boolean;
	lockAgentTerminal: boolean;
	allowSourceInput: boolean;
};

export type AgentSwitchPresentationInput = {
	agentSwitch: AgentSwitchSummary;
	currentHarness: string;
	activityState?: string;
	terminalHandleId?: string;
	isTerminated: boolean;
};

export type AgentSwitchStatusView = {
	breathe: boolean;
	color: string;
	indicatorClassName: string;
	textClassName: string;
};

const statusViewByTone: Record<AgentSwitchPresentation["tone"], Omit<AgentSwitchStatusView, "breathe">> = {
	working: {
		color: "var(--color-status-working)",
		indicatorClassName: "bg-status-working animate-status-pulse",
		textClassName: "text-status-working",
	},
	warning: {
		color: "var(--color-status-needs-you)",
		indicatorClassName: "bg-status-needs-you",
		textClassName: "text-status-needs-you",
	},
	danger: {
		color: "var(--color-status-exited)",
		indicatorClassName: "bg-status-exited",
		textClassName: "text-status-exited",
	},
	success: {
		color: "var(--color-status-merged)",
		indicatorClassName: "bg-status-merged",
		textClassName: "text-status-merged",
	},
};

export function getAgentSwitchStatusView(
	presentation: AgentSwitchPresentation,
): AgentSwitchStatusView {
	return {
		...statusViewByTone[presentation.tone],
		breathe: presentation.animate && presentation.tone === "working",
	};
}

const inProgressDescriptions: Partial<Record<string, MessageKey>> = {
	preparing_handoff: "switchAgent.state.preparingHandoff",
	stopping_source: "switchAgent.state.stoppingSource",
	source_stopped: "switchAgent.state.sourceStopped",
	starting_target: "switchAgent.state.startingTarget",
	target_ready: "switchAgent.state.targetReady",
	delivering_context: "switchAgent.state.deliveringContext",
};

function failureDescriptionKey(errorCode?: string): MessageKey {
	if (!errorCode) return "switchAgent.state.failed";
	return agentSwitchErrorLabelKeys[errorCode as AgentSwitchErrorCode] ?? "switchAgent.state.failed";
}

export function deriveAgentSwitchPresentation({
	agentSwitch,
	currentHarness,
	activityState,
	terminalHandleId,
	isTerminated,
}: AgentSwitchPresentationInput): AgentSwitchPresentation {
	const values = {
		source: agentLabel(agentSwitch.fromHarness),
		target: agentLabel(agentSwitch.targetHarness),
	};

	if (agentSwitch.state === "starting_target" && agentSwitch.errorCode === "target_start_unconfirmed") {
		return {
			stage: "needs_attention",
			outcome: "recovery",
			compactLabelKey: "switchAgent.recovery.compact",
			titleKey: "switchAgent.recovery.title",
			descriptionKey: "switchAgent.recovery.description",
			values,
			tone: "warning",
			animate: false,
			lockAgentTerminal: true,
			allowSourceInput: false,
		};
	}

	if (agentSwitch.state === "failed") {
		return {
			stage: "needs_attention",
			outcome: "failure",
			compactLabelKey: "switchAgent.failure.compact",
			titleKey: "switchAgent.state.failed",
			descriptionKey: failureDescriptionKey(agentSwitch.errorCode),
			values,
			tone: "danger",
			animate: false,
			lockAgentTerminal: false,
			allowSourceInput: false,
		};
	}

	if (agentSwitch.state === "completed") {
		const settled =
			currentHarness === agentSwitch.targetHarness &&
			Boolean(terminalHandleId?.trim()) &&
			!isTerminated;
		return {
			stage: settled ? null : "confirming_takeover",
			outcome: settled ? "success" : "in_progress",
			compactLabelKey: settled ? "switchAgent.success.compact" : "switchAgent.compact.switching",
			titleKey: settled ? "switchAgent.success.compact" : "switchAgent.progressTitle",
			descriptionKey: "switchAgent.state.completed",
			values,
			tone: settled ? "success" : "working",
			animate: !settled,
			lockAgentTerminal: !settled,
			allowSourceInput: false,
		};
	}

	if (agentSwitch.state === "preparing_handoff" && agentSwitch.agentHandoffStatus === "requested") {
		const allowSourceInput = activityState === "blocked" || activityState === "waiting_input";
		return {
			stage: "preparing",
			outcome: "in_progress",
			compactLabelKey: allowSourceInput ? "switchAgent.sourceInput.compact" : "switchAgent.compact.switching",
			titleKey: "switchAgent.progressTitle",
			descriptionKey: allowSourceInput
				? "switchAgent.permissionRequired"
				: "switchAgent.state.preparingHandoff",
			values,
			tone: allowSourceInput ? "warning" : "working",
			animate: true,
			lockAgentTerminal: !allowSourceInput,
			allowSourceInput,
		};
	}

	let stage: AgentSwitchPresentation["stage"] | undefined;
	switch (agentSwitch.state) {
		case "preparing_handoff":
			stage = "preparing";
			break;
		case "stopping_source":
			stage = "stopping_source";
			break;
		case "source_stopped":
		case "starting_target":
			stage = "starting_target";
			break;
		case "target_ready":
		case "delivering_context":
			stage = "confirming_takeover";
			break;
	}

	if (stage) {
		return {
			stage,
			outcome: "in_progress",
			compactLabelKey: "switchAgent.compact.switching",
			titleKey: "switchAgent.progressTitle",
			descriptionKey: inProgressDescriptions[agentSwitch.state] ?? "switchAgent.checkingStatus",
			values,
			tone: "working",
			animate: true,
			lockAgentTerminal: true,
			allowSourceInput: false,
		};
	}

	return {
		stage: "preparing",
		outcome: "in_progress",
		compactLabelKey: "switchAgent.refreshOnly.compact",
		titleKey: "switchAgent.checkingStatus",
		descriptionKey: "switchAgent.checkingStatus",
		values,
		tone: "working",
		animate: true,
		lockAgentTerminal: true,
		allowSourceInput: false,
	};
}

export function deriveSessionAgentSwitchPresentation(
	session: WorkspaceSession,
): AgentSwitchPresentation | undefined {
	if (!session.activeAgentSwitch) return undefined;
	return deriveAgentSwitchPresentation({
		agentSwitch: session.activeAgentSwitch,
		activityState: session.activity?.state,
		currentHarness: session.provider,
		isTerminated: Boolean(session.isTerminated),
		terminalHandleId: session.terminalHandleId,
	});
}
