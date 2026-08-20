import { describe, expect, it, vi } from "vitest";

import { probeRemoteDaemon, type RemoteFetch } from "./remote-mode";

const HEALTH_OK = { status: "ok", service: "agent-orchestrator-daemon", pid: 1, apiVersion: 1 };
const READY_OK = { status: "ready", service: "agent-orchestrator-daemon", pid: 1, apiVersion: 1 };

type ResponseSpec = { status: number; body?: unknown } | { throws: unknown };

function fakeFetch(responses: Record<string, ResponseSpec>): RemoteFetch {
	return vi.fn(async (url: string) => {
		const key = url.includes("/healthz") ? "healthz" : "readyz";
		const spec = responses[key];
		if (!spec) throw new Error(`unexpected fetch: ${url}`);
		if ("throws" in spec) throw spec.throws;
		return {
			status: spec.status,
			json: async () => (spec.body === undefined ? Promise.reject(new Error("bad json")) : spec.body),
		};
	}) as unknown as RemoteFetch;
}

function fetchError(code: string): Error {
	const err = new Error("fetch failed");
	(err as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
	return err;
}

const URL = "https://pi.tail1234.ts.net";
const PW = "sekrit99";

describe("probeRemoteDaemon", () => {
	it("succeeds on a healthy compatible daemon", async () => {
		const outcome = await probeRemoteDaemon(URL, PW, fakeFetch({ healthz: { status: 200, body: HEALTH_OK }, readyz: { status: 200, body: READY_OK } }));
		expect(outcome).toEqual({ ok: true });
	});

	it("sends the password as a Bearer token", async () => {
		const seen: Record<string, string> = {};
		const spy: RemoteFetch = async (url, init) => {
			seen[url] = init?.headers?.Authorization ?? "";
			return { status: 200, json: async () => (url.includes("healthz") ? HEALTH_OK : READY_OK) };
		};
		await probeRemoteDaemon(URL, PW, spy);
		expect(seen[`${URL}/healthz`]).toBe(`Bearer ${PW}`);
		expect(seen[`${URL}/readyz`]).toBe(`Bearer ${PW}`);
	});

	it("maps 401 to remote_unauthorized", async () => {
		const outcome = await probeRemoteDaemon(URL, PW, fakeFetch({ healthz: { status: 401 } }));
		expect(outcome).toMatchObject({ ok: false, code: "remote_unauthorized" });
	});

	it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"])("maps %s to remote_unreachable", async (code) => {
		const outcome = await probeRemoteDaemon(URL, PW, fakeFetch({ healthz: { throws: fetchError(code) } }));
		expect(outcome).toMatchObject({ ok: false, code: "remote_unreachable" });
	});

	it.each(["DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"])(
		"maps %s to remote_tls",
		async (code) => {
			const outcome = await probeRemoteDaemon(URL, PW, fakeFetch({ healthz: { throws: fetchError(code) } }));
			expect(outcome).toMatchObject({ ok: false, code: "remote_tls" });
		},
	);

	it("maps a missing apiVersion (old daemon) to remote_incompatible_api", async () => {
		const old = { status: "ok", service: "agent-orchestrator-daemon", pid: 1 };
		const outcome = await probeRemoteDaemon(URL, PW, fakeFetch({ healthz: { status: 200, body: old } }));
		expect(outcome).toMatchObject({ ok: false, code: "remote_incompatible_api" });
	});

	it("maps a newer apiVersion to remote_incompatible_api", async () => {
		const outcome = await probeRemoteDaemon(
			URL,
			PW,
			fakeFetch({ healthz: { status: 200, body: { ...HEALTH_OK, apiVersion: 999 } } }),
		);
		expect(outcome).toMatchObject({ ok: false, code: "remote_incompatible_api" });
	});

	it("maps a non-daemon service to remote_unreachable", async () => {
		const outcome = await probeRemoteDaemon(
			URL,
			PW,
			fakeFetch({ healthz: { status: 200, body: { status: "ok", service: "nginx", pid: 1, apiVersion: 1 } } }),
		);
		expect(outcome).toMatchObject({ ok: false, code: "remote_unreachable" });
	});

	it("maps a gateway 503 to not_ready", async () => {
		const outcome = await probeRemoteDaemon(URL, PW, fakeFetch({ healthz: { status: 503 } }));
		expect(outcome).toMatchObject({ ok: false, code: "not_ready" });
	});

	it("maps readyz not-ready to not_ready", async () => {
		const outcome = await probeRemoteDaemon(
			URL,
			PW,
			fakeFetch({ healthz: { status: 200, body: HEALTH_OK }, readyz: { status: 200, body: { ...READY_OK, status: "starting" } } }),
		);
		expect(outcome).toMatchObject({ ok: false, code: "not_ready" });
	});

	it("maps a non-JSON response to remote_unreachable", async () => {
		const outcome = await probeRemoteDaemon(URL, PW, fakeFetch({ healthz: { status: 200 } }));
		expect(outcome).toMatchObject({ ok: false, code: "remote_unreachable" });
	});
});
