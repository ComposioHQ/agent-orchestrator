// Electron main is the only permitted desktop Sentry intake/sender boundary.
// The production release gate is intentionally closed in Task 6, so this
// module constructs no network client. Controller tests inject an in-memory
// transport; a later release task may add a privacy-approved main transport.
import type { RendererTelemetryCapture } from "../shared/telemetry-policy";
import type { DesktopTelemetryTransport } from "./desktop-telemetry-controller";

export async function initMainSentry(_version: string, _cacheRoot: string): Promise<DesktopTelemetryTransport | null> {
	return null;
}

export function rendererCaptureAllowed(request: RendererTelemetryCapture): boolean {
	if (typeof request.message !== "string" || request.message.length > 4096) return false;
	if (typeof request.consentGeneration !== "string" || request.consentGeneration.length > 256) return false;
	if (request.tags && (Object.keys(request.tags).length > 32 || Object.entries(request.tags).some(([key, value]) => key.length > 64 || value.length > 128))) return false;
	return true;
}
