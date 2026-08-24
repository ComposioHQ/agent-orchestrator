import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFileAnnotation } from "../hooks/useFileAnnotation";
import { FileContentPane } from "./FileContentPane";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";
import { FileAnnotationComposer } from "./WorkspaceDiffView";
import { Button } from "./ui/button";

export function SessionFileWorkspace({ path, sessionId }: { path: string; sessionId: string }) {
	const { t } = useTranslation();
	const annotation = useFileAnnotation(sessionId);
	const name = path.split("/").pop() || path;
	const fileFeedbackActive = annotation.target?.path === path && annotation.target.side === "file";
	return (
		<section className="flex h-full min-h-0 flex-col bg-background" data-testid="session-file-workspace">
			<header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
				<WorkspaceEntryIcon className="size-icon-base" kind="file" name={name} />
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={path}>
					{path}
				</span>
				{fileFeedbackActive ? (
					<span className="size-7 shrink-0" aria-hidden="true" />
				) : (
					<Button
						aria-label={t("files.addFileFeedback", { file: path })}
						className="size-7 shrink-0"
						onClick={() => annotation.begin({ path, side: "file" })}
						size={null}
						type="button"
						variant="ghost"
					>
						<Plus className="size-icon-sm" aria-hidden="true" />
					</Button>
				)}
			</header>
			{fileFeedbackActive ? <FileAnnotationComposer annotation={annotation} /> : null}
			<div className="board-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
				<FileContentPane annotation={annotation} path={path} sessionId={sessionId} split={false} wrap />
			</div>
		</section>
	);
}
