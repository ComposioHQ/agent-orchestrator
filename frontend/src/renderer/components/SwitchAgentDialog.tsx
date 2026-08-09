import { ArrowLeftRight, FileWarning, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
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
	isTerminalAgentSwitch,
	useAgentSwitches,
} from "../hooks/useAgentSwitches";
import { AGENT_LABELS, AGENT_OPTIONS, agentLabel } from "../lib/agent-options";
import { deriveAgentSwitchPresentation } from "../lib/agent-switch-presentation";
import type { AgentSwitchSummary, WorkspaceSession } from "../types/workspace";
import { AgentAvatar } from "./AgentAvatar";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogFooterClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export const SWITCH_AGENT_OPTIONS = [
	{ value: "claude-code", label: "Claude Code" },
	{ value: "codex", label: "Codex" },
] as const satisfies ReadonlyArray<{ value: SwitchAgentHarness; label: string }>;

const ALL_SWITCH_AGENT_OPTIONS = AGENT_OPTIONS.map((value) => ({ value, label: AGENT_LABELS[value] }));

export function canSwitchAgentHarness(value: string): value is SwitchAgentHarness {
	return SWITCH_AGENT_OPTIONS.some((option) => option.value === value);
}

function usedFallbackContext(agentSwitch: AgentSwitchSummary<string>): boolean {
	return (
		agentSwitch.state === "completed" &&
		!agentSwitch.semanticHandoffIncluded &&
		agentSwitch.sourceTranscriptStatus === "unavailable"
	);
}

type SwitchAgentDialogProps = {
	open: boolean;
	session: WorkspaceSession;
	onOpenChange: (open: boolean) => void;
};

