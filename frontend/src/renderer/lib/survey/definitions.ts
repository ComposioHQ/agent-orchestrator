// Zero-friction in-product micro-surveys.
//
// Each is one question, single-tap, and anchored to a moment the user is
// already in (a repo they just added, a spawn that just failed) so the answer
// is an obvious fact, never a "which kind of user am I" deliberation. Together
// they fill the gaps behavioral telemetry cannot: work vs personal, is there a
// team, would they miss us, what broke. See ./README.md for the rationale.

export type SurveyTrigger =
	| "project_added"
	| "session_spawned"
	| "spawn_failed"
	| "second_session";

export type SurveyDef = {
	/** Stable id; also the suffix of the captured event's `survey` property. */
	id: string;
	/** The moment this survey is eligible to appear. */
	trigger: SurveyTrigger;
	/** One line, answerable at a glance. */
	question: string;
	/** 2-4 mutually-exclusive, obvious choices. */
	choices: string[];
	/** Minimum lifetime successful spawns before eligible (targets activated users). */
	minSpawns?: number;
	/** Only eligible when this returns true for the user's prior answers. */
	requires?: (answers: Readonly<Record<string, string>>) => boolean;
};

export const SURVEYS: SurveyDef[] = [
	{
		id: "repo-who",
		trigger: "project_added",
		question: "Who else works in this repo?",
		choices: ["Just me", "My team", "It's public"],
	},
	{
		id: "repo-purpose",
		trigger: "project_added",
		question: "This project is…",
		choices: ["Work", "Side project", "Learning"],
	},
	{
		id: "pmf",
		trigger: "session_spawned",
		minSpawns: 3,
		question: "If AO disappeared tomorrow?",
		choices: ["I'd be lost", "Mildly annoyed", "No big deal"],
	},
	{
		id: "what-broke",
		trigger: "spawn_failed",
		question: "What went wrong?",
		choices: ["Setup / install", "The agent's output", "Too slow", "Just testing"],
	},
	{
		id: "why-ao",
		trigger: "second_session",
		question: "AO is most useful to you for…",
		choices: [
			"Running many agents at once",
			"Auto-handling CI / conflicts / reviews",
			"Just exploring",
		],
	},
	{
		// Only asked of people who told us this is work with a team — never a
		// student, so it can't nag the wrong audience.
		id: "would-pay",
		trigger: "session_spawned",
		minSpawns: 5,
		question: "Would your team pay for this?",
		choices: ["Yes", "Maybe", "No"],
		requires: (a) => a["repo-purpose"] === "Work" && a["repo-who"] === "My team",
	},
];
