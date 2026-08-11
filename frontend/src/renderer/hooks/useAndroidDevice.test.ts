import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: (...args: unknown[]) => getMock(...args), POST: (...args: unknown[]) => postMock(...args) },
	hasTrustedApiBaseUrl: () => true,
}));

import {
	fetchAndroidEmulatorStatus,
	fetchAndroidSDKStatus,
	sendAndroidInput,
	setupAndroidSDK,
	startAndroidEmulator,
	stopAndroidEmulator,
} from "./useAndroidDevice";

describe("useAndroidDevice fetch functions", () => {
	beforeEach(() => {
		getMock.mockReset();
		postMock.mockReset();
	});

	it("fetches SDK status", async () => {
		getMock.mockResolvedValue({ data: { state: "not_installed" } });
		const status = await fetchAndroidSDKStatus();
		expect(getMock).toHaveBeenCalledWith("/api/v1/android-device/sdk/status");
		expect(status).toEqual({ state: "not_installed" });
	});

	it("throws the API error when fetching SDK status fails", async () => {
		getMock.mockResolvedValue({ error: { message: "boom" } });
		await expect(fetchAndroidSDKStatus()).rejects.toEqual({ message: "boom" });
	});

	it("fetches emulator status", async () => {
		getMock.mockResolvedValue({ data: { state: "running", accelAvailable: true } });
		const status = await fetchAndroidEmulatorStatus();
		expect(getMock).toHaveBeenCalledWith("/api/v1/android-device/status");
		expect(status).toEqual({ state: "running", accelAvailable: true });
	});

	it("starts SDK setup with explicit license acceptance", async () => {
		postMock.mockResolvedValue({ data: { state: "downloading" } });
		const status = await setupAndroidSDK();
		expect(postMock).toHaveBeenCalledWith("/api/v1/android-device/sdk/setup", {
			body: { acceptLicenses: true },
		});
		expect(status).toEqual({ state: "downloading" });
	});

	it("starts the emulator", async () => {
		postMock.mockResolvedValue({ data: { state: "booting", accelAvailable: true } });
		const status = await startAndroidEmulator();
		expect(postMock).toHaveBeenCalledWith("/api/v1/android-device/start");
		expect(status).toEqual({ state: "booting", accelAvailable: true });
	});

	it("stops the emulator", async () => {
		postMock.mockResolvedValue({ data: { state: "stopping", accelAvailable: true } });
		const status = await stopAndroidEmulator();
		expect(postMock).toHaveBeenCalledWith("/api/v1/android-device/stop");
		expect(status).toEqual({ state: "stopping", accelAvailable: true });
	});

	it("sends a tap input action", async () => {
		postMock.mockResolvedValue({ data: { ok: true } });
		await sendAndroidInput({ type: "tap", x: 100, y: 200 });
		expect(postMock).toHaveBeenCalledWith("/api/v1/android-device/input", {
			body: { type: "tap", x: 100, y: 200 },
		});
	});

	it("throws the API error when an input action fails", async () => {
		postMock.mockResolvedValue({ error: { message: "device not running" } });
		await expect(sendAndroidInput({ type: "key", key: "Home" })).rejects.toEqual({
			message: "device not running",
		});
	});
});
