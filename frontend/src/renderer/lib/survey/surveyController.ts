// Gating + capture for the in-product micro-surveys.
//
// Pure and injectable (storage, clock, capture, register are all passed in) so
// the eligibility rules are unit-testable without a browser or PostHog. It
// deliberately does NOT use PostHog's native survey feature: the renderer
// disables /surveys and /flags polling to avoid per-request billing, so a
// survey answer is captured as an ordinary event instead. No extra network
// cost, and no dependency on the surveys API.

import { SURVEYS, type SurveyDef, type SurveyTrigger } from "./definitions";

const STATE_KEY = "ao.survey.state.v1";
// At most one survey per user per week — a hard anti-nag guarantee.
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

type State = {
	spawnCount: number;
	shownAt: number;
	answers: Record<string, string>; // surveyId -> chosen answer
	dismissed: string[]; // surveyIds the user closed without answering
};

const EMPTY: State = { spawnCount: 0, shownAt: 0, answers: {}, dismissed: [] };

export type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export type Capture = (event: string, properties?: Record<string, unknown>) => void;
export type Register = (properties: Record<string, unknown>) => void;

export type SurveyDeps = {
	storage?: Storage;
	now?: () => number;
	capture?: Capture;
	register?: Register;
};

export class SurveyController {
	private storage?: Storage;
	private now: () => number;
	private capture: Capture;
	private register: Register;

	constructor(deps: SurveyDeps = {}) {
		this.storage = deps.storage;
		this.now = deps.now ?? (() => Date.now());
		this.capture = deps.capture ?? (() => {});
		this.register = deps.register ?? (() => {});
	}

	private load(): State {
		if (!this.storage) return { ...EMPTY };
		try {
			const raw = this.storage.getItem(STATE_KEY);
			if (!raw) return { ...EMPTY };
			return { ...EMPTY, ...(JSON.parse(raw) as Partial<State>) };
		} catch {
			return { ...EMPTY };
		}
	}

	private save(s: State): void {
		try {
			this.storage?.setItem(STATE_KEY, JSON.stringify(s));
		} catch {
			// Storage blocked (private mode): surveys simply won't persist.
		}
	}

	/** Count a successful spawn toward the activation gates. */
	noteSpawn(): void {
		const s = this.load();
		s.spawnCount += 1;
		this.save(s);
	}

	/** Lifetime successful spawns recorded for this install. */
	spawnCount(): number {
		return this.load().spawnCount;
	}

	/**
	 * Returns the survey to show for a trigger right now, or null. Enforces:
	 * one-per-week cooldown, never re-ask an answered survey, activation gate
	 * (minSpawns), and per-survey `requires` predicates. Marking it shown is a
	 * side effect so the same call decides and reserves atomically.
	 */
	pick(trigger: SurveyTrigger): SurveyDef | null {
		const s = this.load();
		if (this.now() - s.shownAt < COOLDOWN_MS) return null;

		const eligible = SURVEYS.find(
			(d) =>
				d.trigger === trigger &&
				s.answers[d.id] === undefined &&
				!s.dismissed.includes(d.id) &&
				(d.minSpawns == null || s.spawnCount >= d.minSpawns) &&
				(d.requires ? d.requires(s.answers) : true),
		);
		if (!eligible) return null;

		s.shownAt = this.now();
		this.save(s);
		this.capture("ao.renderer.survey_shown", { survey: eligible.id });
		return eligible;
	}

	/** Record the user's answer (a single choice, a multi-select list, or free
	 * text): persist it and emit the event the analysis reads. */
	answer(surveyId: string, value: string | string[]): void {
		const choice = Array.isArray(value) ? value.join(", ") : value;
		const s = this.load();
		s.answers[surveyId] = choice;
		this.save(s);
		this.capture("ao.renderer.survey_answered", {
			survey: surveyId,
			choice,
			...(Array.isArray(value) ? { choices: value } : {}),
		});
		// Session-scoped convenience so same-session events can be sliced by the
		// answer; the canonical record for cross-tabs is the event above, since
		// renderer persistence is memory-only.
		this.register({ [`survey_${surveyId.replace(/-/g, "_")}`]: choice });
	}

	/** User closed it without answering: don't re-show, note it once. */
	dismiss(surveyId: string): void {
		const s = this.load();
		if (!s.dismissed.includes(surveyId)) s.dismissed.push(surveyId);
		this.save(s);
		this.capture("ao.renderer.survey_dismissed", { survey: surveyId });
	}
}
