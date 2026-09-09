import { describe, expect, it } from "vitest";
import type { DashboardSession } from "./api";
import { ALL_PROJECTS, NO_PROJECTS_KNOWN, activeProjectLabel, filteredEmptyCopy, resolveActiveProject, retainProjects } from "./projectFilter";

const listed = [
	{ id: "scratch", name: "Scratch" },
	{ id: "ao", name: "AO" },
];

const session = (projectId: string, over: Partial<DashboardSession> = {}): DashboardSession =>
	({ id: `${projectId}-1`, projectId, status: null, ...over }) as DashboardSession;
const archived = (projectId: string) => session(projectId, { isTerminated: true });

describe("resolveActiveProject", () => {
	// The bug this exists for: the filter named a project removed on the desktop
	// and the board filtered every live session out, with nothing on screen
	// saying so (#4843).
	it("falls back to all projects when the daemon no longer lists the filtered one", () => {
		expect(resolveActiveProject("tmp-filter-demo", listed, true)).toBe("all");
	});

	it("keeps a filter the daemon still lists", () => {
		expect(resolveActiveProject("ao", listed, true)).toBe("ao");
	});

	it("leaves all projects alone", () => {
		expect(resolveActiveProject("all", listed, true)).toBe("all");
		expect(resolveActiveProject("all", [], false)).toBe("all");
	});

	// Before the first answer the list is the empty initial state, which says
	// nothing about the project — dropping the filter there would discard a
	// choice on every cold start.
	it("does not judge against a list that has not landed", () => {
		expect(resolveActiveProject("ao", [], false)).toBe("ao");
	});

	// A daemon that lists nothing IS evidence, and it is not the same state:
	// sessions outlive their project, so there can still be sessions this
	// filter hides.
	it("rejects the filter when the daemon answers with no projects at all", () => {
		expect(resolveActiveProject("ao", [], true)).toBe("all");
	});
});

describe("activeProjectLabel", () => {
	it("names the project when the daemon lists it", () => {
		expect(activeProjectLabel("ao", listed, true)).toBe("AO");
	});

	it("calls the unfiltered board All projects", () => {
		expect(activeProjectLabel("all", listed, true)).toBe("All projects");
	});

	// The label and the filter are one decision. A filter the list does not
	// name applies as All, so it reads as All whichever id the caller passes —
	// the stored choice or the derived one — rather than only agreeing when
	// every caller remembers to pass the derived value.
	it("labels a filter the list does not name the way the board applies it", () => {
		expect(activeProjectLabel("tmp-filter-demo", listed, true)).toBe("All projects");
	});

	// Settings used to fall back to "All projects" here, which is the label that
	// convinced the reporter the board was not filtered.
	it("shows the id rather than All projects while no list has landed", () => {
		expect(activeProjectLabel("tmp-filter-demo", [], false)).toBe("tmp-filter-demo");
	});
});

