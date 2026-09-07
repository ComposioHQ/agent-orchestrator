import { describe, expect, it } from "vitest";
import { activeProjectLabel, filteredEmptyCopy, resolveActiveProject } from "./projectFilter";

const listed = [
	{ id: "scratch", name: "Scratch" },
	{ id: "ao", name: "AO" },
];

describe("resolveActiveProject", () => {
	// The bug this exists for: the filter named a project removed on the desktop
	// and the board filtered every live session out, with nothing on screen
	// saying so (#4843).
	it("falls back to all projects when the daemon no longer lists the filtered one", () => {
		expect(resolveActiveProject("tmp-filter-demo", listed)).toBe("all");
	});

	it("keeps a filter the daemon still lists", () => {
		expect(resolveActiveProject("ao", listed)).toBe("ao");
	});

	it("leaves all projects alone", () => {
		expect(resolveActiveProject("all", listed)).toBe("all");
		expect(resolveActiveProject("all", [])).toBe("all");
	});

	// Before the first fetch the list is the empty initial state, and after a
	// failed /projects it is the [] getSessions substitutes. Neither says the
	// project is gone; judging against either would drop a valid filter on
	// every cold start or every blip.
	it("does not judge against an empty list", () => {
		expect(resolveActiveProject("ao", [])).toBe("ao");
	});
});

describe("activeProjectLabel", () => {
	it("names the project when the daemon lists it", () => {
		expect(activeProjectLabel("ao", listed)).toBe("AO");
	});

	it("calls the unfiltered board All projects", () => {
		expect(activeProjectLabel("all", listed)).toBe("All projects");
	});

	// Settings used to fall back to "All projects" here, which is the label that
	// convinced the reporter the board was not filtered.
	it("shows the id rather than All projects while the list cannot name it", () => {
		expect(activeProjectLabel("tmp-filter-demo", [])).toBe("tmp-filter-demo");
	});
});

describe("filteredEmptyCopy", () => {
	it("names the project and counts what the filter hides from the board", () => {
		expect(filteredEmptyCopy("AO", { live: 3, archived: 5 })).toEqual({
			title: "No agents in this project",
			message: "Filtered to AO. 3 agents are in other projects.",
		});
	});

	it("reads as a sentence for one hidden agent", () => {
		expect(filteredEmptyCopy("AO", { live: 1, archived: 0 }).message).toBe("Filtered to AO. 1 agent is in other projects.");
	});

	// Everything else terminated: "0 agents are in other projects" would argue
	// against the button beside it, and the archive row is what Show all reveals.
	it("says so when the other projects hold only archived sessions", () => {
		expect(filteredEmptyCopy("AO", { live: 0, archived: 4 }).message).toBe(
			"Filtered to AO. Other projects have only archived sessions.",
		);
	});
});
