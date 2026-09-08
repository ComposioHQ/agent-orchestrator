import { expect, test } from "@playwright/test";
import { agentReadiness } from "../src/renderer/test/agent-readiness-fixtures";
import { installFakeAgent } from "./support/fake-bridge";

// Real renderer with a held daemon response: isolates perceived startup latency
// from provider inference. Never spawns a paid model or claims model speedups.
for (const outcome of ["success", "failure", "background failure"] as const) {
	test(`new task opens chat during startup and handles ${outcome} @T0`, async ({ page }, testInfo) => {
		test.setTimeout(60_000);
		await page.setViewportSize({ width: 1440, height: 1000 });
		await installFakeAgent(page, { projectId: "startup", projectName: "Startup", workers: [] });
		let delegateCount = 0;
		let release!: () => void;
		const startup = new Promise<void>((resolve) => { release = resolve; });
		await page.route("http://127.0.0.1:8080/api/v1/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/v1/settings") {
				await route.fulfill({ json: { defaultSessionMode: "chat", chatHarnesses: ["claude-code"] } });
			} else if (path.startsWith("/api/v1/agents/readiness")) {
				await route.fulfill({ json: { agents: [agentReadiness("claude-code", "Claude Code")] } });
			} else if (path === "/api/v1/projects/startup") {
				await route.fulfill({ json: { status: "ok", project: { id: "startup", config: { worker: { agent: "claude-code", agentConfig: { model: "opus" } } } } } });
			} else if (path.endsWith("/models")) {
				await route.fulfill({ json: { agent: "claude-code", selectionMode: "text", models: [], allowCustom: true, selected: {} } });
			} else if (path === "/api/v1/orchestrators/delegate") {
				delegateCount++;
				expect(route.request().postDataJSON()).toMatchObject({ projectId: "startup", brief: "hi", agent: "claude-code" });
				// Unchanged project-default Opus is inherited by the daemon.
				expect(route.request().postDataJSON().model).toBeUndefined();
				expect(route.request().postDataJSON().mode).toBeUndefined();
				await startup;
				if (outcome !== "success") {
					await route.fulfill({ status: 422, json: { error: "invalid", code: "STARTUP_FAILED", message: "Could not initialize the agent" } });
					return;
				}
				await page.evaluate(() => window.__aoFakeAgent!.createWorker({ id: "startup-worker", title: "hi", mode: "chat", provider: "claude-code" }));
				await route.fulfill({ json: { workerId: "startup-worker" } });
			} else if (path.endsWith("/conversation")) {
				await route.fulfill({ json: { conversationId: "startup-conversation", sessionId: "startup-worker", harness: "claude-code", mode: "chat", controller: "ready", latestSequence: 1, oldestSequence: 1, hasMoreBefore: false,
					turns: [{ id: "first-turn", state: "running", requestedAt: "2026-09-06T00:00:00Z" }],
					messages: [{ kind: "message", id: "first-message", turnId: "first-turn", sequence: 1, revision: 0, role: "user", origin: "human", text: "hi", streaming: false, createdAt: "2026-09-06T00:00:00Z" }],
					activities: [], settings: {} } });
			} else {
				await route.fulfill({ json: { status: "ok", files: [], skills: [] } });
			}
		});
		await page.goto("/#/projects/startup");
		await page.getByRole("button", { name: "New task", exact: true }).first().click();
		await page.getByRole("textbox", { name: "Task", exact: true }).fill("hi");
		await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText(/opus/i);
		const submittedAt = Date.now();
		await page.getByRole("button", { name: "Start task", exact: true }).click();
		await expect(page.getByText("Starting session…", { exact: true })).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByTestId("task-startup-underlying-route")).toHaveAttribute("inert", "");
		await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
		await expect(page.getByText("hi", { exact: true })).toBeVisible();
		const startupVisibleMs = Date.now() - submittedAt;
		await expect.poll(() => delegateCount).toBe(1);
		await expect(page).not.toHaveURL(/sessions\/startup-worker/);
		await testInfo.attach("starting-session", { body: await page.screenshot(), contentType: "image/png" });
		if (outcome === "background failure") {
			await page.evaluate(() => { window.location.hash = "#/projects/startup/sessions/startup-orchestrator"; });
			await expect(page.getByTestId("task-startup-chat")).toBeHidden();
		}
		if (outcome === "success") {
			await page.evaluate(() => {
				const fake = window.__aoFakeAgent!;
				const snapshot = fake.snapshot;
				const gate = new Promise<void>((resolve) => {
					(window as unknown as { releaseStartupSnapshot: () => void }).releaseStartupSnapshot = resolve;
				});
				// fetchWorkspaces is async; hold its result without changing real rendering.
				fake.snapshot = (() => gate.then(() => snapshot())) as unknown as typeof fake.snapshot;
			});
		}
		const response = page.waitForResponse((response) => response.url().endsWith("/orchestrators/delegate"));
		release();
		await response;
		if (outcome === "success") {
			await expect(page.getByText("Starting session…", { exact: true })).toBeVisible();
			await expect(page).not.toHaveURL(/sessions\/startup-worker/);
			await page.evaluate(() => (window as unknown as { releaseStartupSnapshot: () => void }).releaseStartupSnapshot());
		}
		if (outcome === "background failure") {
			await expect(page.getByRole("button", { name: "Return to draft", exact: true })).toBeVisible();
			await expect(page).toHaveURL(/sessions\/startup-orchestrator/);
			await page.getByRole("button", { name: "Return to draft", exact: true }).click();
		}
		if (outcome !== "success") {
			await expect(page.getByRole("alert")).toContainText("Could not initialize the agent");
			await expect(page.getByRole("textbox", { name: "Task", exact: true })).toHaveValue("hi");
			await expect(page.getByRole("button", { name: "Start task", exact: true })).toBeEnabled();
			await testInfo.attach("startup-failure", { body: await page.screenshot(), contentType: "image/png" });
		} else {
			await expect(page).toHaveURL(/sessions\/startup-worker/);
			await expect(page.getByRole("region", { name: "Chat", exact: true })).toBeVisible();
			await expect(page.getByRole("region", { name: "Chat", exact: true }).locator(".cursor-chat-human-message")).toHaveCount(1);
			await expect(page.getByTestId("task-startup-chat")).toHaveCount(0);
		}
		expect(delegateCount).toBe(1);
		await testInfo.attach("startup-timing", { body: JSON.stringify({ startupVisibleMs, delegateCount, note: "Held synthetic daemon response, not a provider benchmark" }), contentType: "application/json" });
	});
}
