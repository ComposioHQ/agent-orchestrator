import { describe, expect, it } from "vitest";
import { encodePairingCode, parsePairingCode, pairingUrl } from "./pairingCode";

const offer = {
	v: 2 as const,
	hostId: "h_b3e07f31",
	name: "prasad-mbp",
	platform: "darwin",
	endpoints: [
		{ kind: "lan" as const, host: "192.168.1.42", port: 3011, secure: false },
		{ kind: "tunnel" as const, host: "abc.trycloudflare.com", port: 443, secure: true },
	],
	token: "pw-123",
};

describe("parsePairingCode", () => {
	it("round-trips an offer through the encoded form", () => {
		const got = parsePairingCode(encodePairingCode(offer));

		expect(got).not.toBeNull();
		expect(got?.hostId).toBe("h_b3e07f31");
		expect(got?.endpoints).toHaveLength(2);
		expect(got?.token).toBe("pw-123");
	});

	// The QR encodes a URL so the system camera can open the app. The payload
	// rides in the fragment, which browsers never send to a server, keeping the
	// token out of web logs and referrer headers.
	it("reads the payload out of a deep link fragment", () => {
		const got = parsePairingCode(pairingUrl(offer, "aomobile://pair"));

		expect(got?.hostId).toBe("h_b3e07f31");
	});

	it("reads the payload out of an https universal link", () => {
		const got = parsePairingCode(pairingUrl(offer, "https://aoagents.dev/pair"));

		expect(got?.hostId).toBe("h_b3e07f31");
	});

	// Someone who cannot scan copies the code from the desktop and pastes it.
	it("accepts a bare code with no URL around it", () => {
		const got = parsePairingCode(`   ${encodePairingCode(offer)}   `);

		expect(got?.hostId).toBe("h_b3e07f31");
	});

	// A new phone paired against a desktop that has not updated yet. Rejecting
	// this would break the mixed-version case entirely.
	it("still accepts a legacy v1 payload", () => {
		const got = parsePairingCode(
			JSON.stringify({ v: 1, host: "192.168.1.5", port: 3011, password: "old-pw" }),
		);

		expect(got).not.toBeNull();
		expect(got?.endpoints).toEqual([
			{ kind: "lan", host: "192.168.1.5", port: 3011, secure: false },
		]);
		expect(got?.token).toBe("old-pw");
		// v1 predates host ids, so the machine adopts one on first connect.
		expect(got?.hostId).toBe("");
	});

	it("maps a legacy secure payload to a tailscale endpoint", () => {
		const got = parsePairingCode(
			JSON.stringify({ v: 1, host: "mbp.tail1234.ts.net", port: 443, password: "p", secure: true }),
		);

		expect(got?.endpoints[0]).toEqual({
			kind: "tailscale",
			host: "mbp.tail1234.ts.net",
			port: 443,
			secure: true,
		});
	});

	it.each([
		["empty", ""],
		["not a code", "hello world"],
		["a different app's link", "otherapp://pair#abc"],
		["valid base64 that is not an offer", btoa(JSON.stringify({ hello: "world" }))],
		["an offer from a newer major version", btoa(JSON.stringify({ v: 99, hostId: "x" }))],
		["an offer with no endpoints", btoa(JSON.stringify({ v: 2, hostId: "h_x", endpoints: [] }))],
	])("rejects %s", (_name, input) => {
		expect(parsePairingCode(input)).toBeNull();
	});

	// Desktop strips base64 padding for a smaller QR; some JS runtimes reject
	// unpadded input, so it has to be restored before decoding.
	it("decodes a payload whose base64 padding was stripped", () => {
		const padded = encodePairingCode(offer);
		expect(parsePairingCode(padded.replace(/=+$/, ""))?.hostId).toBe("h_b3e07f31");
	});
});

// A scheme mismatch between the desktop's QR and the app's registered scheme
// fails silently: the camera opens nothing and there is no error anywhere. Pin
// the parser to what app.json actually registers.
describe("deep link scheme", () => {
	it("matches the scheme the app registers in app.json", async () => {
		const appConfig = (await import("../app.json")) as unknown as {
			default: { expo: { scheme: string } };
		};
		const scheme = appConfig.default.expo.scheme;

		const got = parsePairingCode(pairingUrl(offer, `${scheme}://pair`));

		expect(got?.hostId).toBe("h_b3e07f31");
	});
});
