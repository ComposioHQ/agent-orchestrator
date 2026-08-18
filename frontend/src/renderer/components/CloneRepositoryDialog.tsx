import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, Folder, GitBranch, Link2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../lib/bridge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type CloneRepositoryDetails = {
	remoteUrl: string;
	destinationParent: string;
};

export type CloneRepositorySelection = CloneRepositoryDetails & {
	targetPath: string;
};

export const LAST_CLONE_DESTINATION_KEY = "ao.clone.lastDestinationParent";

export default function CloneRepositoryDialog({
	disabled,
	error,
	onBack,
	onChange,
	onClose,
	onContinue,
	open,
	value,
}: {
	disabled: boolean;
	error: string | null;
	onBack: () => void;
	onChange: (value: CloneRepositoryDetails) => void;
	onClose: () => void;
	onContinue: (selection: CloneRepositorySelection) => void;
	open: boolean;
	value: CloneRepositoryDetails;
}) {
	const { t } = useTranslation();
	const [submitted, setSubmitted] = useState(false);
	const [choosingDestination, setChoosingDestination] = useState(false);
	const [destinationPickerError, setDestinationPickerError] = useState<string | null>(null);
	const repositoryName = repositoryNameFromGitUrl(value.remoteUrl);
	const targetPath = repositoryName && value.destinationParent
		? joinCloneDestination(value.destinationParent, repositoryName)
		: "";
	const urlError = submitted && !repositoryName ? t("createProject.cloneInvalidUrl") : null;
	const destinationError = submitted && !value.destinationParent ? t("createProject.cloneDestinationRequired") : null;

	const chooseDestination = async () => {
		setDestinationPickerError(null);
		setChoosingDestination(true);
		try {
			const selected = await aoBridge.app.chooseDirectory(t("createProject.cloneChooseDestination"));
			if (!selected) return;
			try {
				window.localStorage.setItem(LAST_CLONE_DESTINATION_KEY, selected);
			} catch {
				// Remembering the folder is a convenience; cloning still works if
				// browser storage is unavailable.
			}
			onChange({ ...value, destinationParent: selected });
		} catch (err) {
			setDestinationPickerError(err instanceof Error ? err.message : t("createProject.couldNotAdd"));
		} finally {
			setChoosingDestination(false);
		}
	};

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setSubmitted(true);
		if (!repositoryName || !value.destinationParent || disabled) return;
		onContinue({
			...value,
			remoteUrl: value.remoteUrl.trim(),
			targetPath: joinCloneDestination(value.destinationParent, repositoryName),
		});
	};

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !next && !disabled && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay flex max-h-[min(640px,calc(100svh-24px))] w-[min(var(--size-import-folder-dialog),calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-welcome-panel border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-modal)] p-0 text-[var(--color-text-import-title)] shadow-[var(--shadow-import-modal)] data-[state=open]:animate-modal-in">
					<div className="flex shrink-0 items-start gap-4 border-b border-[var(--color-border-import-modal)] p-(--size-import-dialog-padding)">
						<Button
							type="button"
							variant="outline"
							size="icon"
							aria-label={t("createProject.cloneBack")}
							disabled={disabled || choosingDestination}
							onClick={onBack}
						>
							<ChevronLeft className="size-4" aria-hidden="true" />
						</Button>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="text-balance text-[18px] font-semibold text-[var(--color-text-import-title)]">
								{t("createProject.cloneTitle")}
							</Dialog.Title>
							<Dialog.Description className="mt-1 max-w-[520px] text-pretty text-[13px] font-medium leading-5 text-[var(--color-text-import-muted)]">
								{t("createProject.cloneDescription")}
							</Dialog.Description>
						</div>
						<button
							type="button"
							className="settings-close-button"
							aria-label={t("createProject.cloneClose")}
							disabled={disabled || choosingDestination}
							onClick={onClose}
						>
							<X className="size-4" aria-hidden="true" />
						</button>
					</div>

					<form className="min-h-0 overflow-y-auto" onSubmit={submit}>
						<div className="space-y-5 p-(--size-import-dialog-padding)">
							{error || destinationPickerError ? (
								<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-pretty text-[12px] leading-5 text-destructive" role="alert">
									{destinationPickerError ?? error}
								</div>
							) : null}

							<div className="space-y-2">
								<Label htmlFor="cloneRepositoryUrl" className="text-[13px] font-semibold text-[var(--color-text-import-title)]">
									{t("createProject.cloneRepositoryUrl")}
								</Label>
								<div className="relative">
									<span className="pointer-events-none absolute inset-y-0 left-3 flex w-4 items-center justify-center text-[var(--color-text-import-muted)]">
										<Link2 className="size-4" aria-hidden="true" />
									</span>
									<Input
										id="cloneRepositoryUrl"
										autoFocus
										autoCapitalize="none"
										autoComplete="off"
										aria-describedby={urlError ? "cloneRepositoryUrlError" : "cloneRepositoryUrlHelp"}
										aria-invalid={urlError ? true : undefined}
										className="bg-[var(--color-bg-import-card)] pl-10 font-mono text-[13px]"
										disabled={disabled}
										placeholder={t("createProject.cloneRepositoryUrlPlaceholder")}
										spellCheck={false}
										value={value.remoteUrl}
										onChange={(event) => onChange({ ...value, remoteUrl: event.target.value })}
									/>
								</div>
								{urlError ? (
									<p id="cloneRepositoryUrlError" className="text-pretty text-[12px] leading-5 text-destructive" role="alert">
										{urlError}
									</p>
								) : (
									<p id="cloneRepositoryUrlHelp" className="text-pretty text-[12px] leading-5 text-[var(--color-text-import-muted)]">
										{t("createProject.cloneRepositoryUrlHelp")}
									</p>
								)}
							</div>

							<div className="space-y-2">
								<Label htmlFor="cloneDestination" className="text-[13px] font-semibold text-[var(--color-text-import-title)]">
									{t("createProject.cloneDestination")}
								</Label>
								<div className="flex gap-2">
									<div className="relative min-w-0 flex-1">
										<span className="pointer-events-none absolute inset-y-0 left-3 flex w-4 items-center justify-center text-[var(--color-text-import-muted)]">
											<Folder className="size-4" aria-hidden="true" />
										</span>
										<Input
											id="cloneDestination"
											aria-describedby={destinationError ? "cloneDestinationError" : undefined}
											aria-invalid={destinationError ? true : undefined}
											className="cursor-default bg-[var(--color-bg-import-card)] pl-10 font-mono text-[13px]"
											placeholder={t("createProject.cloneDestinationPlaceholder")}
											readOnly
											value={value.destinationParent}
										/>
									</div>
									<Button
										type="button"
										variant="footer"
										className="h-control-form! px-4"
										disabled={disabled || choosingDestination}
										onClick={() => void chooseDestination()}
									>
										{choosingDestination ? t("createProject.opening") : t("createProject.cloneChoose")}
									</Button>
								</div>
								{destinationError ? (
									<p id="cloneDestinationError" className="text-pretty text-[12px] leading-5 text-destructive" role="alert">
										{destinationError}
									</p>
								) : null}
							</div>

							{targetPath ? (
								<div className="flex items-center gap-3 rounded-lg border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-card)] px-3 py-3">
									<span className="grid size-4 shrink-0 place-items-center text-[var(--color-text-import-muted)]">
										<GitBranch className="size-4" aria-hidden="true" />
									</span>
									<div className="min-w-0">
										<p className="text-[12px] font-medium text-[var(--color-text-import-muted)]">
											{t("createProject.cloneWillCreate")}
										</p>
										<p className="mt-0.5 truncate font-mono text-[13px] font-semibold text-[var(--color-text-import-title)]" title={targetPath}>
											{targetPath}
										</p>
									</div>
								</div>
							) : null}
						</div>

						<div className="flex shrink-0 flex-col gap-3 border-t border-[var(--color-border-import-modal)] p-(--size-import-dialog-padding) sm:flex-row sm:items-center sm:justify-between">
							<p className="max-w-[340px] text-pretty text-[12px] font-medium leading-5 text-[var(--color-text-import-muted)]">
								{t("createProject.cloneCredentialsHint")}
							</p>
							<div className="flex items-center justify-end gap-3">
								<Button type="button" variant="footer" disabled={disabled} onClick={onClose}>
									{t("createProject.cancel")}
								</Button>
								<Button type="submit" variant="footer-primary" disabled={disabled || choosingDestination}>
									{t("createProject.cloneContinue")}
								</Button>
							</div>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function repositoryNameFromGitUrl(raw: string): string | null {
	const value = raw.trim();
	if (!value || /\s/.test(value) || value.startsWith("-")) return null;
	let remotePath = "";
	const scpMatch = value.match(/^[^/@:\s]+@[^/:\s]+:(.+)$/);
	if (scpMatch?.[1]) {
		remotePath = scpMatch[1];
	} else {
		try {
			const parsed = new URL(value);
			if (!["file:", "git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) return null;
			if (
				(["http:", "https:"].includes(parsed.protocol) &&
					(parsed.username || parsed.password || parsed.search)) ||
				parsed.password
			) {
				return null;
			}
			// URL.pathname preserves percent escapes, while Go's net/url exposes a
			// decoded URL.Path to the daemon. Decode once so this preview names the
			// exact directory the daemon will create, including escaped separators.
			remotePath = decodeURIComponent(parsed.pathname);
		} catch {
			return null;
		}
	}
	const lastSegment = remotePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
	const name = lastSegment.replace(/\.git$/, "");
	if (!name || name === "." || name === ".." || /[\\/<>:"|?*]/.test(name)) return null;
	return name;
}

export function joinCloneDestination(parent: string, repositoryName: string): string {
	const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
	return `${parent.replace(/[\\/]+$/, "")}${separator}${repositoryName}`;
}
