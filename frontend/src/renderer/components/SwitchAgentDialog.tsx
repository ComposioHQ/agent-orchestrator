import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, TriangleAlert } from "lucide-react";
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
	open: boolean;
	session: WorkspaceSession;
	onOpenChange: (open: boolean) => void;
};

export function SwitchAgentDialog({ open, session, onOpenChange }: SwitchAgentDialogProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const noteId = useId();
	const modelId = useId();
	const defaultTargetHarness: SwitchAgentHarness = session.provider === "claude-code" ? "codex" : "claude-code";
	const [targetHarness, setTargetHarness] = useState<SwitchAgentHarness>(defaultTargetHarness);
	const [model, setModel] = useState("");
	const [mode, setMode] = useState("");
	const [modelWarning, setModelWarning] = useState<string | undefined>();
	const [note, setNote] = useState("");
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
	const routeSource = durableSwitch?.fromHarness ?? session.provider;
	const routeTarget = durableSwitch?.targetHarness ?? targetHarness;

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
				note,
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
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && admissionPending) return;
				onOpenChange(nextOpen);
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none">
					<Dialog.Title className="settings-dialog-title px-4 pt-3">{t("switchAgent.title")}</Dialog.Title>
					<Dialog.Description className="sr-only">
						{t("switchAgent.description", { current: agentLabel(session.provider) })}
					</Dialog.Description>
					<p className="px-4 pt-1 text-caption text-muted-foreground">
						{agentLabel(routeSource)} <span aria-hidden="true">→</span> {agentLabel(routeTarget)}
					</p>

					{showComposer ? (
						<form className="composer-prompt-surface flex flex-col" onSubmit={submit}>
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
							<label className="sr-only" htmlFor={noteId}>
								{t("switchAgent.noteLabel")}
							</label>
							<textarea
								id={noteId}
								autoFocus
								className="min-h-(--size-composer-prompt-min) w-full resize-none bg-transparent px-4 pb-3 pt-4 text-md leading-relaxed text-foreground outline-none placeholder:text-passive disabled:cursor-not-allowed disabled:opacity-50"
								disabled={admissionPending}
								maxLength={4096}
								onChange={(event) => {
									clearFailedAttempt();
									setNote(event.target.value);
								}}
								onKeyDown={(event) => {
									if (
										event.key === "Enter" &&
										!event.shiftKey &&
										!event.altKey &&
										!event.nativeEvent.isComposing
									) {
										event.preventDefault();
										event.currentTarget.form?.requestSubmit();
									}
								}}
								placeholder={t("switchAgent.notePlaceholder")}
								value={note}
							/>

							{error || statusError || modelWarning ? (
								<div className="px-4 pb-2">
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

							<div className="composer-toolbar">
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
									className="h-(--size-settings-action-height) px-3"
									disabled={admissionPending}
									onClick={() => onOpenChange(false)}
									size="none"
									type="button"
									variant="outline"
								>
									{t("confirm.cancel")}
								</Button>
								<Button
									className="h-(--size-settings-action-height) min-w-(--size-composer-start-button) px-3"
									disabled={admissionPending}
									size="none"
									type="submit"
									variant="primary"
								>
									{admissionPending ? (
										<LoaderCircle className="size-icon-base animate-spin" aria-hidden="true" />
									) : null}
									{admissionPending ? t("newTask.starting") : t("switchAgent.confirm")}
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
							<Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="self-end">
								{t("switchAgent.closeButton")}
							</Button>
						</div>
					) : checkingStatus ? (
						<div className="flex flex-col gap-4 px-4 pb-3 pt-4">
							<div className="inline-flex items-center gap-2 text-control text-muted-foreground" role="status">
								<LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />
								{t("switchAgent.checkingStatus")}
							</div>
							<Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="self-end">
								{t("switchAgent.closeButton")}
							</Button>
						</div>
					) : null}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
