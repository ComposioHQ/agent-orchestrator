import { Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useImportRunStore } from "../stores/import-run-store";
import { ImportSessionDialog } from "./ImportSessionDialog";

// Persistent project action: no readiness gate, dismissal, or launch-time scan.
export function ImportSessionsHint({
	projectId,
	projectName,
}: {
	projectId: string;
	projectName: string;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const run = useImportRunStore((state) => state.runs[projectId]);
	return (
		<>
			<button
				type="button"
				data-testid={`import-sessions-${projectId}`}
				className="sidebar-expanded-chrome ml-7 flex h-8 max-w-[calc(100%-1.75rem)] items-center gap-2 rounded-md px-2 text-caption text-muted-foreground hover:bg-interactive-hover hover:text-foreground group-data-[collapsible=icon]:hidden"
				onClick={() => setOpen(true)}
			>
				{run?.running ? (
					<LoaderCircle
						aria-hidden="true"
						className="size-icon-sm shrink-0 animate-spin"
					/>
				) : (
					<Download aria-hidden="true" className="size-icon-sm shrink-0" />
				)}
				<span className="truncate">
					{run?.running
						? t("importSession.importingProgress", {
								done: run.progress.done,
								total: run.progress.total,
							})
						: t("importSession.hintTitle")}
				</span>
				{!run?.running && !!run?.errors.length && (
					<span className="text-error">
						{t("importSession.failedCount", { count: run.errors.length })}
					</span>
				)}
			</button>
			{open && (
				<ImportSessionDialog
					open={open}
					onOpenChange={setOpen}
					projectId={projectId}
					projectName={projectName}
				/>
			)}
		</>
	);
}
