import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, Info, Loader2, RotateCcw } from "lucide-react";
import { motion } from "motion/react";
import { RadioGroup } from "radix-ui";
import { apiClient, apiErrorMessage } from "../../lib/api-client";
import { aoBridge } from "../../lib/bridge";
import { captureRendererEvent } from "../../lib/telemetry";
import { cn } from "../../lib/utils";
import { ANDROID_SIGNUP_URL, TESTFLIGHT_URL } from "./ConnectMobileGetApp";
import { reasonMessage, type SetupMode } from "./ConnectMobileSetup";
import { StyledQRCode } from "./StyledQRCode";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

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

/** Trailing "Join now ↗" link at the end of a walkthrough step. Border-bottom
 *  instead of text-decoration so the underline runs under the arrow too. */
const STEP_LINK_CLASS =
	"inline-flex items-center gap-0.5 border-b border-[color-mix(in_oklch,var(--color-settings-label)_45%,transparent)] align-baseline text-settings-label transition-colors hover:border-current hover:text-settings-title";

/** Radix segment item whose checked highlight is a shared motion layout
 *  element, so the indicator slides between options instead of jumping. */
function SegmentItem({
	value,
	indicatorId,
	selected,
	children,
}: {
	value: string;
	indicatorId: string;
	selected: boolean;
	children: React.ReactNode;
}) {
	return (
		<RadioGroup.Item
			value={value}
			className="settings-segment-item relative rounded-[calc(var(--radius-settings-action)-2px)] data-[state=checked]:!bg-transparent"
		>
			{selected && (
				<motion.span
					layoutId={indicatorId}
					className="absolute inset-0 rounded-[calc(var(--radius-settings-action)-2px)] bg-[color-mix(in_oklch,var(--color-bg-settings-menu-selected)_78%,var(--color-text-settings-title))]"
					transition={{ type: "spring", duration: 0.3, bounce: 0 }}
				/>
			)}
			<span className="relative">{children}</span>
		</RadioGroup.Item>
	);
}

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

	const disable = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/mobile/disable");
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
	const busy = enable.isPending || disable.isPending || regenerate.isPending || setSecure.isPending;

	const clearActionErrors = () => {
		enable.reset();
		disable.reset();
		regenerate.reset();
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

	const stopBridge = () => {
		if (busy || !enabled) return;
		clearActionErrors();
		disable.mutate(undefined, {
			onSuccess: () => reportToggle(false, "succeeded"),
			onError: () => reportToggle(false, "failed"),
		});
	};

	const actionError =
		(enable.error instanceof Error && enable.error.message) ||
		(disable.error instanceof Error && disable.error.message) ||
		(regenerate.error instanceof Error && regenerate.error.message) ||
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
			{enabled && status.warning && !secureActive && (
				<p className="flex items-start gap-2 text-caption leading-(--leading-settings-mobile-warning) text-warning">
					<Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
					<span>{status.warning}</span>
				</p>
			)}

			<div className="flex flex-col gap-6 sm:flex-row sm:items-start">
				{/* Left: platform + connection pickers above one combined walkthrough. */}
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex flex-wrap items-center gap-2">
						<RadioGroup.Root
							value={platform}
							onValueChange={(value) => setPlatform(value as MobilePlatform)}
							aria-label={t("mobile.getApp")}
							className="settings-segment"
						>
							<SegmentItem value="ios" indicatorId="mobile-platform-indicator" selected={platform === "ios"}>
								{t("mobile.ios")}
							</SegmentItem>
							<SegmentItem value="android" indicatorId="mobile-platform-indicator" selected={platform === "android"}>
								{t("mobile.android")}
							</SegmentItem>
						</RadioGroup.Root>
						<RadioGroup.Root
							value={mode}
							onValueChange={(value) => setMode(value as SetupMode)}
							aria-label={t("mobile.connectionMethod")}
							className="settings-segment"
						>
							<SegmentItem value="lan" indicatorId="mobile-mode-indicator" selected={mode === "lan"}>
								{t("mobile.lan")}
							</SegmentItem>
							<SegmentItem value="tailscale" indicatorId="mobile-mode-indicator" selected={mode === "tailscale"}>
								{t("mobile.tailscale")}
							</SegmentItem>
						</RadioGroup.Root>
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
												{t("mobile.joinNow")}
												<ArrowUpRight className="size-3.5" aria-hidden="true" />
											</button>
										</TooltipTrigger>
										<TooltipContent side="bottom" className="p-2" data-testid="testflight-qr">
											<div className="flex flex-col items-center gap-2">
												<div className="rounded-md bg-(--color-bg-settings-input) p-2">
													<StyledQRCode value={TESTFLIGHT_URL} size={TESTFLIGHT_QR_SIZE} showLogo={false} className="block" />
												</div>
												<p className="text-caption">{t("mobile.qrHint")}</p>
											</div>
										</TooltipContent>
									</Tooltip>
								</li>
							</>
						) : (
							<>
								<li>
									{t("mobile.android.step1")}{" "}
									<button
										type="button"
										className={STEP_LINK_CLASS}
										aria-label={t("mobile.androidSignupAria")}
										onClick={() => void aoBridge.app.openExternal(ANDROID_SIGNUP_URL)}
									>
										{t("mobile.joinNow")}
										<ArrowUpRight className="size-3.5" aria-hidden="true" />
									</button>
								</li>
								<li>{t("mobile.android.step2")}</li>
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
					<div className="relative aspect-square w-full overflow-hidden rounded-md border border-(--color-border-settings-input) bg-(--color-bg-settings-input)">
						{enabled && !activeHost ? (
							<div className="flex size-full items-center justify-center bg-(--color-bg-settings-input) p-4">
								<p className="text-center text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
									{mode === "tailscale" ? t("mobile.noTailscaleHost") : t("mobile.noPairingHost")}
								</p>
							</div>
						) : (
							<>
								<div className={cn("size-full", !showRealQR && "opacity-60 blur-[6px]")} aria-hidden={!showRealQR}>
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
											{enable.isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
											{t("mobile.generate")}
										</Button>
									</div>
								)}
							</>
						)}
					</div>
					{enabled && (
						<div className="flex items-center justify-between gap-3 px-1">
							<span className="text-caption text-settings-muted">{t("mobile.enable")}</span>
							<Switch
								checked
								disabled={busy}
								aria-label={t("mobile.enable")}
								onCheckedChange={(next) => {
									if (!next) stopBridge();
								}}
							/>
						</div>
					)}

					</div>
			</div>
		</div>
	);
}
