import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ImportValidationResult } from "../lib/import-onboarding";
import { Button } from "./ui/button";

export function ImportKindChoiceDialog({
	childCount,
	disabled,
	onBack,
	onContinueAsProject,
	onOpenChange,
	onTryWorkspace,
	open,
}: {
	childCount: number;
	disabled: boolean;
	onBack: () => void;
	onContinueAsProject: () => void;
	onOpenChange: (open: boolean) => void;
	onTryWorkspace: () => void;
	open: boolean;
}) {
	const { t } = useTranslation();
	return (
		<Dialog.Root open={open} onOpenChange={(next) => !next && !disabled && onOpenChange(false)}>
			<Dialog.Portal>
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay flex max-h-[min(640px,calc(100svh-24px))] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none">
					<div className="relative flex shrink-0 items-center gap-3 px-4 pt-3">
						<Button type="button" variant="outline" size="icon" aria-label={t("createProject.backToType")} disabled={disabled} onClick={onBack}>
							<ChevronLeft className="size-4" aria-hidden="true" />
						</Button>
						<div className="min-w-0 flex-1 pr-8">
							<Dialog.Title className="text-balance text-[18px] font-semibold text-[var(--color-text-import-title)]">
								{t("createProject.importKindChoiceTitle")}
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-pretty text-[12px] leading-5 text-[var(--color-text-import-muted)]">
								{t("createProject.importKindChoiceDescription", { count: childCount })}
							</Dialog.Description>
						</div>
						<button type="button" className="settings-close-button" aria-label={t("createProject.closeImport")} disabled={disabled} onClick={() => onOpenChange(false)}>
							<X className="size-4" aria-hidden="true" />
						</button>
					</div>
					<div className="space-y-3 px-4 pb-4 pt-4">
						<Button type="button" className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left" variant="outline" disabled={disabled} onClick={onTryWorkspace}>
							<span>
								<span className="block text-[14px] font-medium">{t("createProject.importKindChoiceWorkspace")}</span>
								<span className="mt-1 block text-[12px] leading-5 text-muted-foreground">{t("createProject.importKindChoiceWorkspaceHint")}</span>
							</span>
						</Button>
						<Button type="button" className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left" variant="outline" disabled={disabled} onClick={onContinueAsProject}>
							<span>
								<span className="block text-[14px] font-medium">{t("createProject.importKindChoiceProject")}</span>
								<span className="mt-1 block text-[12px] leading-5 text-muted-foreground">{t("createProject.importKindChoiceProjectHint")}</span>
							</span>
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function importKindChoiceChildCount(validation: ImportValidationResult): number {
	return validation.childRepos?.filter((repo) => repo.isRepo).length ?? 0;
}
