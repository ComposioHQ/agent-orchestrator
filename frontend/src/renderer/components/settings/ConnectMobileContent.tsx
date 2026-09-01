import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, Loader2, RotateCcw } from "lucide-react";
import { apiClient, apiErrorMessage } from "../../lib/api-client";
import { aoBridge } from "../../lib/bridge";
import { captureRendererEvent } from "../../lib/telemetry";
import { ANDROID_PLAY_STORE_URL, TESTFLIGHT_URL } from "./ConnectMobileGetApp";
import { reasonMessage, type SetupMode } from "./ConnectMobileSetup";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { StyledQRCode } from "./StyledQRCode";
import { PairingQr } from "./PairingQr";
import { InstallCloudflared } from "./InstallCloudflared";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const QR_CODE_SIZE = 204;
const TESTFLIGHT_QR_SIZE = 140;

import {
	buildPairingOffer,
	pairingCodeUrl,
	type PairingEndpoint,
} from "../../lib/pairing-payload";

export const mobileStatusQueryKey = ["mobile-status"] as const;

// One scan gives the mobile app every value required to connect. Keep the
// secure key absent for plaintext payloads so older mobile builds can decode
// the same bytes they already understand.
export function pairingPayload(host: string, port: number, password: string, secure?: boolean): string {
	return JSON.stringify(secure ? { v: 1, host, port, password, secure: true } : { v: 1, host, port, password });
}

/**
 * The value encoded into the pairing QR.
 *
 * Prefers the v2 deep link, which carries every endpoint the daemon advertises
 * so the phone can race them, and opens the app straight from the system
 * camera. The payload rides in the fragment, so the connection token never
 * reaches a server even when the link is opened in a browser.
 *
 * Falls back to the v1 payload when the daemon advertises no endpoints — an
 * older daemon, or one whose network is not up yet. Showing a dead v2 QR there
 * would be worse than the pairing that already works.
 */
export function qrValueFor(input: {
	hostId: string;
	host: string;
	platform: string;
	password: string;
	endpoints: readonly PairingEndpoint[];
}): string {
	// v2 only. The phone no longer accepts v1: those codes predate the identity
	// probe the race uses to verify a machine before sending it a credential, so
	// a daemon old enough to need one could never complete a race anyway. An
	// empty endpoint list means there is nothing to advertise yet, and the panel
	// shows the preparing state rather than a code — see qrIsReady.
	return pairingCodeUrl(
		buildPairingOffer({
			endpoints: input.endpoints,
			password: input.password,
			hostId: input.hostId,
			name: input.host,
			platform: input.platform,
		}),
		PAIRING_LINK_BASE,
	);
}

/**
 * How often to re-read mobile status, or false to stop.
 *
 * The connector takes roughly half a minute to become advertisable, and the
 * status query is otherwise fetched once on open and refetched only after a
 * mutation. Without this the modal would sit on "Preparing remote access…"
 * indefinitely while the daemon had long since finished.
 *
 * Polls only while there is a transient state to wait out, so an idle modal
 * does not keep hitting the daemon for the rest of the session.
 */
export function mobileStatusRefetchInterval(
	status: { tunnel?: { running: boolean; ready: boolean } } | undefined,
): number | false {
	const tunnel = status?.tunnel;
	return tunnel?.running && !tunnel.ready ? MOBILE_STATUS_POLL_MS : false;
}

const MOBILE_STATUS_POLL_MS = 2_000;

/**
 * Whether the pairing QR is safe to show.
 *
 * The connector takes roughly thirty seconds after the listener comes up
 * before its hostname resolves. A code scanned inside that window carries no
 * tunnel endpoint, so the pairing works on this network and fails everywhere
 * else — with nothing on either side to indicate why. Holding the code back is
 * the same discipline the daemon already applies to advertising the endpoint.
 *
 * A tunnel that is not running at all is not worth waiting for: LAN-only is a
 * legitimate setup, and blocking pairing forever would be worse than the wait.
 *
 * A daemon that does not report endpoints at all predates the endpoint race.
 * It has no tunnel to wait for, and its QR still works, so it is shown — the
 * absence of the field is not the same as an empty list.
 */
export function qrIsReady(status: {
	enabled: boolean;
	endpoints?: readonly PairingEndpoint[];
	tunnel?: { running: boolean; ready: boolean; [k: string]: unknown };
}): boolean {
	if (!status.enabled) return false;
	// Nothing to encode: a v2 code carries the endpoint list, and there is no
	// longer a v1 form to fall back to. An absent list is as unready as an empty
	// one — it means the daemon has not told us where it can be reached.
	if (!status.endpoints || status.endpoints.length === 0) return false;
	if (status.tunnel?.running && !status.tunnel.ready) return false;
	return true;
}

/** The app's registered scheme (app.json `expo.scheme`), not a universal link:
 * it works today, with no association files to host and no store listing
 * required. Universal links can be added later without changing the payload. */
