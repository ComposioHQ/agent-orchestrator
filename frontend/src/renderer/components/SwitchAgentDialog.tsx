import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Repeat2, TriangleAlert, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	createSwitchAgentIdempotencyKey,
	clearSwitchAgentState,
	type SwitchAgentHarness,
	useSwitchAgent,
	useSwitchAgentState,
} from "../hooks/useSwitchAgent";
import {
	findActiveAgentSwitch,
	findRecoveryRequiredAgentSwitch,
	useAgentSwitches,
} from "../hooks/useAgentSwitches";
import { AGENT_LABELS, AGENT_OPTIONS, agentLabel } from "../lib/agent-options";
import { deriveAgentSwitchPresentation } from "../lib/agent-switch-presentation";
import type { WorkspaceSession } from "../types/workspace";
import { AgentAvatar } from "./AgentAvatar";
import { AgentModelPicker } from "./AgentModelPicker";
import { SettingsOptionMenu } from "./settings/SettingsOptionMenu";
import { Button } from "./ui/button";

export const SWITCH_AGENT_OPTIONS = [
	{ value: "claude-code", label: "Claude Code" },
	{ value: "codex", label: "Codex" },
] as const satisfies ReadonlyArray<{ value: SwitchAgentHarness; label: string }>;

const ALL_SWITCH_AGENT_OPTIONS = AGENT_OPTIONS.map((value) => ({ value, label: AGENT_LABELS[value] }));

export function canSwitchAgentHarness(value: string): value is SwitchAgentHarness {
	return SWITCH_AGENT_OPTIONS.some((option) => option.value === value);
}

function SwitchTargetPicker({
	currentHarness,
	disabled,
	onChange,
	value,
}: {
	currentHarness: string;
	disabled: boolean;
	onChange: (value: SwitchAgentHarness) => void;
	value: SwitchAgentHarness;
}) {
	const { t } = useTranslation();
	const options = ALL_SWITCH_AGENT_OPTIONS.map((option) => ({
		...option,
		disabled: !canSwitchAgentHarness(option.value) || option.value === currentHarness,
	}));
	const selected = options.find((option) => option.value === value);
	return (
		<SettingsOptionMenu
			aria-label={t("switchAgent.targetLabel")}
			disabled={disabled}
			menuAlign="start"
			menuClassName="settings-agent-menu-surface"
			menuItemClassName="settings-agent-menu-item"
			onChange={(nextValue) => {
				if (canSwitchAgentHarness(nextValue) && nextValue !== currentHarness) onChange(nextValue);
			}}
			options={options}
			renderMenuItem={(option) => {
				const supported = canSwitchAgentHarness(option.value);
				const current = option.value === currentHarness;
				return (
					<span className="flex w-full min-w-0 items-center gap-2">
						<AgentAvatar className="size-icon-base" decorative provider={option.value} />
						<span className="min-w-0 flex-1 truncate">{option.label}</span>
						{!supported ? (
							<span className="shrink-0 text-micro text-settings-muted">
								<span className="sr-only">, </span>
								{t("switchAgent.comingSoon")}
							</span>
						) : current ? (
							<span className="shrink-0 text-micro text-settings-muted">
								<span className="sr-only">, </span>
								{t("switchAgent.current")}
							</span>
						) : null}
					</span>
				);
			}}
			renderTrigger={() => (
				<span className="flex min-w-0 items-center gap-2">
					<AgentAvatar className="size-icon-base" decorative provider={value} />
					<span className="min-w-0 truncate text-control text-foreground" title={selected?.label}>
						{selected?.label}
					</span>
				</span>
			)}
			triggerClassName="composer-chip composer-toolbar-option w-full justify-between"
			value={value}
		/>
	);
}

type SwitchAgentDialogProps = {
	container: HTMLElement;
	open: boolean;
	session: WorkspaceSession;
	onOpenChange: (open: boolean) => void;
};

