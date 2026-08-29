import { useId, type ReactNode } from "react";
import { AgentAvatar } from "../AgentAvatar";

/**
 * Shared settings container for one agent provider. Provider identity and
 * provider-level actions live in the header; account/profile rows stay below.
 */
export function AgentProviderGroup({
	provider,
	name,
	summary,
	action,
	children,
}: {
	provider: string;
	name: string;
	summary?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	const headingId = useId();

	return (
		<section
			aria-labelledby={headingId}
			className="overflow-hidden rounded-md border border-border bg-[var(--color-bg-settings-row)]"
			data-agent-provider={provider}
		>
			<header className="flex min-h-16 items-center justify-between gap-4 px-4 py-3">
				<div className="flex min-w-0 items-center gap-3">
					<AgentAvatar className="size-8 shrink-0" decorative provider={provider} />
					<div className="min-w-0">
						<h3 id={headingId} className="truncate text-sm font-medium text-foreground">{name}</h3>
						{summary ? <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p> : null}
					</div>
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</header>
			<div className="border-t border-border">{children}</div>
		</section>
	);
}
