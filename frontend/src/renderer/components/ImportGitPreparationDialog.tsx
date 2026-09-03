import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, ChevronLeft, CircleDashed, LoaderCircle, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	gitPrepActionLabel,
	gitPrepFailedEvent,
	latestGitPrepEventState,
	orderedGitPrepActions,
	prepareProjectGit,
	type GitPreparationEvent,
	type ImportValidationResult,
} from "../lib/import-onboarding";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type StepPhase = "idle" | "pending" | "running" | "success" | "error";

function sleep(ms: number) {
	return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export function ImportGitPreparationDialog({
	disabled,
	onBack,
	onComplete,
	onOpenChange,
	open,
	path,
	validation,
}: {
	disabled: boolean;
	onBack: () => void;
	onComplete: (validation: ImportValidationResult) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	path: string;
	validation: ImportValidationResult;
}) {
	const { t } = useTranslation();
	const requiredActions = useMemo(
		() => orderedGitPrepActions(validation.root.requiredActions),
		[validation.root.requiredActions],
	);
	const needsRemote = requiredActions.includes("set_remote");
	const [remoteUrl, setRemoteUrl] = useState("");
	const remoteMissing = needsRemote && remoteUrl.trim() === "";
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [isRunning, setIsRunning] = useState(false);
	const [events, setEvents] = useState<GitPreparationEvent[]>([]);
	const [visibleStepCount, setVisibleStepCount] = useState(0);

	useEffect(() => {
		if (!open) {
			setRemoteUrl("");
			setSubmitError(null);
			setIsRunning(false);
			setEvents([]);
			setVisibleStepCount(0);
		}
	}, [open]);

	const failedEvent = gitPrepFailedEvent(events);

	const stepPhase = (action: string, index: number): StepPhase => {
		if (!isRunning && events.length === 0) return "idle";
		if (index + 1 > visibleStepCount) return "pending";
		const state = latestGitPrepEventState(events, path, action);
		if (state === "error") return "error";
		if (state === "success") return "success";
		if (state === "running") return "running";
		return index + 1 === visibleStepCount ? "running" : "pending";
	};

	const run = async () => {
		if (remoteMissing) return;
		setSubmitError(null);
		setIsRunning(true);
		setEvents([]);
		setVisibleStepCount(0);
		try {
			const result = await prepareProjectGit({
				path,
				approvedActions: requiredActions,
				remoteUrl: needsRemote ? remoteUrl : undefined,
			});
			setEvents(result.events);
			for (let index = 0; index < requiredActions.length; index++) {
				setVisibleStepCount(index + 1);
				await sleep(220);
			}
			const failure = gitPrepFailedEvent(result.events);
			if (failure) {
				setSubmitError(failure.error ?? t("createProject.importGitFailed"));
				return;
			}
			if (result.validation.nextStep === "continue") {
				onComplete(result.validation);
			}
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : t("createProject.importGitFailed"));
		} finally {
			setIsRunning(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !next && !disabled && !isRunning && onOpenChange(false)}>
			<Dialog.Portal>
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay flex max-h-[min(640px,calc(100svh-24px))] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none">
					<div className="relative flex shrink-0 items-center gap-3 px-4 pt-3">
						<Button type="button" variant="outline" size="icon" aria-label={t("createProject.backToType")} disabled={disabled || isRunning} onClick={onBack}>
							<ChevronLeft className="size-4" aria-hidden="true" />
						</Button>
						<div className="min-w-0 flex-1 pr-8">
							<Dialog.Title className="text-balance text-[18px] font-semibold text-[var(--color-text-import-title)]">
								{t("createProject.importGitTitle")}
							</Dialog.Title>
							<Dialog.Description className="sr-only">{t("createProject.importGitDescription")}</Dialog.Description>
						</div>
						<button type="button" className="settings-close-button" aria-label={t("createProject.closeImport")} disabled={disabled || isRunning} onClick={() => onOpenChange(false)}>
							<X className="size-4" aria-hidden="true" />
						</button>
					</div>

					<form
						className="min-h-0 overflow-y-auto"
						onSubmit={(event) => {
							event.preventDefault();
							if (!isRunning && !remoteMissing) void run();
						}}
					>
						<div className="space-y-4 px-4 pb-1 pt-4">
							{submitError ? (
								<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-pretty text-[12px] leading-5 text-destructive" role="alert">
									{submitError}
								</div>
							) : null}

							<p className="text-pretty text-[12px] leading-5 text-[var(--color-text-import-muted)]">{t("createProject.importGitSummary")}</p>

							<div className="space-y-2">
								{requiredActions.map((action, index) => {
									const phase = stepPhase(action, index);
									return (
										<div key={action} className="flex items-center gap-3 rounded-md border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-card)] px-3 py-2.5">
											<GitPrepStepIcon phase={phase} />
											<span className="text-[13px] text-[var(--color-text-import-title)]">{gitPrepActionLabel(action, t)}</span>
										</div>
									);
								})}
							</div>

							{needsRemote ? (
								<div className="space-y-2">
									<Label htmlFor="importRemoteUrl" className="text-[13px] font-semibold text-[var(--color-text-import-title)]">
										{t("createProject.cloneRepositoryUrl")}
									</Label>
									<Input
										id="importRemoteUrl"
										autoCapitalize="none"
										autoComplete="off"
										className="bg-[var(--color-bg-import-card)] font-mono text-[13px]"
										disabled={disabled || isRunning}
										placeholder={t("createProject.cloneRepositoryUrlPlaceholder")}
										spellCheck={false}
										value={remoteUrl}
										onChange={(event) => {
											setRemoteUrl(event.target.value);
											if (submitError) setSubmitError(null);
										}}
									/>
								</div>
							) : null}
						</div>

						<div className="flex shrink-0 justify-end gap-2 px-4 pb-4 pt-3">
							<div className="flex items-center justify-end gap-3">
								{failedEvent ? (
									<Button type="button" variant="outline" disabled={disabled || isRunning} onClick={() => void run()}>
										{t("createProject.retry")}
									</Button>
								) : null}
								<Button type="submit" variant="primary" disabled={disabled || isRunning || remoteMissing}>
									{isRunning ? t("createProject.importGitRunning") : t("createProject.cloneContinue")}
								</Button>
							</div>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function GitPrepStepIcon({ phase }: { phase: StepPhase }) {
	if (phase === "success") return <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />;
	if (phase === "error") return <XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
	if (phase === "running") return <LoaderCircle className="size-4 shrink-0 animate-spin text-[var(--color-text-import-muted)]" aria-hidden="true" />;
	return <CircleDashed className={cn("size-4 shrink-0 text-[var(--color-text-import-muted)]", phase === "idle" && "opacity-70")} aria-hidden="true" />;
}