export function SwitchAgentDialog({ container, open, session, onOpenChange }: SwitchAgentDialogProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const modelId = useId();
	const defaultTargetHarness: SwitchAgentHarness = session.provider === "claude-code" ? "codex" : "claude-code";
	const [targetHarness, setTargetHarness] = useState<SwitchAgentHarness>(defaultTargetHarness);
	const [model, setModel] = useState("");
	const [mode, setMode] = useState("");
	const [modelWarning, setModelWarning] = useState<string | undefined>();
	const switchAgent = useSwitchAgent();
	const switchMutation = useSwitchAgentState(session.id);
	const switchesQuery = useAgentSwitches(session.id);
	const switches = switchesQuery.data ?? [];
	const activeHistorySwitch = findActiveAgentSwitch(switches);
	const recoveryHistorySwitch = findRecoveryRequiredAgentSwitch(switches);
	const detailedSessionSwitch = session.activeAgentSwitch
		? switches.find((entry) => entry.id === session.activeAgentSwitch?.id)
		: undefined;
	const durableSwitch =
		detailedSessionSwitch ?? session.activeAgentSwitch ?? recoveryHistorySwitch ?? activeHistorySwitch;
	const checkingStatus = switchesQuery.isPending && !durableSwitch;
	const admissionPending = switchMutation.isPending;
	const durablePresentation = durableSwitch
		? deriveAgentSwitchPresentation({
				agentSwitch: durableSwitch,
				activityState: session.activity?.state,
				currentHarness: session.provider,
				isTerminated: session.isTerminated ?? false,
				terminalHandleId: session.terminalHandleId,
			})
		: undefined;
	const clearFailedAttempt = () => {
		if (!switchMutation.error) return;
		clearSwitchAgentState(queryClient, session.id);
	};

	const changeTarget = (nextTarget: SwitchAgentHarness) => {
		clearFailedAttempt();
		setTargetHarness(nextTarget);
		setModel("");
		setMode("");
		setModelWarning(undefined);
	};

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (admissionPending || checkingStatus || durableSwitch) return;
		switchAgent.mutate(
			{
				session,
				targetHarness,
				model: model.trim() || mode.trim(),
				idempotencyKey: createSwitchAgentIdempotencyKey(),
			},
			{ onSuccess: () => onOpenChange(false) },
		);
	};

	const error = switchMutation.error;
	const statusError = switchesQuery.error instanceof Error ? switchesQuery.error.message : null;
	const showComposer = admissionPending || (!durablePresentation && !checkingStatus);

	return (
		<Dialog.Root
			modal={false}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && admissionPending) return;
				onOpenChange(nextOpen);
			}}
			open={open}
		>
			<Dialog.Portal container={container}>
				<div
					aria-hidden="true"
					className="agent-switch-terminal-scrim absolute inset-0 z-20 animate-overlay-in motion-reduce:animate-none"
					data-testid="switch-agent-terminal-backdrop"
				/>
				<Dialog.Content className="absolute left-1/2 top-1/2 z-overlay w-dialog-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border-strong bg-surface/95 p-0 text-foreground shadow-xl shadow-black/20 data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none">
				<Dialog.Close asChild>
					<button
						aria-label={t("switchAgent.close")}
						className="settings-dialog-close-button settings-close-button"
						disabled={admissionPending}
						type="button"
					>
						<X className="size-icon-base" aria-hidden="true" />
					</button>
				</Dialog.Close>
				<Dialog.Title className="settings-dialog-title px-4 pr-12 pt-3">
					{t("switchAgent.title")}
				</Dialog.Title>
				<Dialog.Description className="px-4 pr-12 pt-0.5 text-caption leading-4 text-muted-foreground">
					{t("switchAgent.description", { current: agentLabel(session.provider) })}
				</Dialog.Description>

				{showComposer ? (
					<form className="flex flex-col gap-3 px-4 pb-4 pt-4" onSubmit={submit}>
							{admissionPending && durablePresentation ? (
								<div
									aria-label={t(durablePresentation.compactLabelKey, durablePresentation.values)}
									className="flex items-start gap-2 px-4 pt-3"
									role="status"
								>
									<LoaderCircle className="mt-0.5 size-icon-sm shrink-0 animate-spin" aria-hidden="true" />
									<div>
										<div className="text-control font-medium text-foreground">
											{t(durablePresentation.titleKey, durablePresentation.values)}
										</div>
										<p className="mt-0.5 text-caption leading-4 text-muted-foreground">
											{t(durablePresentation.descriptionKey, durablePresentation.values)}
										</p>
									</div>
								</div>
							) : null}
							{error || statusError || modelWarning ? (
								<div>
									{error ? (
										<p className="text-caption leading-4 text-error" role="alert">
											{error}
										</p>
									) : null}
									{!error && statusError ? (
										<p className="text-caption leading-4 text-error" role="alert">
											{statusError}
										</p>
									) : null}
									{!error && !statusError && modelWarning ? (
										<p className="text-caption text-warning">{modelWarning}</p>
									) : null}
								</div>
							) : null}

							<div className="composer-toolbar p-0!">
								<div className="composer-run-controls" role="group" aria-label={t("newTask.runsWith")}>
									<div className="composer-toolbar-slot">
										<SwitchTargetPicker
											currentHarness={session.provider}
											disabled={admissionPending}
											onChange={changeTarget}
											value={targetHarness}
										/>
									</div>
									<span className="composer-toolbar-divider" aria-hidden="true" />
									<div className="composer-toolbar-slot">
										<AgentModelPicker
											agentId={targetHarness}
											agentLabel={agentLabel(targetHarness)}
											disabled={admissionPending}
											id={modelId}
											mode={mode}
											onModeChange={(value) => {
												clearFailedAttempt();
												setMode(value);
												setModel("");
											}}
											onModelChange={(value) => {
												clearFailedAttempt();
												setModel(value);
												setMode("");
											}}
											onWarningChange={setModelWarning}
											projectId={session.workspaceId}
											value={model}
										/>
									</div>
								</div>
								<Button
									aria-label={admissionPending ? t("newTask.starting") : t("switchAgent.confirm")}
									className="size-(--size-settings-action-height)"
									disabled={admissionPending}
									size="none"
									title={admissionPending ? t("newTask.starting") : t("switchAgent.confirm")}
									type="submit"
									variant="primary"
								>
									{admissionPending ? (
										<LoaderCircle className="size-icon-base animate-spin" aria-hidden="true" />
									) : (
										<Repeat2 className="size-4 stroke-[1.8]" aria-hidden="true" />
									)}
								</Button>
							</div>
						</form>
					) : durablePresentation ? (
						<div className="flex flex-col gap-4 px-4 pb-3 pt-4">
							<div
								aria-label={t(durablePresentation.compactLabelKey, durablePresentation.values)}
								className={
									durablePresentation.outcome === "recovery"
										? "flex items-start gap-2 rounded-md border border-warning/35 bg-warning/5 px-3 py-2.5"
										: "flex items-start gap-2 py-1"
								}
								role={durablePresentation.outcome === "recovery" ? "alert" : "status"}
							>
								{durablePresentation.outcome === "recovery" ? (
									<TriangleAlert className="mt-0.5 size-icon-sm shrink-0 text-warning" aria-hidden="true" />
								) : durablePresentation.animate ? (
									<LoaderCircle className="mt-0.5 size-icon-sm shrink-0 animate-spin" aria-hidden="true" />
								) : null}
								<div>
									<div className="text-control font-medium text-foreground">
										{t(durablePresentation.titleKey, durablePresentation.values)}
									</div>
									<p className="mt-0.5 text-caption leading-4 text-muted-foreground">
										{t(durablePresentation.descriptionKey, durablePresentation.values)}
									</p>
								</div>
							</div>
						</div>
					) : checkingStatus ? (
						<div className="flex flex-col gap-4 px-4 pb-3 pt-4">
							<div className="inline-flex items-center gap-2 text-control text-muted-foreground" role="status">
								<LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />
								{t("switchAgent.checkingStatus")}
							</div>
						</div>
					) : null}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
