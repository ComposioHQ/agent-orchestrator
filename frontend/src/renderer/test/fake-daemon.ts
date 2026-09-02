// A daemon that is not the daemon we expect. Every behaviour here was observed
// against a real host: an older build whose web-UI catch-all answers unknown
// routes with a 200 HTML page, a build whose JSON has a different shape, a
// wrong connection password, and a machine that is simply asleep. Casting any
// of them to the expected type puts `undefined.map` on a render path.
export type Behaviour = "healthy" | "html-catchall" | "wrong-shape" | "unauthorized" | "unreachable";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

function healthyResponse(input: RequestInfo | URL): Response {
	const url = new URL(input instanceof Request ? input.url : input.toString());
	switch (url.pathname) {
		case "/healthz":
			return json({ status: "ok", service: "agent-orchestrator-daemon", pid: 1 });
		case "/readyz":
			return json({ status: "ready", service: "agent-orchestrator-daemon", pid: 1 });
		case "/api/v1/projects":
			return json({ projects: [] });
		case "/api/v1/sessions":
			return json({ sessions: [] });
		default:
			return json({ error: "not_found", code: "NOT_FOUND", message: "route not found" }, 404);
	}
}

export function fakeDaemon(behaviour: Behaviour): typeof fetch {
	return async (input) => {
		switch (behaviour) {
			case "healthy":
				return healthyResponse(input);
			case "html-catchall":
				return new Response("<!doctype html><html><body>AO</body></html>", {
					status: 200,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			case "wrong-shape":
				return json({ ok: true });
			case "unauthorized":
				return json(
					{
						error: "unauthorized",
						code: "BAD_PASSWORD",
						message: "missing or invalid connection password",
						requestId: "fake-request",
					},
					401,
				);
			case "unreachable":
				throw new TypeError("fetch failed");
		}
	};
}
