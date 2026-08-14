import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./api-client";
import {
	AgentNotInstalledError,
	assertAgentInstalled,
	isAgentNotInstalledError,
} from "./agent-install-preflight";

vi.mock("./api-client", () => ({
	apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

const get = vi.mocked(apiClient.GET as unknown as (...args: unknown[]) => Promise<unknown>);
const post = vi.mocked(apiClient.POST as unknown as (...args: unknown[]) => Promise<unknown>);

const catalog = (installed: string[]) => ({
	data: {
		supported: [
			{ id: "claude-code", label: "Claude Code" },
			{ id: "goose", label: "Goose" },
		],
		installed: installed.map((id) => ({ id, label: id === "goose" ? "Goose" : "Claude Code" })),
		authorized: [],
	},
	error: undefined,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("assertAgentInstalled", () => {
	it("blocks the spawn when a fresh probe confirms the CLI is missing", async () => {
		get.mockResolvedValue(catalog(["claude-code"]));
		post.mockResolvedValue({
			data: { agent: { id: "goose", label: "Goose" }, supported: true, installed: false },
			error: undefined,
		});

		await expect(assertAgentInstalled("goose")).rejects.toBeInstanceOf(AgentNotInstalledError);
		await expect(assertAgentInstalled("goose")).rejects.toMatchObject({
			agentId: "goose",
			agentLabel: "Goose",
			code: "AGENT_NOT_INSTALLED",
		});
	});

	it("allows an agent the catalog already reports as installed without probing", async () => {
		get.mockResolvedValue(catalog(["claude-code", "goose"]));

		await expect(assertAgentInstalled("goose")).resolves.toBeUndefined();
		expect(post).not.toHaveBeenCalled();
	});

	// The catalog is a boot-time snapshot, so an agent installed after the daemon
	// started still shows as missing there. Blocking on it would refuse a spawn
	// that works.
	it("allows an agent the stale catalog missed but a fresh probe finds", async () => {
		get.mockResolvedValue(catalog(["claude-code"]));
		post.mockResolvedValue({
			data: { agent: { id: "goose", label: "Goose" }, supported: true, installed: true },
			error: undefined,
		});

		await expect(assertAgentInstalled("goose")).resolves.toBeUndefined();
	});

	it("defers to the daemon when the probe endpoint is unavailable", async () => {
		get.mockResolvedValue(catalog(["claude-code"]));
		post.mockResolvedValue({ data: undefined, error: { code: "NOT_IMPLEMENTED" } });

		await expect(assertAgentInstalled("goose")).resolves.toBeUndefined();
	});

	it("defers to the daemon when the catalog cannot be read", async () => {
		get.mockResolvedValue({ data: undefined, error: { code: "UNAVAILABLE" } });

		await expect(assertAgentInstalled("goose")).resolves.toBeUndefined();
		expect(post).not.toHaveBeenCalled();
	});

	it("defers to the daemon when a request throws", async () => {
		get.mockRejectedValue(new Error("network down"));

		await expect(assertAgentInstalled("goose")).resolves.toBeUndefined();
	});

	// An unknown harness and an unset agent are the daemon's to reject: it already
	// answers UNKNOWN_HARNESS / AGENT_REQUIRED with actionable text.
	it("defers to the daemon for an unsupported or unset agent", async () => {
		get.mockResolvedValue(catalog(["claude-code"]));

		await expect(assertAgentInstalled("bogus")).resolves.toBeUndefined();
		await expect(assertAgentInstalled("")).resolves.toBeUndefined();
		await expect(assertAgentInstalled(undefined)).resolves.toBeUndefined();
		expect(post).not.toHaveBeenCalled();
	});
});

describe("isAgentNotInstalledError", () => {
	it("only matches the install block", () => {
		expect(isAgentNotInstalledError(new AgentNotInstalledError("goose", "Goose"))).toBe(true);
		expect(isAgentNotInstalledError(new Error("goose"))).toBe(false);
		expect(isAgentNotInstalledError(undefined)).toBe(false);
	});
});
