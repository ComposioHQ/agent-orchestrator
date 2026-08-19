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
	// Answer a survey and let the weekly cooldown elapse, so the next pick is eligible.
	function answerAndWait(c: SurveyController, id: string, value: string | string[] = "x") {
		c.answer(id, value);
		t += WEEK + 1;
	}
	beforeEach(() => {
		storage = memoryStorage();
		capture = vi.fn();
		t = 1_000_000_000_000;
	});

	it("shows the profile question on app_start", () => {
		expect(make().pick("app_start")?.id).toBe("profile");
	});

	it("shows repo-who then repo-purpose on successive project adds", () => {
		const c = make();
		expect(c.pick("project_added")?.id).toBe("repo-who");
		answerAndWait(c, "repo-who", "My team");
		expect(c.pick("project_added")?.id).toBe("repo-purpose");
	});

	it("shows the blocker survey on a failed spawn", () => {
		expect(make().pick("spawn_failed")?.id).toBe("blocker");
	});

	it("enforces one survey per week across triggers", () => {
		const c = make();
		expect(c.pick("app_start")).not.toBeNull();
		t += WEEK - 1;
		expect(c.pick("project_added")).toBeNull();
		t += 2;
		expect(c.pick("project_added")).not.toBeNull();
	});

	it("shows an ungated workflow survey first on a session, gating pmf behind 3 spawns", () => {
		const c = make();
		c.noteSpawn(); // 1
		expect(c.pick("session_spawned")?.id).toBe("task-type"); // no gate
		answerAndWait(c, "task-type", ["Bug fix", "Tests"]);
		expect(c.pick("session_spawned")?.id).toBe("autonomy"); // still ungated
		answerAndWait(c, "autonomy", "Let it run");
		expect(c.pick("session_spawned")).toBeNull(); // pmf needs 3, only 1 spawn
		c.noteSpawn();
		c.noteSpawn(); // 3
		expect(c.pick("session_spawned")?.id).toBe("pmf");
	});

	it("offers would-pay only to work + team users, otherwise never", () => {
		const setup = (who: string, purpose: string) => {
			const c = make();
			c.answer("repo-who", who);
			c.answer("repo-purpose", purpose);
			c.answer("task-type", "Bug fix");
			c.answer("autonomy", "Let it run");
			c.answer("pmf", "I'd be lost");
			c.answer("wish", "auto PR");
			for (let i = 0; i < 8; i++) c.noteSpawn();
			t += WEEK + 1;
			return c;
		};
		expect(setup("My team", "Work").pick("session_spawned")?.id).toBe("would-pay");
		// solo / learning user: would-pay is skipped, the next eligible is feedback
		expect(setup("Just me", "Learning").pick("session_spawned")?.id).toBe("feedback");
	});

	it("does not re-show a dismissed survey", () => {
		const c = make();
		c.pick("app_start");
		c.dismiss("profile");
		t += WEEK + 1;
		expect(c.pick("app_start")).toBeNull();
	});
});

describe("SurveyController.answer", () => {
	it("emits the analysis event for a single choice and registers a super-property", () => {
		const capture = vi.fn();
		const register = vi.fn();
		new SurveyController({ storage: memoryStorage(), capture, register }).answer("profile", "Developer");
		expect(capture).toHaveBeenCalledWith("ao.renderer.survey_answered", { survey: "profile", choice: "Developer" });
		expect(register).toHaveBeenCalledWith({ survey_profile: "Developer" });
	});

	it("joins a multi-select answer and includes the raw list", () => {
		const capture = vi.fn();
		new SurveyController({ storage: memoryStorage(), capture }).answer("task-type", ["Bug fix", "Tests"]);
		expect(capture).toHaveBeenCalledWith("ao.renderer.survey_answered", {
			survey: "task-type",
			choice: "Bug fix, Tests",
			choices: ["Bug fix", "Tests"],
		});
	});
});
