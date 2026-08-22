import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Info, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { apiClient, apiErrorMessage } from "../../lib/api-client";
import { captureRendererEvent } from "../../lib/telemetry";
import { cn } from "../../lib/utils";
import { ConnectMobileGetApp } from "./ConnectMobileGetApp";
import { ConnectMobileSetup, type SetupMode } from "./ConnectMobileSetup";
import { MobileDevicesSection } from "./MobileDevicesSection";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { mobileStatusQueryKey, pairingPayload } from "../ConnectMobileModal";

const QR_CODE_SIZE = 204;

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

async function fetchMobileStatus(): Promise<MobileStatus> {
	const { data, error } = await apiClient.GET("/api/v1/mobile/status");
	if (error || !data) throw new Error(apiErrorMessage(error));
	return data;
}

export function ConnectMobileContent({ active }: { active: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [copied, setCopied] = useState(false);
	const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

	const onToggle = (next: boolean) => {
		if (busy) return;
		clearActionErrors();
		const report = (outcome: "succeeded" | "failed") => {
			void captureRendererEvent("ao.renderer.mobile_bridge_toggled", { enabled: next, outcome });
		};
		const mutation = next ? enable : disable;
		mutation.mutate(undefined, { onSuccess: () => report("succeeded"), onError: () => report("failed") });
	};

	const actionError =
		(enable.error instanceof Error && enable.error.message) ||
		(disable.error instanceof Error && disable.error.message) ||
		(regenerate.error instanceof Error && regenerate.error.message) ||
		(setSecure.error instanceof Error && setSecure.error.message) ||
		null;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-xs leading-4 text-settings-muted">{t("mobile.description")}</p>

			<ConnectMobileGetApp />

			{query.isLoading ? (
				<p className="text-center text-xs text-settings-muted">{t("mobile.checkingStatus")}</p>
			) : query.isError ? (
				<p className="text-center text-xs text-error">
					{query.error instanceof Error ? query.error.message : t("mobile.loadFailed")}
				</p>
			) : status ? (
				<div className="flex flex-col">
					<div className="relative flex items-start justify-between gap-3 py-3">
						<div className="flex min-w-0 flex-col gap-1 pr-2">
							<span className="text-subtitle leading-(--leading-settings-mobile-title) text-settings-label">
								{t("mobile.enable")}
							</span>
							<span className="text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
								{t("mobile.enableHint")}
							</span>
						</div>
						<div className="flex shrink-0 items-center gap-2 pt-0.5">
							{busy && <Loader2 className="size-4 animate-spin text-settings-muted" aria-hidden="true" />}
							<Switch
								checked={enabled}
								onCheckedChange={onToggle}
								disabled={busy}
								aria-label={t("mobile.enable")}
							/>
						</div>
					</div>

					{actionError && <p className="mt-3 text-xs text-error">{actionError}</p>}

					<div
						className={cn(
							"grid transition-[grid-template-rows] duration-300 ease-out",
							enabled ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
						)}
						aria-hidden={!enabled}
					>
						<div className="overflow-hidden">
							<div
								className={cn(
									"mt-4 flex flex-col items-center transition-opacity duration-300 ease-out",
									enabled ? "opacity-100" : "opacity-0",
								)}
							>
								<ConnectMobileSetup
									mode={mode}
									onModeChange={setMode}
									enabled={enabled}
									busy={busy}
									secure={{
										enabled: status.securePairing?.enabled ?? false,
										reason: status.securePairing?.reason ?? "",
									}}
									onSecureChange={(on) => {
										clearActionErrors();
										setSecure.mutate(on);
									}}
								/>

								<div className="mt-6 flex w-(--size-settings-mobile-qr) flex-col items-center">
									{activeHost && !secureBlocked ? (
										<>
											<div className="rounded-md border border-(--color-border-settings-input) bg-white p-2">
												<QRCodeSVG
													value={pairingPayload(activeHost, activePort, status.password, secureActive)}
													data-qr-value={pairingPayload(activeHost, activePort, status.password, secureActive)}
													size={QR_CODE_SIZE}
													className="block size-(--size-settings-mobile-qr-code)"
												/>
											</div>
											<p className="mt-4 text-sm leading-5 text-settings-muted">{t("mobile.scanToPair")}</p>
										</>
									) : (
										<div className="flex size-(--size-settings-mobile-qr-code) items-center justify-center rounded-md border border-(--color-border-settings-input) bg-(--color-bg-settings-input) p-4">
											<p className="text-center text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
												{mode === "tailscale" ? t("mobile.noTailscaleHost") : t("mobile.noPairingHost")}
											</p>
										</div>
									)}
								</div>

								{status.warning && !secureActive && (
									<p className="mt-6 flex w-full max-w-(--size-settings-mobile-warning) items-start gap-2 text-caption leading-(--leading-settings-mobile-warning) text-warning">
										<Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
										<span>{status.warning}</span>
									</p>
								)}

								<div className="mt-6 flex w-full flex-col gap-1">
									<div className="flex items-center gap-6 text-sm leading-5" data-testid="mobile-pairing-address">
										<span className="w-(--size-settings-mobile-label) shrink-0 text-settings-muted">{t("mobile.address")}</span>
										<span className="tracking-settings-mono text-settings-label">
											{activeHost ? `${activeHost}:${activePort}` : "—"}
										</span>
									</div>
									<div className="flex items-center gap-6 text-sm leading-5">
										<span className="w-(--size-settings-mobile-label) shrink-0 text-settings-muted">{t("mobile.password")}</span>
										<div className="flex min-w-0 items-center gap-2">
											<span className="tracking-settings-mono text-settings-label">{status.password}</span>
											<button
												type="button"
												aria-label={copied ? t("mobile.passwordCopied") : t("mobile.copyPassword")}
												tabIndex={enabled ? 0 : -1}
												className="inline-flex size-6 shrink-0 items-center justify-center text-settings-muted transition-colors hover:text-settings-label"
												onClick={() => void copyPassword()}
											>
												{copied ? (
													<Check className="size-4" aria-hidden="true" />
												) : (
													<Copy className="size-4" aria-hidden="true" />
												)}
											</button>
										</div>
									</div>
								</div>

								<Button
									type="button"
									variant="footer"
									className="mt-5 w-(--size-settings-mobile-regen-width) rounded-md"
									onClick={() => {
										clearActionErrors();
										regenerate.mutate();
									}}
									disabled={busy || !enabled}
									tabIndex={enabled ? 0 : -1}
								>
									{regenerate.isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
									{t("mobile.regenerate")}
								</Button>

								{enabled && <MobileDevicesSection />}
							</div>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
