import { useFileAnnotation } from "../hooks/useFileAnnotation";
import { FileContentPane } from "./FileContentPane";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";

export function SessionFileWorkspace({ path, sessionId }: { path: string; sessionId: string }) {
	const annotation = useFileAnnotation(sessionId);
	const name = path.split("/").pop() || path;
	return (
		<section className="flex h-full min-h-0 flex-col bg-background" data-testid="session-file-workspace">
			<header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
				<WorkspaceEntryIcon className="size-icon-base" kind="file" name={name} />
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={path}>
					{path}
				</span>
			</header>
			<div className="board-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
				<FileContentPane annotation={annotation} path={path} sessionId={sessionId} split={false} wrap />
			</div>
		</section>
	);
}
