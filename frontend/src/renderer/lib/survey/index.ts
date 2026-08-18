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
	if (controller.spawnCount() === 2) {
		offer("second_session"); // one-time early "what do you use it for" nudge
	} else {
		offer("session_spawned"); // pmf (>=3) / would-pay (>=5, gated)
	}
}

/** The prompt component calls these on tap / close. */
export function answerCurrentSurvey(choice: string): void {
	if (!current) return;
	controller.answer(current.id, choice);
	current = null;
	emit();
}

export function dismissCurrentSurvey(): void {
	if (!current) return;
	controller.dismiss(current.id);
	current = null;
	emit();
}
