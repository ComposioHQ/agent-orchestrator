import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { LOCAL_HOST } from "../lib/hosts";
import { routeTree } from "../routeTree.gen";

describe("host-qualified session route", () => {
	it("restores the session on the host encoded in the URL", async () => {
		const hostId = "http://192.0.2.1:3011";
		const sessionId = "same:id";
		const history = createMemoryHistory({
			initialEntries: [`/host/${encodeURIComponent(hostId)}/session/${encodeURIComponent(sessionId)}`],
		});
		const router = createRouter({
			history,
			routeTree,
			context: { queryClient: new QueryClient() },
		});

		await router.load();

		expect(router.state.matches.at(-1)?.params).toMatchObject({ hostId, sessionId });
	});

	it("restores the project on the host encoded in the URL", async () => {
		const hostId = "http://192.0.2.1:3011";
		const projectId = "same:id";
		const history = createMemoryHistory({
			initialEntries: [`/host/${encodeURIComponent(hostId)}/project/${encodeURIComponent(projectId)}`],
		});
		const router = createRouter({
			history,
			routeTree,
			context: { queryClient: new QueryClient() },
		});

		await router.load();

		expect(router.state.matches.at(-1)?.params).toMatchObject({ hostId, projectId });
	});
});

// The four unqualified paths below are the shape every link, bookmark and
// deep link minted before hosts existed still points at. They are kept as
// redirects to the local host — the only host such a URL could have meant —
// and nothing else in the tree covers them.
describe("legacy routes redirect", () => {
	it.each([
		["/sessions/ao-1", { hostId: LOCAL_HOST, sessionId: "ao-1" }],
		["/projects/agent-orchestrator", { hostId: LOCAL_HOST, projectId: "agent-orchestrator" }],
		["/projects/agent-orchestrator/settings", { hostId: LOCAL_HOST, projectId: "agent-orchestrator" }],
		["/projects/agent-orchestrator/sessions/ao-1", { hostId: LOCAL_HOST, sessionId: "ao-1" }],
	])("%s lands on the local host's route", async (from, params) => {
		const router = createRouter({
			history: createMemoryHistory({ initialEntries: [from] }),
			routeTree,
			context: { queryClient: new QueryClient() },
		});

		await router.load();

		expect(router.state.matches.at(-1)?.params).toMatchObject(params);
		expect(router.state.location.pathname).toContain("/host/");
	});
});
