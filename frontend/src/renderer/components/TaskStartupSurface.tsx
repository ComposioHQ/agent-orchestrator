import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileAttachment } from "../hooks/useFileAttachments";
import { useTaskStartupVisibility } from "./TaskStartupContext";
import { ChatComposer } from "./chat/ChatComposer";
import { HumanMessage } from "./chat/ChatTimelineItems";

// A renderer-only presentation of the one in-flight delegate request. This is
// deliberately not a ConversationSnapshot: the daemon owns durable sessions.
export function TaskStartupSurface({ brief, createdAt, attachments, pending, visible, error, sessionCreated, onReturn, onDiscard, onBack, children }: {
	brief: string;
	createdAt: string;
	attachments: FileAttachment[];
	pending: boolean;
	visible: boolean;
	error?: string;
	sessionCreated?: boolean;
	onReturn: () => void;
	onDiscard?: () => void;
	onBack: () => void;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	useTaskStartupVisibility(visible);
	const surfaceRef = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!visible) return;
		const frame = requestAnimationFrame(() => surfaceRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [visible]);
	return (
		<>
			{!visible && !pending && error ? (
				<aside data-browser-native-overlay="true" data-state="open" className="absolute right-4 bottom-4 z-20 w-[min(360px,calc(100%_-_32px))] rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg">
					<div role="alert">
						<p className="font-medium">{sessionCreated ? t("newTask.createdButNotOpened", { defaultValue: "The session was created, but could not be opened." }) : t("newTask.startupFailed", { defaultValue: "Session could not start" })}</p>
						<p className="mt-1 break-words text-xs text-muted-foreground">{error}</p>
					</div>
					<div className="mt-3 flex flex-wrap gap-3">
						<button type="button" onClick={onReturn} className="text-xs font-medium underline underline-offset-4">
							{sessionCreated ? t("newTask.returnToSession", { defaultValue: "Return to session" }) : t("newTask.returnToDraft", { defaultValue: "Return to draft" })}
						</button>
						{onDiscard ? (
							<button type="button" onClick={onDiscard} className="text-xs text-muted-foreground underline underline-offset-4">
								{sessionCreated ? t("newTask.dismiss", { defaultValue: "Dismiss" }) : t("newTask.discardDraft", { defaultValue: "Discard draft" })}
							</button>
						) : null}
					</div>
				</aside>
			) : null}
			<section
				ref={surfaceRef}
				role="region"
				aria-label={t("chat.title", { defaultValue: "Chat" })}
				tabIndex={-1}
				hidden={!visible}
				className="cursor-chat-surface absolute inset-0 z-10 flex min-h-0 flex-col bg-background text-foreground outline-none"
				style={!visible ? { display: "none" } : undefined}
				data-browser-native-overlay={visible ? "true" : undefined}
				data-state={visible ? "open" : undefined}
				data-testid="task-startup-chat"
			>
				<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
					{!pending ? (
						<button type="button" onClick={onBack} aria-label={t("command.back")} className="rounded-md p-1 hover:bg-surface">
							<ArrowLeft className="size-4" aria-hidden="true" />
						</button>
					) : null}
					<span className="text-sm font-medium">{t("newTask.title")}</span>
				</div>
				<div className="cursor-chat-timeline min-h-0 flex-1 overflow-y-auto px-4 py-5">
					<div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4.5">
					{brief.trim() ? <HumanMessage
						apiBaseUrl=""
						sessionId=""
						message={{
							kind: "message",
							id: "starting-prompt",
							sequence: 0,
							revision: 0,
							role: "user",
							origin: "human",
							text: brief,
							streaming: false,
							createdAt,
						}}
					/> : null}
					{attachments.length > 0 ? (
						<ul aria-label={t("newTask.addFile")} className="mb-4 flex flex-wrap justify-end gap-2 text-xs text-muted-foreground">
							{attachments.map((attachment) => (
								<li key={attachment.id} className="rounded-md border border-border px-2 py-1">{attachment.name}</li>
							))}
						</ul>
					) : null}
					{pending ? (
						<div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
							{t("newTask.startingSession", { defaultValue: "Starting session…" })}
						</div>
					) : null}
					</div>
				</div>
				{visible ? (
					<div className="cursor-chat-composer-dock shrink-0 px-4 pb-3">
						<div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
							{pending ? (
								<ChatComposer
									disabled
									autoFocus={false}
									disabledPlaceholder={t("newTask.waitingForSession", { defaultValue: "Waiting for the session to start…" })}
									onSend={() => undefined}
								/>
							) : children}
						</div>
					</div>
				) : null}
			</section>
		</>
	);
}
