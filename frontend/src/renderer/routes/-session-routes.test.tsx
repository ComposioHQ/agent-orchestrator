import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => ({
		options,
	}),
}));

vi.mock("../components/SessionView", () => ({ SessionView: () => null }));

import { Route as ProjectSessionRoute } from "./_shell.projects.$projectId_.sessions.$sessionId";
import { Route as CrossProjectSessionRoute } from "./_shell.sessions.$sessionId";

type TestRoute = {
	options: {
		validateSearch: (search: Record<string, unknown>) => { tabOwner?: string };
	};
};

describe.each([
	["project session", ProjectSessionRoute],
	["cross-project session", CrossProjectSessionRoute],
] as const)("%s route", (_label, route) => {
	it("keeps a string tab owner search value", () => {
		const typedRoute = route as unknown as TestRoute;

		expect(typedRoute.options.validateSearch({ tabOwner: "sess-1" })).toEqual({
			tabOwner: "sess-1",
		});
	});

	it("drops non-string tab owner search values", () => {
		const typedRoute = route as unknown as TestRoute;

		expect(typedRoute.options.validateSearch({ tabOwner: 42 })).toEqual({
			tabOwner: undefined,
		});
	});
});
