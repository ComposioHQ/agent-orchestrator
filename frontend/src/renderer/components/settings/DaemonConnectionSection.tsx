import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RadioGroup } from "radix-ui";
import { Loader2 } from "lucide-react";
import { aoBridge } from "../../lib/bridge";
import { useShellMaybe } from "../../lib/shell-context";
import { validateRemoteUrl, type RemoteDaemonConfigView } from "../../../shared/remote-url";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

/**
 * Local vs remote (Tailscale HTTPS) daemon connection. The renderer never sees
 * the saved password — `hasPassword` only — so the field stays write-only and a
 * blank submit keeps the stored credential. Connection state comes from the
 * shell-owned daemon status (the status effect must run exactly once), not from
 * a private useDaemonStatus here.
 */
export function DaemonConnectionSection({ titleHidden }: { titleHidden?: boolean } = {}) {
	const { t } = useTranslation();
	const status = useShellMaybe()?.daemonStatus;
	const [config, setConfig] = useState<RemoteDaemonConfigView | null>(null);
	const [mode, setMode] = useState<"local" | "remote">("local");
	const [url, setUrl] = useState("");
	const [password, setPassword] = useState("");
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [forgetConfirmOpen, setForgetConfirmOpen] = useState(false);

	useEffect(() => {
		let active = true;
		void aoBridge.remote
			.getConfig()
			.then((next) => {
				if (!active) return;
				setConfig(next);
				setMode(next.mode);
				setUrl(next.url ?? "");
			})
			.catch(() => {
				// IPC unavailable (browser preview): leave the local defaults.
			});
		return () => {
			active = false;
		};
	}, []);

	const connected = status?.connection === "remote" && status.state === "ready";
	const displayUrl = config?.url ?? url;

	const testAndConnect = async () => {
		setError(null);
		const validation = validateRemoteUrl(url);
		if (!validation.ok) {
			setError(validation.reason);
			return;
		}
		setTesting(true);
		try {
			const result = await aoBridge.remote.testAndConnect(validation.url, password);
			if (!result.ok) {
				setError(result.message);
				return;
			}
			setPassword("");
			const next = await aoBridge.remote.getConfig().catch(() => null);
			if (next) setConfig(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("settings.daemonConnection.connectFailed"));
		} finally {
			setTesting(false);
		}
	};

	return (
		<>
			<SettingsSection title={t("settings.daemonConnection")} sectionId="daemon-connection" titleHidden={titleHidden} grouped>
				<SettingsRow label={t("settings.daemonConnection.mode")}>
					<RadioGroup.Root
						value={mode}
						onValueChange={(value) => setMode(value as "local" | "remote")}
						aria-label={t("settings.daemonConnection.mode")}
						className="settings-segment rounded-md"
					>
						<RadioGroup.Item value="local" className="settings-segment-item rounded-md">
							{t("settings.daemonConnection.modeLocal")}
						</RadioGroup.Item>
						<RadioGroup.Item value="remote" className="settings-segment-item rounded-md">
							{t("settings.daemonConnection.modeRemote")}
						</RadioGroup.Item>
					</RadioGroup.Root>
				</SettingsRow>

				{connected && (
					<div className="settings-row-bar h-auto min-h-(--size-settings-row) flex-wrap gap-2">
						<span className="min-w-0 flex-1 text-sm leading-5 text-settings-label">
							{t("settings.daemonConnection.connectedTo", { url: displayUrl })}
						</span>
						<Button type="button" variant="outline" size="sm" onClick={() => void aoBridge.remote.disconnect()}>
							{t("settings.daemonConnection.disconnect")}
						</Button>
						<Button type="button" variant="outline" size="sm" onClick={() => setForgetConfirmOpen(true)}>
							{t("settings.daemonConnection.forget")}
						</Button>
					</div>
				)}

				{mode === "remote" && (
					<div className="flex w-full flex-col gap-2 px-(--size-settings-row-padding) pb-(--size-settings-row-padding)">
						<label className="flex flex-col gap-1">
							<span className="text-xs text-settings-muted">{t("settings.daemonConnection.url")}</span>
							<Input
								aria-label={t("settings.daemonConnection.url")}
								value={url}
								onChange={(event) => {
									setUrl(event.target.value);
									setError(null);
								}}
								placeholder={t("settings.daemonConnection.urlPlaceholder")}
								autoComplete="off"
								spellCheck={false}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-settings-muted">{t("settings.daemonConnection.password")}</span>
							<Input
								aria-label={t("settings.daemonConnection.password")}
								type="password"
								value={password}
								onChange={(event) => {
									setPassword(event.target.value);
									setError(null);
								}}
								autoComplete="new-password"
							/>
						</label>
						<p className="text-xs text-settings-muted">{t("settings.daemonConnection.credentialsHint")}</p>
						{config?.hasPassword && (
							<p className="text-xs text-settings-muted">{t("settings.daemonConnection.savedPassword")}</p>
						)}
						{config?.hasPassword && !config.passwordPersistent && (
							<p className="text-xs text-warning">{t("settings.daemonConnection.passwordNotPersistent")}</p>
						)}
						{error && (
							<p role="alert" className="text-caption leading-4 text-error">
								{error}
							</p>
						)}
						<div>
							<Button type="button" variant="footer-primary" disabled={testing} onClick={() => void testAndConnect()}>
								{testing && <Loader2 className="size-icon-sm animate-spin" aria-hidden="true" />}
								{testing ? t("settings.daemonConnection.testing") : t("settings.daemonConnection.testConnect")}
							</Button>
						</div>
					</div>
				)}
			</SettingsSection>
			<ConfirmDialog
				open={forgetConfirmOpen}
				title={t("settings.daemonConnection.forgetTitle")}
				description={t("settings.daemonConnection.forgetBody")}
				confirmLabel={t("settings.daemonConnection.forget")}
				destructive
				onConfirm={() => {
					setForgetConfirmOpen(false);
					void aoBridge.remote.forget().then(() => {
						setPassword("");
						return aoBridge.remote.getConfig().catch(() => null);
					}).then((next) => {
						if (next) {
							setConfig(next);
							setMode(next.mode);
							setUrl(next.url ?? "");
						}
					});
				}}
				onOpenChange={setForgetConfirmOpen}
			/>
		</>
	);
}
