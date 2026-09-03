import type { ClaudeCodeAccount } from "../../hooks/useClaudeCodeAccountsQuery";

const CLAUDE_PLAN_NAMES: Record<string, string> = {
	free: "Free",
	pro: "Pro",
	max: "Max",
	team: "Team",
	business: "Business",
	enterprise: "Enterprise",
	claude_free: "Free",
	claude_pro: "Pro",
	claude_max: "Max",
	claude_team: "Team",
	claude_business: "Business",
	claude_enterprise: "Enterprise",
};

export function claudeCodeAccountDisplayLabel(account: ClaudeCodeAccount): string {
	return account.accountEmail?.trim() || account.identity.emailAddress?.trim() || account.label;
}

export function claudeCodePlanName(plan: string | null | undefined): string | null {
	const value = plan?.trim();
	if (!value) return null;
	const normalized = value.toLowerCase();
	if (normalized === "subscription" || normalized === "stripe_subscription") return null;
	return CLAUDE_PLAN_NAMES[normalized] ?? value;
}

export function claudeCodeRemainingPercent(account: ClaudeCodeAccount): number | null {
	if (account.planUsage.windows.length === 0) return null;
	const mostUsed = Math.max(...account.planUsage.windows.map((window) => window.usedPercent));
	return Math.max(0, Math.min(100, 100 - mostUsed));
}

export function formatClaudeCodePercentage(value: number, locale?: string): string {
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`;
}
