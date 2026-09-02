import { describe, expect, it } from "vitest";
import { fakeDaemon } from "./fake-daemon";

describe("fakeDaemon", () => {
	it("html-catchall answers every path with a 200 HTML page", async () => {
		const fetch = fakeDaemon("html-catchall");
		for (const path of ["/healthz", "/api/v1/projects", "/unknown"]) {
			const response = await fetch(`http://x${path}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toMatch(/html/);
		}
	});

	it("wrong-shape returns valid JSON that is not the expected schema", async () => {
		const response = await fakeDaemon("wrong-shape")(
			"http://x/api/v1/projects",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).not.toHaveProperty("projects");
	});

	it("unauthorized returns the daemon's real 401 envelope", async () => {
		const response = await fakeDaemon("unauthorized")(
			"http://x/api/v1/projects",
		);
		expect(response.status).toBe(401);
		expect((await response.json()).code).toBe("BAD_PASSWORD");
	});

	it("unreachable rejects the way the network does", async () => {
		await expect(
			fakeDaemon("unreachable")("http://x/healthz"),
		).rejects.toThrow(/fetch failed/);
	});

	it("route-missing 404s unknown routes but serves known ones", async () => {
		const fetch = fakeDaemon("route-missing");
		expect((await fetch("http://x/api/v1/fs/dirs")).status).toBe(404);
		expect((await fetch("http://x/api/v1/projects")).status).toBe(200);
	});
});
