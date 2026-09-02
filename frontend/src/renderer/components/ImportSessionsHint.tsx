import { Download, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHasReadyAgent } from "../hooks/useAgentReadinessQuery";
import { useUiStore } from "../stores/ui-store";

const dismissedStorageKey = "ao.importSessionsHint.dismissed";

function readDismissed(): boolean {
	if (typeof window === "undefined" || !window.localStorage) return true;
	try {
		return window.localStorage.getItem(dismissedStorageKey) === "1";
	} catch {
		// A blocked or full localStorage must not turn the hint into a nag that
		// cannot be dismissed, so treat it as already dismissed.
		return true;
	}
}

function persistDismissed() {
	try {
		window.localStorage?.setItem(dismissedStorageKey, "1");
	} catch {
		// Dismissal is a convenience, not state worth failing a render over.
	}
}

// ImportSessionsHint tells someone arriving from Claude Code or Codex that the
// conversations already on their machine can be brought into AO. Without it the
// feature is invisible to anyone past the first-run welcome screen.
//
// It deliberately does not scan for conversations to decide whether to appear.
// Discovery reads transcripts off disk, and paying that on every launch — for
// every user, forever — to decide whether to show one row is the wrong trade.
// The dialog does the scan when it opens, and handles finding nothing.
//
// This is an onboarding nudge, not a fixture: dismissing it, or opening the
// dialog from it, retires it for good.
export function ImportSessionsHint() {
	const { t } = useTranslation();
	const [dismissed, setDismissed] = useState(readDismissed);
	const setImportSessionOpen = useUiStore((state) => state.setImportSessionOpen);
	// An imported conversation has to be resumable, which takes an agent the
	// user has installed and logged into. Without one this route only
	// dead-ends, so it is not offered. It appears once an agent is ready.
	const hasAgent = useHasReadyAgent();

	const dismiss = useCallback(() => {
		persistDismissed();
		setDismissed(true);
	}, []);

	const open = useCallback(() => {
		// The hint has done its job once it has been acted on.
		persistDismissed();
		setDismissed(true);
		setImportSessionOpen(true);
	}, [setImportSessionOpen]);

	if (dismissed || !hasAgent) return null;

	return (
		<div
			className="sidebar-expanded-chrome mx-2 mb-2 rounded-lg border border-border bg-surface-raised/50 px-2.5 py-2 group-data-[collapsible=icon]:hidden"
			data-testid="import-sessions-hint"
		>
			<div className="flex items-start gap-2">
				<Download aria-hidden="true" className="mt-0.5 size-icon-sm shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<p className="text-caption font-medium leading-4 text-foreground">{t("importSession.hintTitle")}</p>
					<p className="mt-0.5 text-micro leading-4 text-muted-foreground">{t("importSession.hintBody")}</p>
					<button
						className="mt-1.5 text-micro font-medium text-accent hover:underline"
						onClick={open}
						type="button"
					>
						{t("importSession.hintAction")}
					</button>
				</div>
				<button
					aria-label={t("importSession.hintDismiss")}
					className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
					onClick={dismiss}
					type="button"
				>
					<X aria-hidden="true" className="size-icon-sm" />
				</button>
			</div>
		</div>
	);
}
