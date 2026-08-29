import { GitBranch } from "lucide-react";

export function SessionBranchBadge({ branch, compact = false }: { branch?: string; compact?: boolean }) {
	if (!branch?.trim()) return null;
	return (
		<span
			aria-label={branch}
			className="session-branch-badge mr-1 inline-flex h-7 max-w-48 shrink-0 items-center gap-1.5 overflow-hidden rounded-md border border-border bg-surface px-2 text-2xs text-muted-foreground"
			data-compact={compact ? "true" : "false"}
			title={branch}
		>
			<GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="session-branch-badge__label truncate font-mono">{branch}</span>
		</span>
	);
}
