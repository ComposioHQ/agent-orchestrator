import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFile(new URL(relativePath, import.meta.url), "utf8");

describe("cloud project security boundaries", () => {
	it("keeps tokens, API origins, and fetch clients out of the renderer cloud flow", async () => {
		const rendererSources = await Promise.all([
			source("../renderer/components/CloudProjectFlow.tsx"),
			source("../renderer/components/CreateProjectFlow.tsx"),
			source("../renderer/lib/cloud-session.ts"),
			source("../shared/cloud-projects.ts"),
		]);
		const renderer = rendererSources.join("\n");

		expect(renderer).not.toMatch(/apiBaseUrl|getAccessToken|Authorization\s*:|fetch\s*\(/);
		expect(renderer).not.toMatch(/interface\s+(?:WorkspacePlacement|CloudClient)/);
	});

	it("routes project operations through the generated client in Electron main", async () => {
		const main = await source("./cloud-projects.ts");
		const appClient = await source("./cloud-app-client.ts");
		const auth = await source("./cloud-auth.ts");

		expect(main).toContain("createCloudClient");
		expect(main).toContain("placementClient.createWorkspacePlacement");
		expect(main).toContain("placementClient.getWorkspacePlacement");
		expect(main).toContain("appClient.listProjects");
		expect(main).toContain("appClient.spawnSession");
		expect(appClient).toContain("createClient<paths>");
		expect(auth).toContain(".exchangeGoogleIdentity");
		expect(auth).toContain(".refreshSession");
		expect(auth).toContain(".logoutSession");
	});
});
