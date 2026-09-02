import { beforeEach, describe, expect, it, vi } from "vitest";
import { setApiBaseUrl } from "./api-client";
import { aoBridge } from "./bridge";
import { LOCAL_HOST } from "./hosts";
import {
	baseUrlFor,
	clientFor,
	connectedHosts,
	connectHost,
	disconnectHost,
	forgetHost,
	hostLabelFor,
	isHostReady,
	registerHostBase,
	subscribeConnectedHosts,
} from "./host-clients";

const REMOTE = "http://192.0.2.1:3011";
const OTHER_REMOTE = "http://192.0.2.9:3011";

beforeEach(() => {
	forgetHost(REMOTE);
	forgetHost(OTHER_REMOTE);
	setApiBaseUrl("http://127.0.0.1:3001");
	vi.restoreAllMocks();
});

describe("host-clients", () => {
	it("resolves the local host to the daemon base", () => {
		expect(baseUrlFor(LOCAL_HOST)).toBe("http://127.0.0.1:3001");
		expect(isHostReady(LOCAL_HOST)).toBe(true);
	});

	it("reports an unregistered remote as not ready rather than throwing", () => {
		expect(baseUrlFor(REMOTE)).toBeNull();
		expect(isHostReady(REMOTE)).toBe(false);
	});

	it("routes a remote request through that host's proxy base", async () => {
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response('{"projects":[]}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await clientFor(REMOTE).GET("/api/v1/projects");
		expect((fetchSpy.mock.calls[0][0] as Request).url).toBe(
			"http://127.0.0.1:9999/tok/api/v1/projects",
		);
	});

	it("routes a local request to the local daemon, not a proxy", async () => {
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response('{"projects":[]}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await clientFor(LOCAL_HOST).GET("/api/v1/projects");
		expect((fetchSpy.mock.calls[0][0] as Request).url).toBe(
			"http://127.0.0.1:3001/api/v1/projects",
		);
	});

	it("follows the local base when the daemon moves port", async () => {
		clientFor(LOCAL_HOST);
		setApiBaseUrl("http://127.0.0.1:3037");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response('{"projects":[]}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await clientFor(LOCAL_HOST).GET("/api/v1/projects");

		expect((fetchSpy.mock.calls[0][0] as Request).url).toBe(
			"http://127.0.0.1:3037/api/v1/projects",
		);
	});

	it("forgetting a host makes it not ready again", () => {
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		expect(isHostReady(REMOTE)).toBe(true);
		forgetHost(REMOTE);
		expect(isHostReady(REMOTE)).toBe(false);
	});

	it("binds a connected host to the proxy base returned by main", async () => {
		vi.spyOn(aoBridge.remotes, "connect").mockResolvedValue({
			label: "workbox",
			url: REMOTE,
			base: "http://127.0.0.1:9999/tok",
		});

		await connectHost(REMOTE);

		expect(baseUrlFor(REMOTE)).toBe("http://127.0.0.1:9999/tok");
		expect(hostLabelFor(REMOTE)).toBe("workbox");
	});

	it("publishes connected-host changes for a mounted workspace query", () => {
		const changed = vi.fn();
		const unsubscribe = subscribeConnectedHosts(changed);

		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok", "workbox");
		expect(changed).toHaveBeenCalledOnce();
		expect(connectedHosts()).toEqual([REMOTE]);

		forgetHost(REMOTE);
		expect(changed).toHaveBeenCalledTimes(2);
		unsubscribe();
	});

	it("forgets a host before waiting for its proxy to close", async () => {
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		let finishDisconnect!: () => void;
		const disconnect = vi
			.spyOn(aoBridge.remotes, "disconnect")
			.mockReturnValue(
				new Promise<void>((resolve) => {
					finishDisconnect = resolve;
				}),
			);

		const pending = disconnectHost(REMOTE);

		expect(isHostReady(REMOTE)).toBe(false);
		expect(disconnect).toHaveBeenCalledWith(REMOTE);
		finishDisconnect();
		await pending;
	});
});
