// TEMPORARY dev-only diagnostics for the terminal resize investigation.
// Lines POSTed here are printed by the ao-diag middleware in
// vite.renderer.config.ts, so renderer-side event ordering shows up in the
// forge/daemon terminal without devtools. Remove together with that middleware
// once the resize work settles.
//
// Batched: diag() is called from resize hot paths (per observed frame during a
// drag), and a fetch per event is itself enough overhead to contaminate what
// it measures. Lines buffer in memory and flush as one request per 400ms.
let pendingLines: string[] = [];
let flushTimer: number | null = null;

function flushDiag(): void {
	flushTimer = null;
	if (pendingLines.length === 0) return;
	const body = pendingLines.join("\n");
	pendingLines = [];
	try {
		void fetch("/__ao_diag", { method: "POST", body, keepalive: true }).catch(() => undefined);
	} catch {
		// Diagnostics must never break the app.
	}
}

export function diag(line: string): void {
	if (!import.meta.env.DEV) return;
	pendingLines.push(`${(performance.now() | 0) % 1_000_000} ${line}`);
	if (flushTimer === null) flushTimer = window.setTimeout(flushDiag, 400);
}
