export type TerminalTarget =
	| { kind: "worker" }
	| {
			kind: "reviewer";
			handleId: string;
			harness: string;
			session: import("../lib/hosts").Ref;
	  }
	// A standalone shell the user opened by hand — no agent session behind it,
	// so unlike "worker" and "reviewer" it carries its own handle and never
	// reads from the selected session.
	| {
			/** Shell creation identity; prevents a reused handle inheriting old state. */
			generation: string;
			host: import("../lib/hosts").HostId;
			kind: "shell";
			handleId: string;
			/** Undefined only for a standalone shell outside a session route. */
			session?: import("../lib/hosts").Ref;
			title: string;
	  };

export function terminalTargetBelongsToSession(
	target: TerminalTarget,
	session: import("../lib/hosts").Ref | undefined,
): boolean {
	if (target.kind === "worker") return true;
	if (!target.session || !session) return target.session === session;
	return target.session.host === session.host && target.session.id === session.id;
}
