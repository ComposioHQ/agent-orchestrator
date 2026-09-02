import { describe, expect, it } from "vitest";
import type { CodexAccountsResponse } from "./useCodexAccountsQuery";
import { catalogFor } from "../i18n/messages";
import type { AppLocale } from "../i18n/locales";
import { codexAccountReasonCodes, codexAccountReasonKey, mergeCodexAccounts } from "./codex-accounts-state";

const account = (id: string, createdAt: string, active = false) => ({ id, createdAt, active });

function response(accounts: ReturnType<typeof account>[], activeAccountId = "b"): CodexAccountsResponse {
	return {
		accountRevision: 7,
		activeAccountId,
		accounts,
		capabilities: {},
	} as CodexAccountsResponse;
}

describe("mergeCodexAccounts", () => {
	it("preserves unrequested accounts for targeted ensures and derives active-first stable order", () => {
		const current = response([
			account("a", "2026-01-02T00:00:00Z", true),
			account("b", "2026-01-01T00:00:00Z"),
			account("c", "2026-01-01T00:00:00Z"),
		], "a");
		const incoming = response([account("b", "2026-01-03T00:00:00Z", false)], "b");

		const merged = mergeCodexAccounts(current, incoming, "preserveMissing");

		expect(merged.accounts.map(({ id, active }) => [id, active])).toEqual([
			["b", true],
			["c", false],
			["a", false],
		]);
		expect(merged.accountRevision).toBe(7);
	});

	it("removes absent accounts for authoritative GET, mutation, and SSE snapshots", () => {
		const current = response([account("a", "2026-01-01T00:00:00Z"), account("b", "2026-01-02T00:00:00Z")], "a");
		const incoming = response([account("b", "2026-01-02T00:00:00Z", false)], "b");

		expect(mergeCodexAccounts(current, incoming, "replace").accounts).toEqual([
			expect.objectContaining({ id: "b", active: true }),
		]);
	});
});

it("maps every account reason to complete native locale copy with a safe unknown fallback", () => {
	const locales: AppLocale[] = ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "zh-CN"];
	const switchKeys = ["requested", "stopping_sessions", "sessions_stopped", "checkpointing_source", "activating_target", "verifying_target", "restarting_sessions", "rollback_required", "recovery_required", "completed", "failed", "unknown"].map((phase) => `settings.codexAccounts.switch.${phase}`);
	const keys = [...codexAccountReasonCodes.map(codexAccountReasonKey), ...switchKeys];
	for (const locale of locales) {
		const catalog = catalogFor(locale);
		for (const key of keys) {
			const value = catalog[key as keyof typeof catalog];
			expect(value, `${locale}: ${key}`).toBeTruthy();
			expect(value).not.toBe(key);
		}
	}
	expect(codexAccountReasonKey("provider-private-message")).toBe("settings.codexAccounts.reason.unknown");
});
