import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { cn } from "./utils";

export function SessionWorkspaceTopbarView({
	actions,
	className,
	terminalClassName,
	terminalControls,
	terminalControlsAriaLabel = "Terminal controls",
	terminalStyle,
	terminalTabs,
}: {
	actions?: ReactNode;
	className?: string;
	terminalClassName?: string;
	terminalControls?: ReactNode;
	terminalControlsAriaLabel?: string;
	terminalStyle?: CSSProperties;
	terminalTabs: ReactNode;
}) {
	return (
		<div className={cn("flex h-inspector-tabs w-full shrink-0 items-stretch bg-sidebar", className)}>
			<div className="session-topbar-surface flex min-w-0 flex-1" data-testid="session-workspace-topbar">
				<div
					className={cn("flex min-w-0 shrink items-center pr-1.5", terminalClassName)}
					data-testid="session-terminal-region"
					style={terminalStyle}
				>
					<div className="flex h-full min-w-0 flex-1 items-center">{terminalTabs}</div>
					{terminalControls ? (
						<div
							aria-label={terminalControlsAriaLabel}
							className="ml-1.5 flex shrink-0 items-center gap-0.5 border-l border-border/70 pl-1.5"
							role="toolbar"
						>
							{terminalControls}
						</div>
					) : null}
				</div>
				{actions ? (
					<div className="ml-auto flex shrink-0 items-center px-3" data-testid="session-action-region">
						{actions}
					</div>
				) : null}
			</div>
		</div>
	);
}

export function StartupLoaderView({
	ariaLabel,
	brand,
	className,
	logo,
	phraseIntervalMs = 2_200,
	phrases,
	testId = "startup-loader",
}: {
	ariaLabel: string;
	brand: string;
	className?: string;
	logo: ReactNode;
	phraseIntervalMs?: number;
	phrases: readonly string[];
	testId?: string;
}) {
	const [phraseIndex, setPhraseIndex] = useState(0);

	useEffect(() => {
		if (phrases.length < 2) return;
		const timer = window.setInterval(() => {
			setPhraseIndex((current) => (current + 1) % phrases.length);
		}, phraseIntervalMs);
		return () => window.clearInterval(timer);
	}, [phraseIntervalMs, phrases]);

	const phrase = phrases[phraseIndex] ?? "";

	return (
		<div
			aria-busy="true"
			aria-label={ariaLabel}
			aria-live="polite"
			className={cn(
				"ao-startup-screen flex h-full w-full items-center justify-center bg-background text-foreground",
				className,
			)}
			data-testid={testId}
			role="status"
		>
			<div className="ao-startup-content flex -translate-y-[3vh] flex-col items-center text-center">
				<div className="grid h-28 w-32 place-items-center" aria-hidden="true">
					{logo}
				</div>
				<p className="mt-5 text-base font-semibold tracking-tight text-foreground">{brand}</p>
				<p className="mt-2 min-h-5 text-sm text-muted-foreground">
					<span aria-hidden="true" className="ao-startup-status" key={phrase}>
						{phrase}
					</span>
				</p>
				<div className="ao-startup-dots mt-3 flex h-4 items-center gap-1.5" aria-hidden="true">
					<span />
					<span />
					<span />
				</div>
			</div>
		</div>
	);
}
