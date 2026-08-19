// Public API for the in-product micro-surveys: a module-level singleton
// controller plus the four trigger hooks the app calls, and the tiny store the
// prompt component subscribes to. Everything routes through the renderer's own
// captureRendererEvent, so answers ride the same batched, sanitized pipeline as
// every other event and cost nothing extra.

import posthog from "posthog-js";

import { captureRendererEvent } from "../telemetry";
import type { SurveyDef, SurveyTrigger } from "./definitions";
import { SurveyController } from "./surveyController";

const controller = new SurveyController({
	storage: typeof window !== "undefined" ? window.localStorage : undefined,
	capture: (event, properties) => void captureRendererEvent(event, properties),
	register: (properties) => {
		try {
			posthog.register(properties);
		} catch {
			// PostHog not initialized (telemetry withheld): nothing to tag.
		}
	},
});

let current: SurveyDef | null = null;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of listeners) l();
};

/** Subscribe the prompt component to survey visibility changes. */
export function subscribeSurvey(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The survey to show right now, or null. Stable reference between changes. */
export function getCurrentSurvey(): SurveyDef | null {
	return current;
}

function offer(trigger: SurveyTrigger): void {
	if (current) return; // one at a time
	const survey = controller.pick(trigger);
	if (survey) {
		current = survey;
		emit();
	}
}

/** Call once when the app opens: offers the early profile question. */
export function onAppStart(): void {
	offer("app_start");
}

/** Call when a project/repo is added. */
export function onProjectAdded(): void {
	offer("project_added");
}

/** Call when a spawn fails. */
export function onSpawnFailed(): void {
	offer("spawn_failed");
}

/** Call on every successful spawn: counts activation and offers the eligible survey. */
export function onSessionSpawned(): void {
	controller.noteSpawn();
	offer("session_spawned"); // pmf (>=3), task type, autonomy, wish (>=5), pay (>=5)
}

/** The prompt component calls this on submit; value is a choice, a multi list, or text. */
export function answerCurrentSurvey(value: string | string[]): void {
	if (!current) return;
	controller.answer(current.id, value);
	current = null;
	emit();
}

export function dismissCurrentSurvey(): void {
	if (!current) return;
	controller.dismiss(current.id);
	current = null;
	emit();
}