export function SwitchAgentDialog({
	open,
	session,
	onOpenChange,
}: SwitchAgentDialogProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const noteId = useId();
	const targetId = useId();
	const historyId = useId();
	const defaultTargetHarness: SwitchAgentHarness = session.provider === "claude-code" ? "codex" : "claude-code";
	const [targetHarness, setTargetHarness] = useState<SwitchAgentHarness>(defaultTargetHarness);
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
	const terminalHistory = switches.filter(isTerminalAgentSwitch).slice(0, 5);
	const checkingStatus = switchesQuery.isPending && !durableSwitch;
	const admissionPending = switchMutation.isPending && !durableSwitch;
	const durablePresentation = durableSwitch
		? deriveAgentSwitchPresentation({
				agentSwitch: durableSwitch,
				activityState: session.activity?.state,
				currentHarness: session.provider,
				isTerminated: session.isTerminated ?? false,
				terminalHandleId: session.terminalHandleId,
			})
		: undefined;
	const presentationFor = (agentSwitch: AgentSwitchSummary<string>) =>
		deriveAgentSwitchPresentation({
			agentSwitch,
			activityState: session.activity?.state,
			currentHarness: session.provider,
			isTerminated: session.isTerminated ?? false,
			terminalHandleId: session.terminalHandleId,
		});

	const clearFailedAttempt = () => {
		if (!switchMutation.error) return;
		clearSwitchAgentState(queryClient, session.id);
	};

	const submit = () => {
		if (admissionPending || checkingStatus || durableSwitch) return;
		switchAgent.mutate(
			{
				session,
				targetHarness,
				note,
				idempotencyKey: createSwitchAgentIdempotencyKey(),
			},
			{ onSuccess: () => onOpenChange(false) },
		);
	};

	const error = switchMutation.error;
	const historyError = switchesQuery.error instanceof Error ? switchesQuery.error.message : null;

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && admissionPending) return;
				onOpenChange(nextOpen);
			}}
		>
			<DialogContent showCloseButton={false} className={settingsDialogContentClass}>
				<DialogClose asChild>
					<button
						type="button"
						className="settings-dialog-close-button settings-close-button"
						aria-label={t("switchAgent.close")}
						disabled={admissionPending}
					>
						<X className="size-5" aria-hidden="true" />
					</button>
				</DialogClose>

				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<div className={settingsDialogHeaderClass}>
						<DialogTitle className="settings-dialog-title">{t("switchAgent.title")}</DialogTitle>
						<DialogDescription className="text-control leading-4 text-settings-muted">
							{t("switchAgent.description", { current: agentLabel(session.provider) })}
						</DialogDescription>
					</div>

					<div className={settingsDialogBodyClass}>
						{durablePresentation ? (
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
									<p className="mt-0.5 text-caption leading-4 text-settings-muted">
										{t(durablePresentation.descriptionKey, durablePresentation.values)}
									</p>
								</div>
							</div>
						) : checkingStatus ? (
							<div className="inline-flex items-center gap-2 text-control text-settings-muted" role="status">
								<LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />
								{t("switchAgent.checkingStatus")}
							</div>
						) : (
							<>
								<div className="flex flex-col gap-1.5">
									<label className="settings-field-label" htmlFor={targetId}>
										{t("switchAgent.targetLabel")}
									</label>
									<Select
										disabled={admissionPending}
										onValueChange={(value) => {
											if (!canSwitchAgentHarness(value) || value === session.provider) return;
											clearFailedAttempt();
											setTargetHarness(value);
										}}
										value={targetHarness}
									>
										<SelectTrigger id={targetId} className="settings-field-control w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent
											align="start"
											className="max-h-64 w-(--radix-select-trigger-width) [&_[data-slot=select-scroll-down-button]]:hidden [&_[data-slot=select-scroll-up-button]]:hidden"
											position="popper"
										>
											{ALL_SWITCH_AGENT_OPTIONS.map((option) => {
												const supported = canSwitchAgentHarness(option.value);
												const current = option.value === session.provider;
												return (
													<SelectItem
														className="[&>span:last-child]:w-full"
														disabled={!supported || current}
														key={option.value}
														value={option.value}
													>
														<span className="flex w-full items-center gap-2">
															<AgentAvatar className="size-icon-lg" decorative provider={option.value} />
															<span className="min-w-0 flex-1 truncate">{option.label}</span>
															{!supported ? (
																<>
																	<span className="sr-only">, </span>
																	<span className="shrink-0 text-micro text-settings-muted">
																		{t("switchAgent.comingSoon")}
																	</span>
																</>
															) : current ? (
																<>
																	<span className="sr-only">, </span>
																	<span className="shrink-0 text-micro text-settings-muted">
																		{t("switchAgent.current")}
																	</span>
																</>
															) : null}
														</span>
													</SelectItem>
												);
											})}
										</SelectContent>
									</Select>
								</div>

								<div className="flex flex-col items-start gap-1.5">
									<label className="settings-field-label" htmlFor={noteId}>
										{t("switchAgent.noteLabel")}
									</label>
									<textarea
										id={noteId}
										className="settings-field-control min-h-(--size-textarea-min) resize-y py-2.5"
										disabled={admissionPending}
										maxLength={4096}
										onChange={(event) => {
											clearFailedAttempt();
											setNote(event.target.value);
										}}
										placeholder={t("switchAgent.notePlaceholder")}
										value={note}
									/>
								</div>
							</>
						)}

						{terminalHistory.length > 0 ? (
							<section aria-labelledby={historyId} className="flex flex-col gap-1.5">
								<h3 className="settings-field-label" id={historyId}>
									{t("switchAgent.historyTitle")}
								</h3>
								<ul className="max-h-36 divide-y divide-border/60 overflow-y-auto" data-testid="agent-switch-history">
									{terminalHistory.map((entry) => {
										const presentation = presentationFor(entry);
										return (
											<li className="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0" key={entry.id}>
												<div className="min-w-0">
													<div className="truncate text-caption text-foreground/80">
														{t("switchAgent.historyEntry", {
															source: agentLabel(entry.fromHarness),
															target: agentLabel(entry.targetHarness),
														})}
													</div>
													{usedFallbackContext(entry) ? (
														<span className="mt-0.5 inline-flex items-center gap-1 text-micro text-warning/90">
															<FileWarning className="size-3" aria-hidden="true" />
															{t("switchAgent.historyFallbackContext")}
														</span>
													) : null}
												</div>
												<span className="shrink-0 text-micro text-settings-muted">
													{t(presentation.descriptionKey, presentation.values)}
												</span>
											</li>
										);
									})}
								</ul>
							</section>
						) : null}

						{error ? (
							<p className="text-caption leading-4 text-error" role="alert">
								{error}
							</p>
						) : null}
						{historyError ? (
							<p className="text-caption leading-4 text-error" role="alert">
								{historyError}
							</p>
						) : null}
					</div>

					<div className={settingsDialogFooterClass}>
						<DialogClose asChild>
							<button className="settings-footer-button" disabled={admissionPending} type="button">
								{durablePresentation || checkingStatus || admissionPending
									? t("switchAgent.closeButton")
									: t("confirm.cancel")}
							</button>
						</DialogClose>
						{!durablePresentation && !checkingStatus ? (
							<button
								className="settings-footer-button settings-footer-button-primary"
								disabled={admissionPending}
								type="submit"
							>
								{admissionPending ? (
									<LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />
								) : (
									<ArrowLeftRight className="size-icon-sm" aria-hidden="true" />
								)}
								{admissionPending ? t("newTask.starting") : t("switchAgent.confirm")}
							</button>
						) : null}
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
