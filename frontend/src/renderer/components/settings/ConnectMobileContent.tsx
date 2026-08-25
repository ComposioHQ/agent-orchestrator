import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, Loader2, RotateCcw } from "lucide-react";
import { apiClient, apiErrorMessage } from "../../lib/api-client";
import { aoBridge } from "../../lib/bridge";
import { captureRendererEvent } from "../../lib/telemetry";
import { cn } from "../../lib/utils";
import { ANDROID_PLAY_STORE_URL, TESTFLIGHT_URL } from "./ConnectMobileGetApp";
import { reasonMessage, type SetupMode } from "./ConnectMobileSetup";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { StyledQRCode } from "./StyledQRCode";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const QR_CODE_SIZE = 204;
const TESTFLIGHT_QR_SIZE = 140;

export const mobileStatusQueryKey = ["mobile-status"] as const;

// One scan gives the mobile app every value required to connect. Keep the
// secure key absent for plaintext payloads so older mobile builds can decode
// the same bytes they already understand.
export function pairingPayload(host: string, port: number, password: string, secure?: boolean): string {
	return JSON.stringify(secure ? { v: 1, host, port, password, secure: true } : { v: 1, host, port, password });
}

/** Static junk payload for the blurred placeholder QR — deliberately not a
 *  real pairing payload so a sneaky scan through the blur gets nothing. */
const PLACEHOLDER_QR_VALUE = "agent-orchestrator";

type MobilePlatform = "ios" | "android";

function AppleIcon({ className }: { className?: string }) {
	return (
		<svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 384 512">
			<path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3Z" />
		</svg>
	);
}

function AndroidIcon({ className }: { className?: string }) {
	return (
		<svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 576 512">
			<path d="M420.55 301.93a24 24 0 1 1 24-24 24 24 0 0 1-24 24m-265.1 0a24 24 0 1 1 24-24 24 24 0 0 1-24 24m273.7-144.48 47.94-83a10 10 0 1 0-17.27-10l-48.54 84.07a301.25 301.25 0 0 0-246.56 0L116.18 64.45a10 10 0 1 0-17.27 10l47.94 83C64.53 202.22 8.24 285.55 0 384h576c-8.24-98.45-64.54-181.78-146.85-226.55" />
		</svg>
	);
}

/** Trailing "Join now ↗" link at the end of a walkthrough step. Border-bottom
 *  instead of text-decoration so the underline runs under the arrow too. */
const STEP_LINK_CLASS =
	"inline-flex items-center gap-0.5 border-b border-[color-mix(in_oklch,var(--color-settings-label)_45%,transparent)] align-baseline text-settings-label transition-colors hover:border-current hover:text-settings-title";

interface MobileStatus {
	enabled: boolean;
	host: string;
	tailscaleHost: string;
	port: number;
	password: string;
	warning: string;
	securePairing: {
		enabled: boolean;
		available: boolean;
		active: boolean;
		host: string;
		port: number;
		reason: string;
	};
}

export async function fetchMobileStatus(): Promise<MobileStatus> {
	const { data, error } = await apiClient.GET("/api/v1/mobile/status");
	if (error || !data) throw new Error(apiErrorMessage(error));
	return data;
}

