// Electron main-process Sentry init. This is the counterpart to the renderer
// sink (renderer/lib/sentry.ts): the renderer SDK forwards its events over IPC
// to the main process, which owns the actual transport — so without this, no
// desktop event is ever uploaded.
//
// Like the renderer side it is a no-op until a DSN is configured
// (AO_SENTRY_DSN) and the SDK is installed; the import is lazy so this file
// compiles and runs with no dependency on @sentry/electron until then.
//
// Privacy posture is deny-by-default (see DESIGN/telemetry plan). Sentry's
// Electron defaults capture far more than AO's PostHog allowlist ever would, so
// we drop every integration that could exfiltrate content or environment:
//   - SentryMinidump    native memory snapshots (could hold prompts/diffs/tokens)
//   - Screenshots       window captures
//   - LocalVariablesAsync / ContextLines   local variable values + source lines
//   - ElectronBreadcrumbs / Console        console/DOM breadcrumbs
//   - ElectronNet / NodeFetch              request breadcrumbs (leak URLs/hosts)
//   - MainProcessSession / ChildProcess    session pings + child crash noise
//   - RendererEventLoopBlock               ANR monitor (errors-only v1)
// We keep only main-process crash capture (uncaught/unhandledRejection), the
// preload injection the renderer SDK needs, safe device/app context, and path
// normalization. Sentry's cache resolves under Electron userData, which AO has
// already pinned to ~/.ao/electron, so it honors the app-data rule.

import { DEFAULT_SENTRY_DSN } from "../shared/sentry-config";

const DENY_INTEGRATIONS = new Set([
	"SentryMinidump",
	"Screenshots",
	"LocalVariablesAsync",
	"ContextLines",
	"ElectronBreadcrumbs",
	"Console",
	"ElectronNet",
	"NodeFetch",
	"MainProcessSession",
	"ChildProcess",
	"RendererEventLoopBlock",
]);

const LOCAL_URL = /(?:\bfile:\/\/\/\S+|\bapp:\/\/renderer\/\S+|\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\S*)/gi;
const HOME_PATH = /\/(?:Users|home)\/[^\s"']+/g;
const WIN_PATH = /[A-Za-z]:\\[^\s"']+|\\\\[^\s"']+/g;

function scrub(value: unknown): unknown {
	if (typeof value === "string")
		return value.replace(LOCAL_URL, "[redacted-url]").replace(HOME_PATH, "[redacted-path]").replace(WIN_PATH, "[redacted-path]");
	return value;
}

function scrubEvent(event: Record<string, unknown>): Record<string, unknown> {
	if (typeof event.message === "string") event.message = scrub(event.message) as string;
	const exception = event.exception as { values?: Array<{ value?: unknown }> } | undefined;
	for (const v of exception?.values ?? []) if (typeof v.value === "string") v.value = scrub(v.value);
	return event;
}

// A nightly/edge/pr semver is not "stable"; keep those out of stable release
// health. Mirrors the renderer's version_channel intent without importing it
// (main and renderer share no module graph here).
function channelOf(version: string): string {
	const v = version.toLowerCase();
	if (v.includes("nightly")) return "nightly";
	if (v.includes("edge") || v.includes("pr")) return "development";
	return "stable";
}

let started = false;

/**
 * Initialize main-process Sentry once, as early as possible (after userData is
 * pinned). No DSN or missing SDK leaves it a silent no-op forever.
 */
export async function initMainSentry(version: string): Promise<void> {
	if (started) return;
	const dsn = (process.env.AO_SENTRY_DSN ?? "").trim() || DEFAULT_SENTRY_DSN;
	if (!dsn) return;
	started = true;
	try {
		// Runtime-computed specifier so the bundler/TS does not require the SDK to
		// be present. SHIP STEP: `npm i @sentry/electron` (already in
		// package.json) and set AO_SENTRY_DSN; then this resolves.
		const spec = ["@sentry", "electron", "main"].join("/");
		const mod = (await import(spec)) as unknown as {
			init: (opts: Record<string, unknown>) => void;
		};
		mod.init({
			dsn,
			release: version,
			environment: channelOf(version),
			autoSessionTracking: false,
			sendDefaultPii: false,
			sampleRate: 1,
			tracesSampleRate: 0,
			// Deny-by-default: keep only crash capture + IPC + safe context + path
			// normalization; drop everything that could carry content/environment.
			integrations: (defaults: Array<{ name: string }>) =>
				defaults.filter((i) => !DENY_INTEGRATIONS.has(i.name)),
			beforeSend: (event: Record<string, unknown>) => scrubEvent(event),
			beforeBreadcrumb: (crumb: Record<string, unknown> | null) => (crumb ? scrubEvent(crumb) : crumb),
		});
	} catch {
		// SDK not installed yet, or init failed — remain a silent no-op.
	}
}
