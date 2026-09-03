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

// ImportSessionsHint is the sidebar entry for bringing conversations that are
// already on this machine into AO. Without it the feature is invisible to
// anyone past the first-run welcome screen.
//
// It is one plain label and a dismiss control. An explanatory sentence here
// would be read once and then be clutter forever.
//
// The row itself is the hover surface, so the highlight covers the whole
// control rather than only the half the label happens to occupy. The dismiss
// button sits inside that surface and brightens on its own hover, which is how
// the rest of the sidebar distinguishes a secondary action.
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
			className="sidebar-expanded-chrome mx-2 mb-2 flex items-center overflow-hidden rounded-lg border border-border bg-surface-raised/50 transition-colors hover:bg-interactive-hover group-data-[collapsible=icon]:hidden"
			data-testid="import-sessions-hint"
		>
			<button
				className="flex h-9 min-w-0 flex-1 items-center gap-2 px-2.5 text-caption font-medium text-foreground"
				onClick={open}
				type="button"
			>
				<Download aria-hidden="true" className="size-icon-sm shrink-0 text-muted-foreground" />
				<span className="truncate">{t("importSession.hintTitle")}</span>
			</button>
			<button
				aria-label={t("importSession.hintDismiss")}
				className="flex size-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
				onClick={dismiss}
				type="button"
			>
				<X aria-hidden="true" className="size-icon-sm" />
			</button>
		</div>
	);
}