const PAIRING_LINK_BASE = "aomobile://pair";

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
	/** This machine's stable identity, echoed into the pairing code so the phone
	 * can verify the endpoints it races. Optional: a daemon predating the
	 * endpoint race does not send it, and the QR falls back to the v1 payload. */
	hostId?: string;
	/** Every advertised way to reach this daemon, in preference order. Optional
	 * for the same reason as hostId. */
	endpoints?: PairingEndpoint[];
	/** Managed remote-access connector state, for showing progress while the
	 * tunnel comes up. */
	tunnel?: {
		/** False when this machine has no connector at all — cloudflared is
		 * absent. Distinct from "not started yet", which is running:false. */
		supported?: boolean;
		running: boolean;
		ready: boolean;
		hostname: string;
		location: string;
		lastError: string;
	};
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
		// Only while the connector is coming up — see
		// mobileStatusRefetchInterval.
		refetchInterval: (q) => mobileStatusRefetchInterval(q.state.data),
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

	const startRemoteAccess = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/remote-access");
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
	// No connector on this machine at all: cloudflared is absent and nothing
	// installs it. Pairing still works on the local network, so this is a
	// caveat to state rather than a failure to block on.
	const remoteAccessUnavailable = status?.tunnel ? status.tunnel.supported === false : false;
	const secureBlocked = mode === "tailscale" && (status?.securePairing?.enabled ?? false) && !secureActive;
	const busy =
		enable.isPending ||
		startRemoteAccess.isPending ||
		regenerate.isPending ||
		disable.isPending ||
		setSecure.isPending;

	const clearActionErrors = () => {
		enable.reset();
		startRemoteAccess.reset();
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
		(startRemoteAccess.error instanceof Error && startRemoteAccess.error.message) ||
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

	const showRealQR =
		enabled &&
		activeHost &&
		!secureBlocked &&
		qrIsReady({ enabled, endpoints: status?.endpoints, tunnel: status?.tunnel });
	// v2 when the daemon advertises endpoints, v1 otherwise. Computed once so
	// the rendered QR and its data attribute cannot drift apart.
	const qrValue = showRealQR
		? qrValueFor({
				hostId: status?.hostId ?? "",
				host: activeHost,
				platform: "",
				password: status?.password ?? "",
				endpoints: status?.endpoints ?? [],
			})
		: undefined;
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
								</li>
							</>
						) : (
							<>
								<li>
									{t("mobile.android.step1")}{" "}
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
									<Tooltip>
										<TooltipTrigger asChild>
											<span className="inline-flex">
												<button
													type="button"
													aria-label={t("mobile.regenerate")}
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
											</span>
										</TooltipTrigger>
										<TooltipContent side="bottom">{t("mobile.regenerate")}</TooltipContent>
									</Tooltip>
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

					{remoteAccessUnavailable && (
						// Stated rather than hidden: pairing still works on this network,
						// so this is a limitation of what the code can reach, not an
						// error. Without it the QR looks entirely normal and the user
						// discovers the gap only by being away from home.
						<div className="mt-3">
							<p className="text-xs text-settings-muted" data-testid="mobile-remote-unavailable">
								{t(
									"mobile.remoteAccessUnavailable",
									"Works on this network only — cloudflared isn't installed, so this machine can't be reached from elsewhere.",
								)}
							</p>
							{/* Deliberately not enable(): that mints a fresh password, so
							    installing remote access would invalidate the phone the user
							    had already paired. This re-checks for the binary and starts
							    the connector, leaving the credential alone. */}
							<InstallCloudflared onInstalled={() => void startRemoteAccess.mutate()} />
						</div>
					)}
					{actionError && <p className="mt-3 text-xs text-error">{actionError}</p>}
				</div>

				{/* Right: dedicated pairing-QR panel — square, clipping, flush with
				    the content's right edge so bottom/right spacing match. */}
				<div className="flex w-full shrink-0 flex-col gap-3 self-start sm:w-60">
					{enabled && activeHost ? (
						// Owns its own square box and puts the caption beneath it: the
						// caption cannot live inside a clipping aspect-square, which is
						// what cut it off and pushed it under the button.
						<PairingQr
							value={showRealQR ? (qrValue ?? null) : null}
							size={QR_CODE_SIZE}
							caption={t("mobile.tunnelStarting")}
						/>
					) : (
						<div className="relative aspect-square w-full overflow-hidden rounded-md">
							{enabled && !activeHost ? (
								<div className="flex size-full items-center justify-center bg-(--color-bg-settings-input) p-4">
									<p className="text-center text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
										{mode === "tailscale" ? t("mobile.noTailscaleHost") : t("mobile.noPairingHost")}
									</p>
								</div>
							) : (
								<>
									<div className="size-full opacity-60 blur-[6px]" aria-hidden="true">
										<StyledQRCode
											value={PLACEHOLDER_QR_VALUE}
											size={QR_CODE_SIZE}
											className="block size-full p-4 [&_svg]:size-full"
										/>
									</div>
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
								</>
							)}
						</div>
					)}
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
