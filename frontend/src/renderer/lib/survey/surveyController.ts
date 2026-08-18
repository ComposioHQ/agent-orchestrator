// State + capture for the in-product survey.
//
// Pure and injectable (storage, clock, capture are all passed in) so the rules
// are unit-testable without a browser or PostHog. It does NOT use PostHog's
// native survey feature: the renderer disables /surveys and /flags polling to
// avoid per-request billing, so answers are captured as ordinary events.

const STATE_KEY = "ao.survey.state.v1";
/** How long the sidebar invite stays hidden after the user crosses it. */
export const INVITE_SNOOZE_MS = 48 * 60 * 60 * 1000;

type State = {
	answers: Record<string, string>; // questionId -> answer (multi joined with ", ")
	completed: boolean; // finished once -> never invite again
	inviteDismissedAt: number; // ms epoch the invite was crossed -> 48h quiet
	optedOut: boolean; // chose "don't show again" -> never invite again
};

const EMPTY: State = { answers: {}, completed: false, inviteDismissedAt: 0, optedOut: false };

export type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export type Capture = (event: string, properties?: Record<string, unknown>) => void;

export type SurveyDeps = {
	storage?: Storage;
	now?: () => number;
	capture?: Capture;
};

export class SurveyController {
	private storage?: Storage;
	private now: () => number;
	private capture: Capture;

	constructor(deps: SurveyDeps = {}) {
		this.storage = deps.storage;
		this.now = deps.now ?? (() => Date.now());
		this.capture = deps.capture ?? (() => {});
	}

	private load(): State {
		if (!this.storage) return { ...EMPTY, answers: {} };
		try {
			const raw = this.storage.getItem(STATE_KEY);
			if (!raw) return { ...EMPTY, answers: {} };
			return { ...EMPTY, ...(JSON.parse(raw) as Partial<State>) };
		} catch {
			return { ...EMPTY, answers: {} };
		}
	}

	private save(s: State): void {
		try {
			this.storage?.setItem(STATE_KEY, JSON.stringify(s));
		} catch {
			// Storage blocked (private mode): state simply won't persist.
		}
	}

	/** Record one answer (a single choice, a multi-select list, or free text)
	 * and emit the per-question event for step-level analysis. */
	answer(id: string, value: string | string[]): void {
		const choice = Array.isArray(value) ? value.join(", ") : value;
		const s = this.load();
		s.answers[id] = choice;
		this.save(s);
		this.capture("ao.renderer.survey_answered", {
			survey: id,
			choice,
			...(Array.isArray(value) ? { choices: value } : {}),
		});
	}

	/** User finished the survey: record completion (never invite again) and emit
	 * one event carrying every answer as answer_<id>, so a whole response reads
	 * as a single row for metrics without joining per-question events. */
	markCompleted(): void {
		const s = this.load();
		s.completed = true;
		this.save(s);
		const props: Record<string, unknown> = {};
		for (const [id, value] of Object.entries(s.answers)) {
			props[`answer_${id.replace(/-/g, "_")}`] = value;
		}
		this.capture("ao.renderer.survey_completed", props);
	}

	/** The sidebar invite is eligible when the user has not completed the survey,
	 * has not opted out for good, and is not within the 48h quiet window after
	 * crossing it. */
	inviteEligible(): boolean {
		const s = this.load();
		if (s.completed || s.optedOut) return false;
		return this.now() - s.inviteDismissedAt >= INVITE_SNOOZE_MS;
	}

	/** User crossed the invite: hush it for 48 hours. */
	dismissInvite(): void {
		const s = this.load();
		s.inviteDismissedAt = this.now();
		this.save(s);
		this.capture("ao.renderer.survey_invite_dismissed", {});
	}

	/** User chose "don't show again": retire the invite for good. */
	optOut(): void {
		const s = this.load();
		s.optedOut = true;
		this.save(s);
		this.capture("ao.renderer.survey_invite_opted_out", {});
	}
}
