import { Check, Globe2, LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserImportResult, BrowserImportScan, BrowserImportSource } from "../../../main/browser-import-engine";
import type { BrowserImportStatus } from "../../../main/browser-import-ipc";
import { aoBridge } from "../../lib/bridge";
import { Button } from "../ui/button";
import { SettingsSection } from "./SettingsSection";

type BrowserImportFlowState = "idle" | "scanning" | "ready" | "importing" | "success" | "error" | "dismissed";

function errorMessage(error: unknown, t: TFunction): string {
	const message = error instanceof Error ? error.message : "";
	if (/no longer available|could not be read safely/i.test(message)) return t("settings.browser.sourceUnavailable");
	if (/already active|close its workers/i.test(message)) return t("settings.browser.destinationActive");
	return t("settings.browser.failed");
}

function summaryFromResult(result: BrowserImportResult): BrowserImportStatus["summary"] {
	return {
		sourceBrowser: result.sourceBrowser,
		sourceProfile: result.sourceProfile,
		importedBookmarks: result.importedBookmarks,
		skippedBookmarks: result.skippedBookmarks,
		importedAt: new Date().toISOString(),
	};
}

export function BrowserImportSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const [flowState, setFlowState] = useState<BrowserImportFlowState>("idle");
	const [sources, setSources] = useState<BrowserImportSource[]>([]);
	const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
	const [activatePersistent, setActivatePersistent] = useState(false);
	const [status, setStatus] = useState<BrowserImportStatus>({
		persistence: "ephemeral",
		destinationActive: false,
		summary: null,
	});
	const [result, setResult] = useState<BrowserImportResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const applyStatus = (next: BrowserImportStatus) => {
		setStatus(next);
		if (next.persistence === "persistent") setActivatePersistent(true);
	};

	useEffect(() => {
		let mounted = true;
		void aoBridge.browserImport.getStatus().then((next) => {
			if (mounted) applyStatus(next);
		}).catch((reason: unknown) => {
			if (mounted) {
				setError(errorMessage(reason, t));
				setFlowState("error");
			}
		});
		return () => {
			mounted = false;
		};
	}, [t]);

	const scan = async () => {
		setFlowState("scanning");
		setError(null);
		setResult(null);
		setSelectedSourceId(null);
		try {
			const next: BrowserImportScan = await aoBridge.browserImport.detect();
			setSources(next.sources);
			setSelectedSourceId(next.sources[0]?.id ?? null);
			setActivatePersistent(false);
			setFlowState("ready");
		} catch (reason) {
			setError(errorMessage(reason, t));
			setFlowState("error");
		}
	};

	const importSelected = async () => {
		if (!selectedSourceId || !activatePersistent) return;
		setFlowState("importing");
		setError(null);
		try {
			const next = await aoBridge.browserImport.import({ sourceId: selectedSourceId, activate: true });
			setResult(next);
			applyStatus({
				persistence: next.persistence,
				destinationActive: false,
				summary: summaryFromResult(next),
			});
			setFlowState("success");
		} catch (reason) {
			setError(errorMessage(reason, t));
			setFlowState("error");
		}
	};

	const useTemporary = async () => {
		setError(null);
		try {
			applyStatus(await aoBridge.browserImport.useEphemeral());
			setFlowState("idle");
		} catch (reason) {
			setError(t("settings.browser.switchFailed"));
			setFlowState("error");
		}
	};

	const dismiss = () => {
		setSources([]);
		setSelectedSourceId(null);
		setError(null);
		setFlowState("dismissed");
	};

	const scanButtonLabel = flowState === "scanning" ? t("settings.browser.scanning") : t("settings.browser.scan");
	const busy = flowState === "scanning" || flowState === "importing";

	return (
		<SettingsSection title={t("settings.browser")} titleHidden={titleHidden}>
			<div className="flex flex-col gap-3 rounded-md border border-border bg-background p-4">
				<div className="flex items-start gap-3">
					<Globe2 className="mt-0.5 size-5 shrink-0 text-settings-muted" aria-hidden="true" />
					<div className="min-w-0 space-y-1">
						<p className="text-sm font-medium text-foreground">{t("settings.browser.description")}</p>
						<p className="text-xs leading-relaxed text-settings-muted">{t("settings.browser.disclosure")}</p>
						<p className="text-xs leading-relaxed text-settings-muted">{t("settings.browser.persistentDisclosure")}</p>
					</div>
				</div>

				{status.persistence === "persistent" && (
					<div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-xs text-success" role="status">
						<Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						<span>{t("settings.browser.active")}</span>
					</div>
				)}

				{status.summary && (
					<p className="text-xs text-settings-muted">
						{t("settings.browser.success", { count: status.summary.importedBookmarks })}
					</p>
				)}

				{flowState === "idle" && (
					<div className="flex flex-wrap items-center gap-2">
						<Button type="button" variant="footer" onClick={() => void scan()} disabled={busy}>
							{scanButtonLabel}
						</Button>
						{status.persistence === "persistent" && (
							<Button type="button" variant="ghost" onClick={() => void useTemporary()}>
								{t("settings.browser.useTemporary")}
							</Button>
						)}
					</div>
				)}

				{flowState === "dismissed" && (
					<div className="flex flex-wrap items-center gap-2">
						<p className="text-xs text-settings-muted" role="status">{t("settings.browser.dismissed")}</p>
						<Button type="button" variant="footer" onClick={() => void scan()}>
							{t("settings.browser.scan")}
						</Button>
					</div>
				)}

				{flowState === "scanning" && (
					<p className="flex items-center gap-2 text-xs text-settings-muted" role="status">
						<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
						{t("settings.browser.scanning")}
					</p>
				)}

				{(flowState === "ready" || flowState === "importing") && (
					<div className="flex flex-col gap-3">
						{sources.length === 0 ? (
							<p className="text-xs text-settings-muted" role="status">{t("settings.browser.noSources")}</p>
						) : (
							<fieldset className="flex flex-col gap-2">
								<legend className="text-xs font-medium text-foreground">{t("settings.browser.sources")}</legend>
								{sources.map((source) => (
									<label key={source.id} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-muted/50">
										<input
											type="radio"
											name="ao-browser-import-source"
											value={source.id}
											checked={selectedSourceId === source.id}
											onChange={() => setSelectedSourceId(source.id)}
											aria-label={t("settings.browser.profile", {
												browser: source.label,
												profile: source.profileName,
												count: source.bookmarkCount,
											})}
										/>
										<span>
											{t("settings.browser.profile", {
												browser: source.label,
												profile: source.profileName,
												count: source.bookmarkCount,
											})}
										</span>
									</label>
								))}
							</fieldset>
						)}

						<div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3">
							<ShieldCheck className="mt-0.5 size-4 shrink-0 text-settings-muted" aria-hidden="true" />
							<label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-settings-muted">
								<input
									type="checkbox"
									checked={activatePersistent}
									onChange={(event) => setActivatePersistent(event.target.checked)}
									aria-label={t("settings.browser.activate")}
								/>
								<span>{t("settings.browser.activate")}</span>
							</label>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="button"
								variant="footer-primary"
								onClick={() => void importSelected()}
								disabled={!selectedSourceId || !activatePersistent || busy}
							>
								{flowState === "importing" ? t("settings.browser.importing") : t("settings.browser.importAndUse")}
							</Button>
							<Button type="button" variant="ghost" onClick={dismiss} disabled={busy}>
								{t("settings.browser.dismiss")}
							</Button>
						</div>
					</div>
				)}

				{flowState === "success" && result && (
					<div className="flex flex-col gap-2" role="status" aria-live="polite">
						<p className="flex items-center gap-2 text-xs text-success">
							<Check className="size-4" aria-hidden="true" />
							{t("settings.browser.success", { count: result.importedBookmarks })}
						</p>
						{result.skippedBookmarks > 0 && (
							<p className="text-xs text-settings-muted">
								{t("settings.browser.successSkipped", { count: result.importedBookmarks, skipped: result.skippedBookmarks })}
							</p>
						)}
						<div className="flex flex-wrap items-center gap-2">
							<Button type="button" variant="footer" onClick={() => void scan()}>
								{t("settings.browser.scan")}
							</Button>
							<Button type="button" variant="ghost" onClick={dismiss}>
								{t("settings.browser.dismiss")}
							</Button>
						</div>
					</div>
				)}

				{flowState === "error" && error && (
					<div className="flex flex-wrap items-center gap-2" role="alert">
						<TriangleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
						<span className="text-xs text-error">{error}</span>
						<Button type="button" variant="footer" onClick={() => void scan()}>
							{t("settings.browser.retry")}
						</Button>
						<Button type="button" variant="ghost" onClick={dismiss}>
							{t("settings.browser.dismiss")}
						</Button>
					</div>
				)}
			</div>
		</SettingsSection>
	);
}
