import { useSyncExternalStore } from "react";

import {
	answerCurrentSurvey,
	dismissCurrentSurvey,
	getCurrentSurvey,
	subscribeSurvey,
} from "../lib/survey";

/**
 * A single, unobtrusive one-tap survey card. Renders nothing until a trigger
 * offers a survey; the controller guarantees at most one per user per week, so
 * this never nags. Non-blocking (bottom-right, dismissible) so it can't
 * interrupt work.
 */
export function SurveyPrompt() {
	const survey = useSyncExternalStore(subscribeSurvey, getCurrentSurvey, getCurrentSurvey);
	if (!survey) return null;

	return (
		<div className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg">
			<button
				type="button"
				aria-label="Dismiss"
				onClick={dismissCurrentSurvey}
				className="absolute right-2.5 top-2 text-lg leading-none text-muted-foreground hover:text-foreground"
			>
				×
			</button>
			<p className="pr-4 text-sm font-medium">{survey.question}</p>
			<div className="mt-3 flex flex-col gap-1.5">
				{survey.choices.map((choice) => (
					<button
						key={choice}
						type="button"
						onClick={() => answerCurrentSurvey(choice)}
						className="rounded-lg border border-border px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-accent hover:text-accent-foreground"
					>
						{choice}
					</button>
				))}
			</div>
		</div>
	);
}