describe("filteredEmptyCopy", () => {
	it("names the project and counts what the filter hides from the board", () => {
		const sessions = [
			session("scratch"),
			session("scratch"),
			session("scratch"),
			archived("scratch"),
			archived("scratch"),
			archived("scratch"),
			archived("scratch"),
			archived("scratch"),
		];
		expect(filteredEmptyCopy("ao", listed, true, sessions)).toEqual({
			title: "No agents in this project",
			message: "Filtered to AO. 3 agents are in other projects.",
		});
	});

	it("reads as a sentence for one hidden agent", () => {
		expect(filteredEmptyCopy("ao", listed, true, [session("scratch")])?.message).toBe("Filtered to AO. 1 agent is in other projects.");
	});

	// Everything else terminated: "0 agents are in other projects" would argue
	// against the button beside it, and the archive row is what Show all reveals.
	it("says so when the other projects hold only archived sessions", () => {
		expect(filteredEmptyCopy("ao", listed, true, [archived("scratch"), archived("scratch")])?.message).toBe(
			"Filtered to AO. Other projects have only archived sessions.",
		);
	});

	// The ordinary empty state, or the board itself, is the right thing to show.
	it("is null when the filter is All, a session is visible, or nothing is hidden", () => {
		expect(filteredEmptyCopy("all", listed, true, [session("scratch")])).toBeNull();
		expect(filteredEmptyCopy("ao", listed, true, [session("ao"), session("scratch")])).toBeNull();
		expect(filteredEmptyCopy("ao", listed, true, [])).toBeNull();
	});

	// Once the list has landed a stale filter applies as All, so it hides nothing.
	it("is null for a filter the list does not name", () => {
		expect(filteredEmptyCopy("tmp-filter-demo", listed, true, [session("scratch")])).toBeNull();
	});

	// Cold start: the filter applies for the tick before the list lands, and the
	// state names the raw id so the user knows what Show all projects undoes.
	it("names the raw id while no list has landed", () => {
		expect(filteredEmptyCopy("tmp-filter-demo", [], false, [session("scratch")])?.message).toBe(
			"Filtered to tmp-filter-demo. 1 agent is in other projects.",
		);
	});
});

describe("retainProjects", () => {
	const A = "host.h_laptop";
	const B = "host.h_desktop";
	const remaining = [{ id: "remaining", name: "Remaining" }];

	// The review's sequence, with its fixture: a saved filter of "removed", one
	// listed project, one worker in it. Before this, getSessions folded a failed
	// /projects into [] and an empty list was not judged, so the rejected filter
	// came back on the failing tick and the worker vanished with it.
	it("does not let a failed /projects tick reactivate a rejected filter", () => {
		const workers = [session("remaining")];
		const ticks: (typeof remaining | null)[] = [remaining, null, remaining];
		let known = NO_PROJECTS_KNOWN;
		const rows: { applied: string; visible: number }[] = [];
		for (const projects of ticks) {
			known = retainProjects(known, { machine: A, projects });
			const applied = resolveActiveProject("removed", known.projects, known.known);
			// What the board renders: the store filters on the applied value.
			const visible = applied === ALL_PROJECTS ? workers : workers.filter((s) => s.projectId === applied);
			rows.push({ applied, visible: visible.length });
		}
		expect(rows).toEqual([
			{ applied: "all", visible: 1 },
			{ applied: "all", visible: 1 },
			{ applied: "all", visible: 1 },
		]);
	});

	it("keeps the list a machine last answered with when the next tick fails", () => {
		const first = retainProjects(NO_PROJECTS_KNOWN, { machine: A, projects: remaining });
		expect(retainProjects(first, { machine: A, projects: null })).toBe(first);
	});

	// Nothing has been retained for this machine, so there is still no list to
	// judge against — the cold-start state, not "this daemon has no projects".
	it("stays unknown when the first tick for a machine fails", () => {
		expect(retainProjects(NO_PROJECTS_KNOWN, { machine: A, projects: null })).toEqual({
			machine: A,
			projects: [],
			known: false,
		});
	});

	// Re-pairing: the old machine's projects are not evidence about the new one,
	// so the filter saved for B must not be judged against A's list.
	it("drops another machine's list rather than retaining it", () => {
		const onA = retainProjects(NO_PROJECTS_KNOWN, { machine: A, projects: remaining });
		const onB = retainProjects(onA, { machine: B, projects: null });
		expect(onB).toEqual({ machine: B, projects: [], known: false });
		expect(resolveActiveProject("remaining", onB.projects, onB.known)).toBe("remaining");
	});

	// A daemon with no projects answers []. That is a list, and the filter is
	// judged against it — see resolveActiveProject.
	it("counts a successful empty list as known", () => {
		expect(retainProjects(NO_PROJECTS_KNOWN, { machine: A, projects: [] })).toEqual({
			machine: A,
			projects: [],
			known: true,
		});
	});
});
