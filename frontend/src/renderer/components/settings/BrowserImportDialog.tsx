import { CheckCircle2, ChevronLeft, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AoBridge } from "../../../preload";
import type {
	BrowserImportProgress,
	BrowserImportResult,
	BrowserImportSource,
	BrowserImportWarning,
} from "../../../shared/browser-profile-import";
import { aoBridge } from "../../lib/bridge";
import { appI18n, type MessageKey } from "../../i18n";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogFooterClass,
	settingsDialogHeaderClass,
} from "../ui/dialog";
import { Input } from "../ui/input";

type ImportBridge = AoBridge["browserProfiles"];
type Step = "source" | "profiles" | "options" | "running" | "result";

export function BrowserImportDialog({
	open,
	onOpenChange,
	onImported,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImported: () => void;
}) {
	const { t } = useTranslation();
	const bridge = (aoBridge as Partial<AoBridge>).browserProfiles as ImportBridge | undefined;
	const [step, setStep] = useState<Step>("source");
	const [sources, setSources] = useState<BrowserImportSource[]>([]);
	const [sourceId, setSourceId] = useState("");
	const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
	const [includeCookies, setIncludeCookies] = useState(true);
	const [includeHistory, setIncludeHistory] = useState(true);
	const [destinationMode, setDestinationMode] = useState<"separate" | "merge">("separate");
	const [destinationNames, setDestinationNames] = useState<Record<string, string>>({});
	const [mergeName, setMergeName] = useState("");
	const [domains, setDomains] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [progress, setProgress] = useState<BrowserImportProgress | null>(null);
	const [result, setResult] = useState<BrowserImportResult | null>(null);

	const source = sources.find((candidate) => candidate.id === sourceId);
	const selectedProfiles = source?.profiles.filter((profile) => selectedProfileIds.includes(profile.id)) ?? [];
	const canClose = step !== "running";
	const requestId = progress?.requestId;

	useEffect(() => {
		if (!open) return;
		setStep("source");
		setSources([]);
		setSourceId("");
		setSelectedProfileIds([]);
		setIncludeCookies(true);
		setIncludeHistory(true);
		setDestinationMode("separate");
		setDestinationNames({});
		setMergeName("");
		setDomains("");
		setError("");
		setProgress(null);
		setResult(null);
		if (!bridge) {
			setError(t("settings.browserImport.unavailable"));
			return;
		}
		setLoading(true);
		void bridge.discoverImportSources().then(
			(discovery) => {
				setSources(discovery.sources);
				const first = discovery.sources[0];
				if (first) setSourceId(first.id);
			},
			(reason) => setError(reason instanceof Error ? reason.message : t("settings.browserImport.discoveryFailed")),
		).finally(() => setLoading(false));
	}, [bridge, open, t]);

	useEffect(() => {
		if (!bridge || !open) return;
		return bridge.onImportProgress((next) => {
			if (requestId && next.requestId !== requestId) return;
			setProgress(next);
		});
	}, [bridge, open, requestId]);

	const progressPercent = useMemo(() => {
		if (!progress || progress.total < 1) return 8;
		return Math.max(8, Math.min(100, Math.round((progress.completed / progress.total) * 100)));
	}, [progress]);

	const chooseSource = () => {
		if (!source) return;
		const defaults = source.profiles.filter((profile) => profile.default);
		const selected = defaults.length > 0 ? defaults.map((profile) => profile.id) : source.profiles[0] ? [source.profiles[0].id] : [];
		setSelectedProfileIds(selected);
		setStep("profiles");
		setError("");
	};

	const chooseProfiles = () => {
		if (!source || selectedProfiles.length === 0) return;
		const names = Object.fromEntries(
			selectedProfiles.map((profile) => [profile.id, suggestedName(source.name, profile.name)]),
		);
		setDestinationNames(names);
		setMergeName(source.name);
		setDestinationMode(selectedProfiles.length > 1 ? "separate" : "merge");
		setStep("options");
		setError("");
	};

	const goBack = () => {
		setError("");
		setStep(step === "profiles" ? "source" : "profiles");
	};

	const startImport = async () => {
		if (!bridge || !source || selectedProfiles.length === 0 || (!includeCookies && !includeHistory)) return;
		const id = crypto.randomUUID();
		setProgress({ requestId: id, phase: "preparing", completed: 0, total: selectedProfiles.length });
		setStep("running");
		setError("");
		try {
			const imported = await bridge.import({
				requestId: id,
				sourceId: source.id,
				profileIds: selectedProfiles.map((profile) => profile.id),
				includeCookies,
				includeHistory,
				domains: domains.split(/[\s,;]+/u).filter(Boolean),
				destination:
					destinationMode === "merge"
						? { mode: "merge", name: mergeName.trim() }
						: {
								mode: "separate",
								names: Object.fromEntries(
									selectedProfiles.map((profile) => [profile.id, destinationNames[profile.id]?.trim() ?? ""]),
								),
							},
			});
			setResult(imported);
			setStep("result");
			onImported();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("settings.browserImport.failed"));
			setStep("options");
		}
	};

	const namesValid =
		destinationMode === "merge"
			? mergeName.trim().length > 0
			: selectedProfiles.every((profile) => (destinationNames[profile.id]?.trim().length ?? 0) > 0);

	return (
		<Dialog open={open} onOpenChange={(next) => canClose && onOpenChange(next)}>
			<DialogContent className={`${settingsDialogContentClass} min-h-[30rem]`} showCloseButton={false}>
				<DialogClose asChild>
					<button
						aria-label={t("common.close")}
						className="settings-dialog-close-button settings-close-button"
						disabled={!canClose}
						type="button"
					>
						<X aria-hidden="true" className="size-5" />
					</button>
				</DialogClose>
				<div className={settingsDialogHeaderClass}>
					<p className="text-caption font-semibold uppercase tracking-wide text-accent">
						{stepLabel(step)}
					</p>
					<DialogTitle className="settings-dialog-title">{t("settings.browserImport.title")}</DialogTitle>
					<DialogDescription>{t("settings.browserImport.description")}</DialogDescription>
				</div>

				<div className={settingsDialogBodyClass}>
					{step === "source" ? (
						<SourceStep
							error={error}
							loading={loading}
							onSelect={setSourceId}
							selectedId={sourceId}
							sources={sources}
						/>
					) : null}
					{step === "profiles" && source ? (
						<ProfilesStep
							onChange={setSelectedProfileIds}
							selected={selectedProfileIds}
							source={source}
						/>
					) : null}
					{step === "options" && source ? (
						<OptionsStep
							destinationMode={destinationMode}
							destinationNames={destinationNames}
							domains={domains}
							error={error}
							includeCookies={includeCookies}
							includeHistory={includeHistory}
							mergeName={mergeName}
							profiles={selectedProfiles}
							setDestinationMode={setDestinationMode}
							setDestinationNames={setDestinationNames}
							setDomains={setDomains}
							setIncludeCookies={setIncludeCookies}
							setIncludeHistory={setIncludeHistory}
							setMergeName={setMergeName}
							source={source}
						/>
					) : null}
					{step === "running" ? (
						<div className="flex flex-1 flex-col items-center justify-center gap-5 py-12 text-center">
							<LoaderCircle aria-hidden="true" className="size-8 animate-spin text-accent" />
							<div>
								<p className="font-semibold">{t(`settings.browserImport.progress.${progress?.phase ?? "preparing"}`)}</p>
								<p className="mt-1 text-xs text-muted-foreground">{t("settings.browserImport.progress.keepOpen")}</p>
							</div>
							<div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted">
								<div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progressPercent}%` }} />
							</div>
						</div>
					) : null}
					{step === "result" && result ? <ResultStep result={result} /> : null}
				</div>

				<div className={settingsDialogFooterClass}>
					{step === "profiles" || step === "options" ? (
						<Button onClick={goBack} type="button" variant="footer">
							<ChevronLeft aria-hidden="true" className="size-4" />
							{t("settings.browserImport.back")}
						</Button>
					) : null}
					<div className="flex-1" />
					{step !== "running" ? (
						<DialogClose asChild>
							<Button type="button" variant="footer">
								{step === "result" ? t("settings.browserImport.done") : t("confirm.cancel")}
							</Button>
						</DialogClose>
					) : null}
					{step === "source" ? (
						<Button disabled={!source || loading} onClick={chooseSource} type="button" variant="footer-primary">
							{t("settings.browserImport.next")}
						</Button>
					) : null}
					{step === "profiles" ? (
						<Button disabled={selectedProfiles.length === 0} onClick={chooseProfiles} type="button" variant="footer-primary">
							{t("settings.browserImport.next")}
						</Button>
					) : null}
					{step === "options" ? (
						<Button disabled={(!includeCookies && !includeHistory) || !namesValid} onClick={() => void startImport()} type="button" variant="footer-primary">
							{t("settings.browserImport.start")}
						</Button>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function SourceStep({
	sources,
	selectedId,
	loading,
	error,
	onSelect,
}: {
	sources: BrowserImportSource[];
	selectedId: string;
	loading: boolean;
	error: string;
	onSelect: (id: string) => void;
}) {
	const { t } = useTranslation();
	if (loading) return <p className="text-sm text-muted-foreground">{t("settings.browserImport.detecting")}</p>;
	if (error) return <p className="text-sm text-destructive" role="alert">{error}</p>;
	if (sources.length === 0) return <p className="text-sm text-muted-foreground">{t("settings.browserImport.noneFound")}</p>;
	return (
		<div className="grid gap-2">
			{sources.map((source) => {
				const selected = selectedId === source.id;
				return (
				<button
					aria-pressed={selected}
					className={`flex items-center gap-3 rounded-lg border-2 p-3 text-left text-foreground transition-[background-color,border-color,box-shadow] ${selected ? "border-accent bg-settings-menu-selected shadow-sm ring-1 ring-accent/50" : "border-border hover:bg-interactive-hover"}`}
					data-selected={selected ? "true" : "false"}
					key={source.id}
					onClick={() => onSelect(source.id)}
					type="button"
				>
					<span aria-hidden="true" className={`h-8 w-1 shrink-0 rounded-full ${selected ? "bg-accent" : "bg-transparent"}`} />
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-semibold">{source.name}</span>
						<span className="block text-xs text-muted-foreground">{t("settings.browserImport.profileCount", { count: source.profiles.length })}</span>
					</span>
					{selected ? (
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-background text-accent shadow-sm">
							<CheckCircle2 aria-hidden="true" className="size-4" />
						</span>
					) : null}
				</button>
				);
			})}
		</div>
	);
}

function ProfilesStep({ source, selected, onChange }: { source: BrowserImportSource; selected: string[]; onChange: (ids: string[]) => void }) {
	const { t } = useTranslation();
	return (
		<div className="space-y-3">
			<p className="text-sm text-muted-foreground">{t("settings.browserImport.selectProfiles", { browser: source.name })}</p>
			<div className="grid gap-2">
				{source.profiles.map((profile) => (
					<label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 hover:bg-interactive-hover" key={profile.id}>
						<input
							checked={selected.includes(profile.id)}
							className="size-4 accent-accent"
							onChange={(event) => onChange(event.target.checked ? [...selected, profile.id] : selected.filter((id) => id !== profile.id))}
							type="checkbox"
						/>
						<span className="text-sm font-medium">{profile.name}</span>
						{profile.default ? <span className="text-xs text-muted-foreground">{t("settings.browserImport.defaultProfile")}</span> : null}
					</label>
				))}
			</div>
		</div>
	);
}

function OptionsStep({
	source,
	profiles,
	includeCookies,
	includeHistory,
	destinationMode,
	destinationNames,
	mergeName,
	domains,
	error,
	setIncludeCookies,
	setIncludeHistory,
	setDestinationMode,
	setDestinationNames,
	setMergeName,
	setDomains,
}: {
	source: BrowserImportSource;
	profiles: BrowserImportSource["profiles"];
	includeCookies: boolean;
	includeHistory: boolean;
	destinationMode: "separate" | "merge";
	destinationNames: Record<string, string>;
	mergeName: string;
	domains: string;
	error: string;
	setIncludeCookies: (value: boolean) => void;
	setIncludeHistory: (value: boolean) => void;
	setDestinationMode: (value: "separate" | "merge") => void;
	setDestinationNames: React.Dispatch<React.SetStateAction<Record<string, string>>>;
	setMergeName: (value: string) => void;
	setDomains: (value: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="space-y-5">
			<section className="space-y-2">
				<h3 className="text-sm font-semibold">{t("settings.browserImport.dataTitle")}</h3>
				<label className="flex items-start gap-3 rounded-lg border border-border p-3">
					<input checked={includeCookies} className="mt-0.5 size-4 accent-accent" onChange={(event) => setIncludeCookies(event.target.checked)} type="checkbox" />
					<span>
						<span className="block text-sm font-medium">{t("settings.browserImport.cookies")}</span>
						<span className="block text-xs text-muted-foreground">{t("settings.browserImport.cookiesDescription")}</span>
					</span>
				</label>
				{source.cookieSupport !== "supported" ? (
					<p className="flex items-start gap-2 text-xs text-warning">
						<TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
						{t(capabilityKey(source.cookieSupportReason))}
					</p>
				) : null}
				<label className="flex items-start gap-3 rounded-lg border border-border p-3">
					<input checked={includeHistory} className="mt-0.5 size-4 accent-accent" onChange={(event) => setIncludeHistory(event.target.checked)} type="checkbox" />
					<span>
						<span className="block text-sm font-medium">{t("settings.browserImport.history")}</span>
						<span className="block text-xs text-muted-foreground">{t("settings.browserImport.historyDescription")}</span>
					</span>
				</label>
			</section>

			<section className="space-y-2">
				<h3 className="text-sm font-semibold">{t("settings.browserImport.destinationTitle")}</h3>
				{profiles.length > 1 ? (
					<div className="flex flex-wrap gap-4 text-sm">
						<label className="flex items-center gap-2"><input checked={destinationMode === "separate"} onChange={() => setDestinationMode("separate")} type="radio" />{t("settings.browserImport.keepSeparate")}</label>
						<label className="flex items-center gap-2"><input checked={destinationMode === "merge"} onChange={() => setDestinationMode("merge")} type="radio" />{t("settings.browserImport.merge")}</label>
					</div>
				) : null}
				{destinationMode === "merge" ? (
					<Input aria-label={t("settings.browserImport.destinationName")} maxLength={64} onChange={(event) => setMergeName(event.target.value)} value={mergeName} />
				) : (
					<div className="grid gap-2">
						{profiles.map((profile) => (
							<label className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-center gap-3 text-xs" key={profile.id}>
								<span className="truncate text-muted-foreground">{profile.name}</span>
								<Input maxLength={64} onChange={(event) => setDestinationNames((current) => ({ ...current, [profile.id]: event.target.value }))} value={destinationNames[profile.id] ?? ""} />
							</label>
						))}
					</div>
				)}
			</section>

			<section className="space-y-2">
				<h3 className="text-sm font-semibold">{t("settings.browserImport.domainsTitle")}</h3>
				<Input onChange={(event) => setDomains(event.target.value)} placeholder={t("settings.browserImport.domainsPlaceholder")} value={domains} />
				<p className="text-xs text-muted-foreground">{t("settings.browserImport.domainsHelp")}</p>
			</section>
			{error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
		</div>
	);
}

function ResultStep({ result }: { result: BrowserImportResult }) {
	const { t } = useTranslation();
	return (
		<div className="space-y-4">
			<div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 p-3">
				<CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 text-success" />
				<div><p className="text-sm font-semibold">{t("settings.browserImport.complete")}</p><p className="text-xs text-muted-foreground">{t("settings.browserImport.completeDescription", { browser: result.sourceName })}</p></div>
			</div>
			{result.entries.map((entry) => (
				<div className="rounded-lg border border-border p-3" key={entry.destinationProfile.id}>
					<p className="text-sm font-semibold">{entry.destinationProfile.name}</p>
					<p className="mt-1 text-xs text-muted-foreground">{t("settings.browserImport.resultCounts", { cookies: entry.importedCookies, history: entry.importedHistoryEntries })}</p>
					{entry.skippedCookies > 0 ? <p className="mt-1 text-xs text-warning">{t("settings.browserImport.skippedCookies", { count: entry.skippedCookies })}</p> : null}
					{entry.warnings.map((warning) => <p className="mt-1 text-xs text-warning" key={warning.code}>{warningText(warning)}</p>)}
				</div>
			))}
			<p className="text-xs text-muted-foreground">{t("settings.browserImport.useProfile")}</p>
		</div>
	);
}

function warningText(warning: BrowserImportWarning): string {
	return appI18n.t(warningKey(warning.code), { count: warning.count ?? 0 });
}

function suggestedName(browser: string, profile: string): string {
	const name = profile.toLowerCase() === "default" ? browser : `${browser} — ${profile}`;
	return name.slice(0, 64);
}

function stepLabel(step: Step): string {
	if (step === "source") return appI18n.t("settings.browserImport.step", { current: 1, total: 3 });
	if (step === "profiles") return appI18n.t("settings.browserImport.step", { current: 2, total: 3 });
	if (step === "options") return appI18n.t("settings.browserImport.step", { current: 3, total: 3 });
	return appI18n.t(step === "running" ? "settings.browserImport.importing" : "settings.browserImport.finished");
}

function capabilityKey(reason: BrowserImportSource["cookieSupportReason"]): MessageKey {
	if (reason === "chromium-encryption-partial") return "settings.browserImport.capability.chromium-encryption-partial";
	if (reason === "chromium-encryption-unsupported") return "settings.browserImport.capability.chromium-encryption-unsupported";
	return "settings.browserImport.cookiesDescription";
}

function warningKey(code: BrowserImportWarning["code"]): MessageKey {
	switch (code) {
		case "cookie-database-missing": return "settings.browserImport.warning.cookie-database-missing";
		case "history-database-missing": return "settings.browserImport.warning.history-database-missing";
		case "encrypted-cookies-skipped": return "settings.browserImport.warning.encrypted-cookies-skipped";
		case "expired-cookies-skipped": return "settings.browserImport.warning.expired-cookies-skipped";
		case "invalid-cookies-skipped": return "settings.browserImport.warning.invalid-cookies-skipped";
		case "cookie-write-failed": return "settings.browserImport.warning.cookie-write-failed";
	}
}
