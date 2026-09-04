import { useEffect } from "react";
import { useUiStore } from "../stores/ui-store";

const TOAST_DISMISS_MS = 3_500;

export function GlobalToast() {
	const toast = useUiStore((state) => state.globalToast);
	const clearGlobalToast = useUiStore((state) => state.clearGlobalToast);

	useEffect(() => {
		if (!toast) return;
		const timer = window.setTimeout(() => clearGlobalToast(), TOAST_DISMISS_MS);
		return () => window.clearTimeout(timer);
	}, [clearGlobalToast, toast]);

	if (!toast) return null;

	return (
		<div className="pointer-events-none fixed right-3 bottom-3 z-overlay w-[min(360px,calc(100vw-24px))]">
			<section
				aria-live="polite"
				className="rounded-welcome-panel border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-modal)] px-3.5 py-3 text-xs shadow-[var(--shadow-import-modal)]"
				role="status"
			>
				<p className="font-medium text-(--color-text-import-title)">{toast.title}</p>
				{toast.body ? (
					<p className="mt-0.5 wrap-break-word text-pretty text-[var(--color-text-import-muted)]">{toast.body}</p>
				) : null}
			</section>
		</div>
	);
}
