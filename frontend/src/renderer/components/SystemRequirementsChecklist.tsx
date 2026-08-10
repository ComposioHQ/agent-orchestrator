import { CheckCircle2, TriangleAlert, XCircle } from "lucide-react";
import type { components } from "../../api/schema";

export type SystemRequirement = components["schemas"]["SystemRequirement"];

// Stagger step between each row's entrance animation (brief: ~120-180ms).
const STAGGER_STEP_MS = 150;

// The backend's stable id -> label for "harness" is "agent harness" (see
// systemcheck.go); the product name for this row is "Coding agent".
export function requirementDisplayLabel(requirement: SystemRequirement): string {
	return requirement.id === "harness" ? "Coding agent" : requirement.label;
}

/** Checklist of the 4 startup requirements, in the backend's stable order. */
export function SystemRequirementsChecklist({
	requirements,
	ready,
}: {
	requirements: SystemRequirement[];
	ready: boolean;
}) {
	return (
		<div
			aria-live="polite"
			className="ao-startup-checklist mt-4 flex w-full max-w-content-max flex-col gap-2 text-left"
			role="status"
		>
			{requirements.map((requirement, index) => (
				<div
					key={requirement.id}
					className="ao-startup-checklist__row flex items-start gap-2"
					style={{ animationDelay: `${index * STAGGER_STEP_MS}ms` }}
				>
					<RequirementGlyph requirement={requirement} />
					<div className="min-w-0">
						<p className="text-control font-medium text-foreground">{requirementDisplayLabel(requirement)}</p>
						{requirement.detail ? (
							<p className="text-caption leading-snug text-muted-foreground">{requirement.detail}</p>
						) : null}
					</div>
				</div>
			))}
			{ready ? (
				<p className="ao-startup-checklist__row mt-0.5 text-caption font-medium text-success">All checks passed</p>
			) : null}
		</div>
	);
}

function RequirementGlyph({ requirement }: { requirement: SystemRequirement }) {
	if (requirement.satisfied) {
		return <CheckCircle2 className="mt-0.5 size-icon-base shrink-0 text-success" aria-hidden="true" />;
	}
	if (requirement.required) {
		return <XCircle className="mt-0.5 size-icon-base shrink-0 text-destructive" aria-hidden="true" />;
	}
	return <TriangleAlert className="mt-0.5 size-icon-base shrink-0 text-warning" aria-hidden="true" />;
}
