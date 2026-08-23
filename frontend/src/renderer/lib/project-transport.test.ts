import { beforeEach, describe, expect, it } from "vitest";
import {
	LOCAL_TRANSPORT,
	indexWorkspaceTransports,
	resetWorkspaceTransports,
	transportForProject,
	transportForSession,
	transportOf,
} from "./project-transport";

describe("transportOf", () => {
	it("routes local projects to the loopback daemon", () => {
		expect(transportOf({})).toEqual(LOCAL_TRANSPORT);
		expect(transportOf({ location: "local" })).toEqual(LOCAL_TRANSPORT);
	});

	it("routes cloud projects to their own organization", () => {
		expect(transportOf({ location: "cloud", orgId: "org_1" })).toEqual({ location: "cloud", orgId: "org_1" });
	});

	it("refuses to route a cloud project with no organization", () => {
		// An org-less cloud row would produce requests with an empty org path
		// segment; falling back to local keeps those requests from being made.
		expect(transportOf({ location: "cloud" })).toEqual(LOCAL_TRANSPORT);
	});
});

describe("workspace transport index", () => {
	beforeEach(() => {
		resetWorkspaceTransports();
	});

	it("routes each session by the project it belongs to", () => {
		indexWorkspaceTransports([
			{ id: "local_1", sessions: [{ id: "s_local" }] },
			{ id: "cloud_1", location: "cloud", orgId: "org_1", sessions: [{ id: "s_cloud" }] },
		]);

		expect(transportForProject("local_1")).toEqual(LOCAL_TRANSPORT);
		expect(transportForProject("cloud_1")).toEqual({ location: "cloud", orgId: "org_1" });
		expect(transportForSession("s_local")).toEqual(LOCAL_TRANSPORT);
		expect(transportForSession("s_cloud")).toEqual({ location: "cloud", orgId: "org_1" });
	});

	it("defaults an unknown id to local rather than guessing an organization", () => {
		indexWorkspaceTransports([{ id: "cloud_1", location: "cloud", orgId: "org_1", sessions: [] }]);
		expect(transportForSession("never_seen")).toEqual(LOCAL_TRANSPORT);
	});

	it("replaces the index so a removed cloud project stops routing to the control plane", () => {
		indexWorkspaceTransports([
			{ id: "cloud_1", location: "cloud", orgId: "org_1", sessions: [{ id: "s_cloud" }] },
		]);
		indexWorkspaceTransports([{ id: "local_1", sessions: [{ id: "s_local" }] }]);

		expect(transportForProject("cloud_1")).toEqual(LOCAL_TRANSPORT);
		expect(transportForSession("s_cloud")).toEqual(LOCAL_TRANSPORT);
	});
});
