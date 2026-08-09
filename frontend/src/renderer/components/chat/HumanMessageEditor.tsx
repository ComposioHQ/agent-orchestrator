import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, FileText, Image as ImageIcon, Loader2, Tag, X } from "lucide-react";
import type { ConversationContentSummary } from "../../types/conversation";
import { Button } from "../ui/button";

export interface HumanMessageEditorProps {
	text: string;
	content: ConversationContentSummary[];
	pending: boolean;
	busy: boolean;
	error?: string;
	onCancel: () => void;
	onSend: (text: string) => Promise<unknown> | void;
}

export function HumanMessageEditor({
	text,
	content,
	pending,
	busy,
	error,
	onCancel,
	onSend,
}: HumanMessageEditorProps) {
	const [draft, setDraft] = useState(text);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const sendDisabled = pending || busy || draft.trim().length === 0;
	const busyMessage = busy ? "Stop the current turn before branching" : undefined;

	useEffect(() => {
		const node = textarea.current;
		if (!node) return;
		node.style.height = "0px";
		node.style.height = `${Math.min(node.scrollHeight, 224)}px`;
	}, [draft]);

	function submit() {
		if (sendDisabled) return;
		void Promise.resolve(onSend(draft.trimEnd())).catch(() => {});
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
			return;
		}
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
	}

	return (
		<div className="flex w-full max-w-[min(78%,560px)] flex-col rounded-[10px] border border-logo-accent/50 bg-raised p-2 shadow-sm">
		<textarea
			ref={textarea}
			value={draft}
			onChange={(event) => setDraft(event.target.value)}
			onKeyDown={onKeyDown}
			aria-label="Edit message"
			autoFocus
			rows={2}
			className="max-h-56 min-h-20 w-full resize-none overflow-y-auto rounded-md border border-border bg-background px-2.5 py-2 text-sm leading-[1.55] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-logo-accent/40"
		/>
		{content.length > 0 ? (
			<div className="mt-2 flex flex-wrap gap-1.5" aria-label="Preserved message content">
				{content.map((item, index) => {
					const Icon = item.type === "image" ? ImageIcon : item.type === "resource" ? FileText : Tag;
					const label = item.type === "image" ? item.mimeType || "Image" : item.name || item.uri || item.type;
					return (
						<span
							key={`${item.type}-${item.uri ?? item.mimeType ?? item.name ?? index}`}
							title={item.uri || label}
							className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground"
						>
							<Icon aria-hidden="true" className="size-3 shrink-0" />
							<span className="truncate">{label}</span>
						</span>
					);
				})}
			</div>
		) : null}
		<div className="mt-2 flex min-h-7 items-center justify-end gap-1.5">
			{error ? (
				<span role="alert" className="mr-auto text-[11px] text-destructive">
					{error}
				</span>
			) : busyMessage ? (
				<span className="mr-auto text-[11px] text-muted-foreground">{busyMessage}</span>
			) : null}
			<Button
				type="button"
				size="icon-sm"
				variant="ghost"
				onClick={onCancel}
				disabled={pending}
				aria-label="Cancel edit"
				title="Cancel edit"
				className="size-7"
			>
				<X aria-hidden="true" className="size-3.5" />
			</Button>
			<Button
				type="button"
				size="icon-sm"
				onClick={submit}
				disabled={sendDisabled}
				aria-label="Send edited message"
				title={busyMessage ?? "Send edited message (⌘/Ctrl+Enter)"}
				className="size-7 rounded-full"
			>
				{pending ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : <ArrowUp aria-hidden="true" className="size-3.5" />}
			</Button>
		</div>
	</div>
	);
}
