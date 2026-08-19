// Zero-friction in-product micro-surveys.
//
// Each is one question, answerable at a glance, and anchored to a moment the
// user is already in (opened the app, added a repo, finished/failed a session)
// so the answer is an obvious fact, never a "which kind of user am I?"
// deliberation. Together they fill the gaps behavioral telemetry cannot:
// profession, is there a team, how they actually work, would they miss us,
// what broke, and open feedback. See ./README.md for the rationale.

export type SurveyTrigger =
	| "app_start"
	| "project_added"
	| "session_spawned"
	| "spawn_failed";

/** single = one tap (auto-submits); multi = pick many + Done; text = short answer. */
export type SurveyInput = "single" | "multi" | "text";

export type SurveyDef = {
	/** Stable id; also the `survey` property on the captured event. */
	id: string;
	trigger: SurveyTrigger;
	input: SurveyInput;
	question: string;
	/** Options for single/multi. */
	choices?: string[];
	/** Placeholder for text. */
	placeholder?: string;
	/** Minimum lifetime successful spawns before eligible (targets activated users). */
	minSpawns?: number;
	/** Only eligible when this returns true for the user's prior answers. */
	requires?: (answers: Readonly<Record<string, string>>) => boolean;
};

// Order matters: within one trigger, the first eligible survey is shown. With
// the one-per-week cap, higher-priority questions surface first, then later
// ones over subsequent weeks.
export const SURVEYS: SurveyDef[] = [
	{
		id: "profile",
		trigger: "app_start",
		input: "single",
		question: "What best describes you?",
		choices: ["Developer", "Founder / building a startup", "Student", "Other"],
	},
	{
		id: "repo-who",
		trigger: "project_added",
		input: "single",
		question: "Who else works in this repo?",
		choices: ["Just me", "My team", "It's public"],
	},
	{
		id: "repo-purpose",
		trigger: "project_added",
		input: "single",
		question: "This project is…",
		choices: ["Work", "Side project", "Learning"],
	},
	{
		id: "pmf",
		trigger: "session_spawned",
		input: "single",
		minSpawns: 3,
		question: "If AO disappeared tomorrow?",
		choices: ["I'd be lost", "Mildly annoyed", "No big deal"],
	},
	{
		id: "task-type",
		trigger: "session_spawned",
		input: "multi",
		question: "What did you use this agent for?",
		choices: ["Bug fix", "New feature", "Refactor", "Tests", "CI / maintenance", "Exploring"],
	},
	{
		id: "autonomy",
		trigger: "session_spawned",
		input: "single",
		question: "How closely did you watch it?",
		choices: ["Let it run", "Checked in", "Watched every step"],
	},
	{
		id: "wish",
		trigger: "session_spawned",
		input: "text",
		minSpawns: 5,
		question: "One thing you wish AO did automatically?",
		placeholder: "e.g. auto-open a PR when CI is green",
	},
	{
		id: "would-pay",
		trigger: "session_spawned",
		input: "single",
		minSpawns: 5,
		question: "Is AO worth paying for?",
		choices: ["Yes, already would", "Maybe, if it did more", "Not yet"],
		requires: (a) => a["repo-purpose"] === "Work" && a["repo-who"] === "My team",
	},
	{
		id: "feedback",
		trigger: "session_spawned",
		input: "text",
		minSpawns: 8,
		question: "Anything you'd tell the team?",
		placeholder: "Optional — anything at all",
	},
	{
		id: "blocker",
		trigger: "spawn_failed",
		input: "multi",
		question: "Biggest thing slowing you down?",
		choices: ["Setup", "Speed", "Output quality", "Managing many agents", "Nothing"],
	},
];