export function ConnectMobileContent({ active }: { active: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [copied, setCopied] = useState(false);
	const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [platform, setPlatform] = useState<MobilePlatform>("ios");
	const [mode, setMode] = useState<SetupMode>("lan");
	const platformOptions = [
		{ value: "ios", label: t("mobile.ios"), icon: <AppleIcon className="size-4 shrink-0 !text-settings-title" /> },
		{ value: "android", label: t("mobile.android"), icon: <AndroidIcon className="size-4 shrink-0 !text-settings-title" /> },
	] satisfies SettingsOption<MobilePlatform>[];
	const modeOptions = [
		{ value: "lan", label: t("mobile.lan") },
		{ value: "tailscale", label: t("mobile.tailscale") },
	] satisfies SettingsOption<SetupMode>[];
	const renderPlatformOption = (option: SettingsOption<MobilePlatform>) => (
		<span className="flex min-w-0 items-center gap-1.5">
			<span className="flex w-5 shrink-0 justify-center">{option.icon}</span>
			<span className="min-w-0">{option.label}</span>
		</span>
	);

	useEffect(() => {
		return () => {
			if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
		};
	}, []);

	const query = useQuery({
		queryKey: mobileStatusQueryKey,
		queryFn: fetchMobileStatus,
		enabled: active,
	});

	const reportedOpen = useRef(false);
	const initialEnabled = query.data?.enabled;
	useEffect(() => {
		if (!active) {
			reportedOpen.current = false;
			setMode("lan");
			return;
		}
		if (initialEnabled === undefined || reportedOpen.current) return;
		reportedOpen.current = true;
		void captureRendererEvent("ao.renderer.mobile_connect_opened", { bridge_enabled: initialEnabled });
	}, [active, initialEnabled]);

	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: mobileStatusQueryKey });
	};

	const enable = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/enable");
			if (error) throw new Error(apiErrorMessage(error));
			return data;
		},
		onSuccess: invalidate,
	});

	const regenerate = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/regenerate");
			if (error) throw new Error(apiErrorMessage(error));
			return data;
		},
		onSuccess: invalidate,
	});

	const disable = useMutation({
		mutationFn: async () => {
			const { error } = await apiClient.POST("/api/v1/mobile/disable");
			if (error) throw new Error(apiErrorMessage(error));
		},
		onSuccess: invalidate,
	});

	const setSecure = useMutation({
		mutationFn: async (secureEnabled: boolean) => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/secure-pairing", { body: { enabled: secureEnabled } });
			if (error) throw new Error(apiErrorMessage(error));
			return data;
		},
		onSuccess: invalidate,
	});

	const status = query.data;
	const enabled = status?.enabled ?? false;
	const secureActive = mode === "tailscale" && (status?.securePairing?.active ?? false);
	const activeHost = secureActive
		? status!.securePairing.host
		: mode === "tailscale"
			? (status?.tailscaleHost ?? "")
			: (status?.host ?? "");
	const activePort = secureActive ? status!.securePairing.port : (status?.port ?? 0);
	const secureBlocked = mode === "tailscale" && (status?.securePairing?.enabled ?? false) && !secureActive;
	const busy = enable.isPending || regenerate.isPending || disable.isPending || setSecure.isPending;

	const clearActionErrors = () => {
		enable.reset();
		regenerate.reset();
		disable.reset();
		setSecure.reset();
	};

	const copyPassword = async () => {
		if (!status?.password) return;
		try {
			await navigator.clipboard.writeText(status.password);
			setCopied(true);
			if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
			copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard can reject (permissions / non-secure context).
		}
	};

	const reportToggle = (next: boolean, outcome: "succeeded" | "failed") => {
		void captureRendererEvent("ao.renderer.mobile_bridge_toggled", { enabled: next, outcome });
	};

	const startBridge = () => {
		if (busy || enabled) return;
		clearActionErrors();
		enable.mutate(undefined, {
			onSuccess: () => reportToggle(true, "succeeded"),
			onError: () => reportToggle(true, "failed"),
		});
	};

	const actionError =
		(enable.error instanceof Error && enable.error.message) ||
		(regenerate.error instanceof Error && regenerate.error.message) ||
		(disable.error instanceof Error && disable.error.message) ||
		(setSecure.error instanceof Error && setSecure.error.message) ||
		null;

	if (query.isLoading) {
		return <p className="py-4 text-center text-xs text-settings-muted">{t("mobile.checkingStatus")}</p>;
	}
	if (query.isError) {
		return (
			<p className="py-4 text-center text-xs text-error">
				{query.error instanceof Error ? query.error.message : t("mobile.loadFailed")}
			</p>
		);
	}
	if (!status) return null;

	const showRealQR = enabled && activeHost && !secureBlocked;
	const secureReasonText = reasonMessage(status.securePairing?.reason ?? "", t);

	return (
		<div className="flex flex-col gap-4">
			<p className="text-xs leading-4 text-settings-muted">{t("mobile.description")}</p>

			<div className="flex flex-col gap-6 sm:flex-row sm:items-start">
				{/* Left: platform + connection pickers above one combined walkthrough. */}
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex flex-nowrap items-center gap-2">
						<SettingsOptionMenu
							aria-label={t("mobile.getApp")}
							value={platform}
							options={platformOptions}
							onChange={setPlatform}
							triggerClassName="w-44 justify-between"
							renderMenuItem={renderPlatformOption}
							renderTrigger={(selected) => selected && renderPlatformOption(selected)}
							menuClassName="!w-44 !min-w-0"
							menuAlign="start"
						/>
						<SettingsOptionMenu
							aria-label={t("mobile.connectionMethod")}
							value={mode}
							options={modeOptions}
							onChange={setMode}
							triggerClassName="w-44 justify-between"
							menuClassName="!w-44 !min-w-0"
							menuAlign="start"
						/>
					</div>

					{/* One walkthrough per platform × connection combo. Steps are plain
					    text with a trailing "Join now ↗" link; address/password join
					    the list once the QR is generated. */}
					<ol className="settings-mobile-steps mt-4 !text-[13px] !leading-6 !text-[color-mix(in_oklch,var(--color-settings-label)_75%,var(--color-text-settings-muted))]">
						{platform === "ios" ? (
							<>
								<li>{t("mobile.ios.step1")}</li>
								<li>
									{t("mobile.ios.step2")}{" "}
									<TooltipProvider delayDuration={0}>
										<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												className={STEP_LINK_CLASS}
												aria-label={t("mobile.joinTestFlightAria")}
												onClick={() => void aoBridge.app.openExternal(TESTFLIGHT_URL)}
											>
												{t("mobile.scanTestFlight")}
												<ArrowUpRight className="size-3.5" aria-hidden="true" />
											</button>
										</TooltipTrigger>
										<TooltipContent side="bottom" className="p-2" data-testid="testflight-qr">
											<div className="rounded-md bg-(--color-bg-settings-input) p-2">
												<StyledQRCode value={TESTFLIGHT_URL} size={TESTFLIGHT_QR_SIZE} showLogo={false} className="block" />
											</div>
										</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</li>
							</>
						) : (
							<>
								<li>
									{t("mobile.android.step1")}{" "}
									<TooltipProvider delayDuration={0}>
										<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												className={STEP_LINK_CLASS}
												aria-label={t("mobile.androidSignupAria")}
												onClick={() => void aoBridge.app.openExternal(ANDROID_PLAY_STORE_URL)}
											>
												{t("mobile.getApp")}
												<ArrowUpRight className="size-3.5" aria-hidden="true" />
											</button>
										</TooltipTrigger>
										<TooltipContent side="bottom" className="p-2" data-testid="android-play-qr">
											<div className="rounded-md bg-(--color-bg-settings-input) p-2">
												<StyledQRCode value={ANDROID_PLAY_STORE_URL} size={TESTFLIGHT_QR_SIZE} showLogo={false} className="block" />
											</div>
										</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</li>
							</>
						)}
						{mode === "lan" ? (
							<li>{t("mobile.lan.step1")}</li>
						) : (
							<li>{t("mobile.tailscale.step1")}</li>
						)}
						<li>{platform === "ios" ? t("mobile.ios.step3") : t("mobile.android.step3")}</li>
						{showRealQR && (
							<>
								<li data-testid="mobile-pairing-address">
									{t("mobile.address")}:{" "}
									<span className="tracking-settings-mono text-settings-label">{`${activeHost}:${activePort}`}</span>
								</li>
								<li>
									{t("mobile.password")}:{" "}
									<span className="tracking-settings-mono text-settings-label">{status.password}</span>
									<button
										type="button"
										aria-label={copied ? t("mobile.passwordCopied") : t("mobile.copyPassword")}
										className="ml-1.5 inline-flex size-5 items-center justify-center align-middle text-settings-muted transition-colors hover:text-settings-label"
										onClick={() => void copyPassword()}
									>
										{copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
									</button>
									<button
										type="button"
										aria-label={t("mobile.regenerate")}
										title={t("mobile.regenerate")}
										className="ml-0.5 inline-flex size-5 items-center justify-center align-middle text-settings-muted transition-colors hover:text-settings-label disabled:opacity-50"
										disabled={busy}
										onClick={() => {
											clearActionErrors();
											regenerate.mutate();
										}}
									>
										{regenerate.isPending ? (
											<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
										) : (
											<RotateCcw className="size-3.5" aria-hidden="true" />
										)}
									</button>
								</li>
							</>
						)}
					</ol>

					{/* Tailscale extras: secure pairing (required on iPhone) + status. */}
					{mode === "tailscale" && (
						<div className="mt-4 flex flex-col gap-3">
							<div className="relative flex items-start justify-between gap-3 rounded-md border border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] px-3.5 py-2.5">
								<div className="flex min-w-0 flex-col gap-1 pr-2">
									<span className="text-subtitle leading-(--leading-settings-mobile-title) text-settings-label">
										{t("mobile.securePairing")}
									</span>
									<span className="text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
										{t("mobile.securePairing.hint")}
									</span>
								</div>
								<Switch
									checked={status.securePairing?.enabled ?? false}
									onCheckedChange={(on) => {
										clearActionErrors();
										setSecure.mutate(on);
									}}
									disabled={busy}
									aria-label={t("mobile.securePairing")}
								/>
							</div>
							{platform === "ios" && (
								<p className="text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
									{t("mobile.tailscale.iosHint")}
								</p>
							)}
							{(status.securePairing?.enabled ?? false) && secureReasonText && (
								<p className="text-caption leading-(--leading-settings-mobile-hint) text-warning">{secureReasonText}</p>
							)}
						</div>
					)}

					{actionError && <p className="mt-3 text-xs text-error">{actionError}</p>}
				</div>

				{/* Right: dedicated pairing-QR panel — square, clipping, flush with
				    the content's right edge so bottom/right spacing match. */}
				<div className="flex w-full shrink-0 flex-col gap-3 self-start sm:w-60">
					<div className="relative aspect-square w-full overflow-hidden rounded-md">
						{enabled && !activeHost ? (
							<div className="flex size-full items-center justify-center bg-(--color-bg-settings-input) p-4">
								<p className="text-center text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
									{mode === "tailscale" ? t("mobile.noTailscaleHost") : t("mobile.noPairingHost")}
								</p>
							</div>
						) : (
							<>
								<div
									className={cn(
										"size-full transition-[filter,opacity] duration-300 ease-out",
										!showRealQR && "opacity-60 blur-[6px]",
									)}
									aria-hidden={!showRealQR}
								>
									<StyledQRCode
										value={showRealQR ? pairingPayload(activeHost, activePort, status.password, secureActive) : PLACEHOLDER_QR_VALUE}
										data-qr-value={showRealQR ? pairingPayload(activeHost, activePort, status.password, secureActive) : undefined}
										size={QR_CODE_SIZE}
										className="block size-full p-4 [&_svg]:size-full"
									/>
								</div>
								{!showRealQR && (
									<div className="absolute inset-0 flex items-center justify-center">
										<Button
											type="button"
											variant="footer-primary"
											className="rounded-md shadow-lg"
											onClick={startBridge}
											disabled={busy || (enabled && secureBlocked)}
										>
											{t("mobile.generate")}
										</Button>
									</div>
								)}
							</>
						)}
					</div>
					{enabled && (
						<Button
							type="button"
							variant="footer"
							className="w-full"
							disabled={busy}
							onClick={() => {
								clearActionErrors();
								disable.mutate();
							}}
						>
							{t("mobile.disable", "Turn off mobile connection")}
						</Button>
					)}
					</div>
			</div>
		</div>
	);
}
