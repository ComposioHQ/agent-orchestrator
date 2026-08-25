// TEMPORARY dev-only diagnostics for the terminal resize investigation.
// Lines POSTed here are printed by the ao-diag middleware in
// vite.renderer.config.ts, so renderer-side event ordering shows up in the
// forge/daemon terminal without devtools. Remove together with that middleware
// once the resize work settles.
export function diag(line: string): void {
	if (!import.meta.env.DEV) return;
	try {
		void fetch("/__ao_diag", {
			method: "POST",
			body: `${(performance.now() | 0) % 1_000_000} ${line}`,
			keepalive: true,
		}).catch(() => undefined);
	} catch {
		// Diagnostics must never break the app.
	}
}
