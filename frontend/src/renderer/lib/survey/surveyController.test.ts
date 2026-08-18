import { beforeEach, describe, expect, it, vi } from "vitest";

import { SurveyController, type Storage } from "./surveyController";

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

describe("SurveyController.pick", () => {
	let storage: Storage;
	let capture: ReturnType<typeof vi.fn>;
	let t: number;
	function make() {
		return new SurveyController({ storage, now: () => t, capture, register: vi.fn() });
	}
	beforeEach(() => {
		storage = memoryStorage();
		capture = vi.fn();
		t = 1_000_000_000_000;
	});

	it("shows a project survey on project_added and records survey_shown", () => {
		const c = make();
		expect(c.pick("project_added")?.id).toBe("repo-who");
		expect(capture).toHaveBeenCalledWith("ao.renderer.survey_shown", { survey: "repo-who" });
	});

	it("enforces one survey per week across triggers", () => {
		const c = make();
		expect(c.pick("project_added")).not.toBeNull();
		t += WEEK - 1;
		expect(c.pick("spawn_failed")).toBeNull(); // still inside cooldown
		t += 2;
		expect(c.pick("spawn_failed")?.id).toBe("what-broke"); // cooldown elapsed
	});

	it("never re-asks an answered survey; advances to the next project survey", () => {
		const c = make();
		expect(c.pick("project_added")?.id).toBe("repo-who");
		c.answer("repo-who", "My team");
		t += WEEK + 1;
		expect(c.pick("project_added")?.id).toBe("repo-purpose");
	});

	it("gates pmf behind 3 successful spawns", () => {
		const c = make();
		expect(c.pick("session_spawned")).toBeNull();
		c.noteSpawn();
		c.noteSpawn();
		expect(c.pick("session_spawned")).toBeNull(); // only 2
		c.noteSpawn();
		expect(c.pick("session_spawned")?.id).toBe("pmf");
	});

	it("only offers would-pay to work + team users past 5 spawns", () => {
		const c = make();
		c.answer("repo-who", "My team");
		c.answer("repo-purpose", "Work");
		c.answer("pmf", "I'd be lost"); // clear the earlier session_spawned survey
		for (let i = 0; i < 5; i++) c.noteSpawn();
		t += WEEK + 1;
		expect(c.pick("session_spawned")?.id).toBe("would-pay");
	});

	it("does not offer would-pay to a learning solo user", () => {
		const c = make();
		c.answer("repo-who", "Just me");
		c.answer("repo-purpose", "Learning");
		c.answer("pmf", "No big deal");
		for (let i = 0; i < 9; i++) c.noteSpawn();
		t += WEEK + 1;
		expect(c.pick("session_spawned")).toBeNull();
	});

	it("does not re-show a dismissed survey", () => {
		const c = make();
		c.pick("project_added");
		c.dismiss("repo-who");
		t += WEEK + 1;
		expect(c.pick("project_added")?.id).toBe("repo-purpose"); // skips the dismissed one
	});
});

describe("SurveyController.answer", () => {
	it("emits the analysis event and registers a super-property", () => {
		const capture = vi.fn();
		const register = vi.fn();
		new SurveyController({ storage: memoryStorage(), capture, register }).answer("repo-who", "My team");
		expect(capture).toHaveBeenCalledWith("ao.renderer.survey_answered", { survey: "repo-who", choice: "My team" });
		expect(register).toHaveBeenCalledWith({ survey_repo_who: "My team" });
	});
});
