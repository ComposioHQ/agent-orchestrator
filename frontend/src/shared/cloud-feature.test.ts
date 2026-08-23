import { describe, expect, it } from "vitest";
import { cloudDesktopConfigured, cloudEarlyAccessEnabled, cloudFeatureFlagEnabled } from "./cloud-feature";

describe("cloudFeatureFlagEnabled", () => {
	it("accepts the documented truthy spellings and nothing else", () => {
		for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
			expect(cloudFeatureFlagEnabled(value)).toBe(true);
		}
		for (const value of ["0", "false", "off", "", " ", undefined]) {
			expect(cloudFeatureFlagEnabled(value)).toBe(false);
		}
	});
});

describe("cloudDesktopConfigured", () => {
	it("requires both a control-plane URL and a Google client id", () => {
		expect(cloudDesktopConfigured({ apiUrl: "https://cloud.example", googleClientId: "client" })).toBe(true);
		expect(cloudDesktopConfigured({ apiUrl: "https://cloud.example", googleClientId: "  " })).toBe(false);
		expect(cloudDesktopConfigured({ apiUrl: undefined, googleClientId: "client" })).toBe(false);
	});
});

describe("cloudEarlyAccessEnabled", () => {
	it("stays off when the build is unconfigured, however loud the opt-in", () => {
		expect(
			cloudEarlyAccessEnabled({ configured: false, featureFlags: ["1"], preferenceEnabled: true }),
		).toBe(false);
	});

	it("turns on from either the environment flag or the persisted preference", () => {
		expect(
			cloudEarlyAccessEnabled({ configured: true, featureFlags: ["1"], preferenceEnabled: false }),
		).toBe(true);
		expect(
			cloudEarlyAccessEnabled({ configured: true, featureFlags: [undefined], preferenceEnabled: true }),
		).toBe(true);
		expect(
			cloudEarlyAccessEnabled({ configured: true, featureFlags: [undefined], preferenceEnabled: false }),
		).toBe(false);
	});
});
