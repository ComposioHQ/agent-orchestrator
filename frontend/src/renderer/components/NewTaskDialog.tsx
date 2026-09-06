import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TaskComposer } from "./TaskComposer";

type NewTaskDialogProps = {
	open: boolean;
	projectId?: string;
	onCreated: (sessionId: string, focusSession?: boolean) => void | Promise<void>;
	navigationKey?: string;
	onOpenChange: (open: boolean) => void;
};

export function NewTaskDialog({ open, projectId, onCreated, onOpenChange, navigationKey }: NewTaskDialogProps) {
	const { t } = useTranslation();
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const [startup, setStartup] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	return (
		<>
			<Dialog.Root
				open={open}
				modal={!startup}
				onOpenChange={(next) => { if (!submitting && !startup) onOpenChange(next); }}
			>
				<Dialog.Portal>
					<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
					<Dialog.Content
						role={startup ? "presentation" : "dialog"}
						style={startup ? { display: "none" } : undefined}
						onOpenAutoFocus={(event) => { if (startup) event.preventDefault(); }}
						onInteractOutside={(event) => { if (startup || submitting) event.preventDefault(); }}
						onEscapeKeyDown={(event) => { if (startup || submitting) event.preventDefault(); }}
						className="fixed left-1/2 top-1/2 z-overlay w-dialog-xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none"
					>
						<Dialog.Title className="settings-dialog-title px-4 pt-3">{t("newTask.title")}</Dialog.Title>
						<Dialog.Description className="sr-only">{t("newTask.description")}</Dialog.Description>
						<div ref={setContainer} />
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
			{/* Radix swaps its content implementation when modality changes. Keep
			    the request owner outside that subtree so startup cannot remount it. */}
			{open ? (
				<TaskComposer
					container={container}
					projectId={projectId}
					navigationKey={navigationKey}
					onStartupChange={setStartup}
					onDiscard={() => onOpenChange(false)}
					onSubmittingChange={setSubmitting}
					autoFocusTitle
					onCreated={async (sessionId, focusSession) => {
						if (focusSession === false) await onCreated(sessionId, false);
						else await onCreated(sessionId);
						onOpenChange(false);
					}}
				/>
			) : null}
		</>
	);
}
