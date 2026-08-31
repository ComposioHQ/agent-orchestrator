import { Check, Download, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	type ImportableSession,
	useImportableSessions,
	useImportSession,
} from "../hooks/useImportableSessions";
import { agentLabel } from "../lib/agent-options";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

// How far back discovery looks by default, in days.
const IMPORT_WINDOW_DAYS = 60;

type ImportSessionDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	container?: HTMLElement;
	// onImported fires after a successful import with the new AO session id, so a
	// caller can navigate to it. Optional: the dialog works standalone.
	onImported?: (sessionId: string) => void;
};

// ImportSessionDialog lists agent conversations already on disk (Claude Code,
// Codex, and any future provider) and imports one as a resumable AO session.
export function ImportSessionDialog({ open, onOpenChange, container, onImported }: ImportSessionDialogProps) {
	const { t } = useTranslation();
	const query = useImportableSessions(IMPORT_WINDOW_DAYS, open);
	const importMutation = useImportSession();

	const sessions = query.data ?? [];
	const pendingId = importMutation.isPending ? importMutation.variables?.nativeSessionId : undefined;

	const handleImport = (session: ImportableSession) => {
		if (session.alreadyImported || importMutation.isPending) return;
		importMutation.mutate(
			{ provider: session.provider, nativeSessionId: session.nativeSessionId },
			{
				onSuccess: (data) => {
					const id = data?.session?.id;
					if (id && onImported) onImported(id);
				},
			},
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				portalContainer={container}
				showCloseButton={false}
				className="w-[min(var(--size-dialog-lg,42rem),calc(100%-var(--space-8)))] max-w-none gap-0 overflow-hidden rounded-xl border border-border-strong bg-surface p-0 text-foreground shadow-xl"
			>
				<DialogClose asChild>
					<button
						aria-label={t("importSession.close")}
						className="settings-dialog-close-button settings-close-button"
						type="button"
					>
						<X className="size-icon-base" aria-hidden="true" />
					</button>
				</DialogClose>
				<DialogTitle className="settings-dialog-title px-5 pr-12 pt-4">{t("importSession.title")}</DialogTitle>
				<DialogDescription className="px-5 pr-12 pt-1 text-caption leading-4 text-muted-foreground">
					{t("importSession.description")}
				</DialogDescription>

				<div className="max-h-[min(60vh,32rem)] overflow-y-auto px-5 pb-5 pt-4">
					{query.isLoading ? (
						<div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
							<LoaderCircle className="size-icon-base animate-spin" aria-hidden="true" />
							<span className="text-md-sm">{t("importSession.loading")}</span>
						</div>
					) : query.isError ? (
						<div className="flex items-start gap-3 rounded-lg border border-error/40 bg-error/5 px-3 py-3">
							<TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-error" />
							<div className="min-w-0">
								<p className="text-control font-medium text-foreground">{t("importSession.errorTitle")}</p>
								<p className="mt-1 text-caption leading-4 text-muted-foreground">
									{query.error instanceof Error ? query.error.message : t("importSession.errorTitle")}
								</p>
							</div>
						</div>
					) : sessions.length === 0 ? (
						<div className="py-10 text-center">
							<p className="text-md-sm font-medium text-foreground">{t("importSession.emptyTitle")}</p>
							<p className="mt-1 text-caption leading-relaxed text-muted-foreground">
								{t("importSession.emptyBody", { days: IMPORT_WINDOW_DAYS })}
							</p>
						</div>
					) : (
						<ul className="flex flex-col gap-2" aria-label={t("importSession.title")}>
							{sessions.map((session) => (
								<ImportSessionRow
									key={`${session.provider}:${session.nativeSessionId}`}
									session={session}
									pending={pendingId === session.nativeSessionId}
									disabled={importMutation.isPending}
									onImport={() => handleImport(session)}
								/>
							))}
						</ul>
					)}

					{importMutation.isError ? (
						<p className="mt-3 text-caption leading-4 text-error" role="alert">
							{importMutation.error instanceof Error ? importMutation.error.message : t("importSession.importFailed")}
						</p>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ImportSessionRow({
	session,
	pending,
	disabled,
	onImport,
}: {
	session: ImportableSession;
	pending: boolean;
	disabled: boolean;
	onImport: () => void;
}) {
	const { t } = useTranslation();
	const recency = relativeDay(session.lastActivity);
	const recencyLabel = recency ? t(recency.key, { count: recency.count }) : "";
	const meta = [agentLabel(session.provider), recencyLabel].filter(Boolean).join(" · ");

	return (
		<li className="flex items-center gap-3 rounded-lg border border-border bg-surface-raised/40 px-3 py-2.5">
			<AgentAvatar className="size-icon-lg shrink-0" decorative provider={session.provider} />
			<div className="min-w-0 flex-1">
				<p className="truncate text-control font-medium text-foreground" title={session.title}>
					{session.title || session.nativeSessionId}
				</p>
				<p className="truncate text-caption text-muted-foreground" title={session.cwd}>
					{session.cwd}
				</p>
				<p className="mt-0.5 text-micro text-muted-foreground">
					{meta}
					{session.messageCount > 0 ? ` · ${t("importSession.messages", { count: session.messageCount })}` : ""}
				</p>
			</div>
			{session.alreadyImported ? (
				<span className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
					<Check className="size-icon-sm" aria-hidden="true" />
					{t("importSession.imported")}
				</span>
			) : (
				<Button
					className="shrink-0"
					disabled={disabled}
					onClick={onImport}
					type="button"
					variant="outline"
				>
					{pending ? (
						<LoaderCircle className="size-icon-sm animate-spin" aria-hidden="true" />
					) : (
						<Download className="size-icon-sm" aria-hidden="true" />
					)}
					{t("importSession.import")}
				</Button>
			)}
		</li>
	);
}

// relativeDay returns the i18n key (and count) for a coarse recency label.
// Precise timestamps do not matter for a "which conversation is this" list.
type RecencyKey = "importSession.today" | "importSession.yesterday" | "importSession.daysAgo";

function relativeDay(iso: string): { key: RecencyKey; count: number } | null {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return null;
	const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
	if (days <= 0) return { key: "importSession.today", count: 0 };
	if (days === 1) return { key: "importSession.yesterday", count: 1 };
	return { key: "importSession.daysAgo", count: days };
}
