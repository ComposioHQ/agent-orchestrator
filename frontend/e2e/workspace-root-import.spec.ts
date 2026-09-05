import { expect, test } from "@playwright/test";
import type { AoBridge } from "../src/preload";
import { agentReadiness } from "../src/renderer/test/agent-readiness-fixtures";
import { installFakeAgent } from "./support/fake-bridge";

test("renderer: workspace import preserves the root branch and explains unresolved startup @T0", async ({ page }) => {
	test.setTimeout(120_000);
	await installFakeAgent(page, { projectId: "local-root", workers: [] });
	let created = false;
	let started = false;
	await page.route("http://127.0.0.1:8080/api/v1/**", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (pathname.startsWith("/api/v1/agents/readiness")) {
			await route.fulfill({ json: { agents: [agentReadiness("codex", "Codex")] } });
			return;
		}
		if (pathname === "/api/v1/projects" && route.request().method() === "POST") {
			expect(route.request().postDataJSON()).toMatchObject({
				path: "/repos/local-root", asWorkspace: true, config: { defaultBranch: "trunk" },
			});
			created = true;
			await route.fulfill({ json: { project: {
				id: "local-root", name: "Local workspace", kind: "workspace", path: "/repos/local-root", config: {},
			} } });
			return;
		}
		if (pathname === "/api/v1/orchestrators" && route.request().method() === "POST") {
			started = true;
			// A separate runtime failure must retain its real cause in the board.
			await route.fulfill({ status: 422, json: {
				error: "invalid", code: "DEFAULT_BRANCH_UNRESOLVED",
				message: 'resolve workspace repo "__root__" base: remote did not advertise a symbolic HEAD',
			} });
			return;
		}
		await route.fulfill({ json: {} });
	});
	await page.goto("/#/");
	await page.evaluate(() => {
		// The default fixture has a running orchestrator. This test represents a
		// failed first spawn, so every later CDC/query refresh must also have none.
		// Otherwise SessionsBoard correctly clears the startup error on refresh.
		window.__aoFakeAgent!.removeWorker("local-root-orchestrator");
		const bridge = (window as unknown as { ao: AoBridge }).ao;
		bridge.app.chooseDirectory = async () => "/repos/local-root";
		bridge.app.checkAncestorRepo = async () => undefined;
		bridge.app.getRepositoryBranch = async () => "trunk";
		bridge.app.scanImportFolder = async () => ({ path: "/repos/local-root", repos: [{
			name: "api", path: "/repos/local-root/api", relativePath: "api", branch: "dev",
			hasRemote: true, remote: "https://github.com/example/api.git", status: "ok",
		}] });
	});
	await page.getByRole("button", { name: "New project", exact: true }).first().click();
	await page.getByRole("button", { name: "Import a workspace folder", exact: true }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await page.getByRole("button", { name: "Create workspace and start", exact: true }).click();
	await expect(page).toHaveURL(/projects\/local-root/);
	await expect(page.getByText(/AO could not determine the default branch for the workspace root repository/)).toBeVisible();
	await expect(page.getByText(/Details:.*remote did not advertise a symbolic HEAD/)).toBeVisible();
	expect(created).toBe(true);
	expect(started).toBe(true);
	await page.screenshot({ path: "test-results/workspace-root-startup.png" });
});
