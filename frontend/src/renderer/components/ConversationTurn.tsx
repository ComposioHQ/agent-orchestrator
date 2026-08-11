import { useState } from "react";
import { useSteerTurn } from "../hooks/useSteerTurn";

type Props = {
	sessionId: string;
	turnId: string;
	text: string;
	state: string; // queued, promoted, etc.
	role?: string;
};

export function ConversationTurn({ sessionId, turnId, text, state, role = "human" }: Props) {
	const { steer, pending, error } = useSteerTurn(sessionId, turnId);
	const [promoted, setPromoted] = useState(state === "promoted" || state === "interrupted");

	if (role !== "human") return null;
	if (promoted) {
		return (
			<div data-testid="turn-promoted" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
				Steered into the running turn.
			</div>
		);
	}
	if (state !== "queued") return null;

	return (
		<div data-testid="turn-queued" className="rounded-md border border-border px-3 py-2">
			<div className="text-sm whitespace-pre-wrap">{text}</div>
			<button
				type="button"
				data-testid="steer-now"
				disabled={pending}
				onClick={async () => {
					const res = await steer();
					if (res.ok) setPromoted(true);
				}}
				className="mt-2 inline-flex items-center rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
			>
				{pending ? "Steering…" : "Steer now"}
			</button>
			{error ? <div className="mt-1 text-xs text-destructive" role="alert">{error}</div> : null}
		</div>
	);
}
