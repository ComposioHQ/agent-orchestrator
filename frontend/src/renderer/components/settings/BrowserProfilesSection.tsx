import { Check, Eraser, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AoBridge } from "../../../preload";
import { aoBridge } from "../../lib/bridge";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

type ProfileBridge = AoBridge["browserProfiles"];

export function BrowserProfilesSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const bridge = (aoBridge as Partial<AoBridge>).browserProfiles as ProfileBridge | undefined;
	const [profiles, setProfiles] = useState<Awaited<ReturnType<ProfileBridge["list"]>>["profiles"]>([]);
	const [loading, setLoading] = useState(Boolean(bridge));
	const [error, setError] = useState("");
	const [name, setName] = useState("");
	const [editing, setEditing] = useState<Record<string, string>>({});

	const refresh = async () => {
		if (!bridge) return;
		setLoading(true);
		try {
			const result = await bridge.list();
			setProfiles(result.profiles);
			setError(result.error?.message ?? "");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("settings.browserProfiles.loadFailed"));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void refresh();
		// The bridge is fixed for the process lifetime; intentionally do not rerun
		// the load for every i18n/theme render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bridge]);

	const create = async () => {
		if (!bridge || !name.trim()) return;
		try {
			const created = await bridge.create(name);
			setProfiles((current) => [...current, created]);
			setName("");
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("settings.browserProfiles.saveFailed"));
		}
	};

	const rename = async (id: string) => {
		if (!bridge) return;
		const nextName = editing[id]?.trim();
		if (!nextName) return;
		try {
			const updated = await bridge.rename({ id, name: nextName });
			setProfiles((current) => current.map((profile) => (profile.id === id ? updated : profile)));
			setEditing((current) => {
				const next = { ...current };
				delete next[id];
				return next;
			});
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("settings.browserProfiles.saveFailed"));
		}
	};

	const clear = async (id: string) => {
		if (!bridge) return;
		try {
			await bridge.clear(id);
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("settings.browserProfiles.clearFailed"));
		}
	};

	const remove = async (id: string) => {
		if (!bridge) return;
		try {
			await bridge.delete(id);
			setProfiles((current) => current.filter((profile) => profile.id !== id));
			setError("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("settings.browserProfiles.deleteFailed"));
		}
	};

	return (
		<SettingsSection
			title={t("settings.browserProfiles")}
			sectionId="browserProfiles"
			titleHidden={titleHidden}
			grouped
		>
			<p className="px-3 text-xs leading-relaxed text-muted-foreground">
				{t("settings.browserProfiles.description")}
			</p>
			<SettingsRow label={t("settings.browserProfiles.create")}>
				<form
					className="flex min-w-0 max-w-full items-center gap-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						void create();
					}}
				>
					<Input
						aria-label={t("settings.browserProfiles.name")}
						className="h-control-md w-36"
						disabled={!bridge || loading}
						maxLength={64}
						onChange={(event) => setName(event.target.value)}
						placeholder={t("settings.browserProfiles.namePlaceholder")}
						value={name}
					/>
					<Button aria-label={t("settings.browserProfiles.create")} disabled={!name.trim() || !bridge || loading} size="icon-sm" type="submit" variant="outline">
						<Plus aria-hidden="true" className="size-icon-base" />
					</Button>
				</form>
			</SettingsRow>
			{loading ? (
				<p className="px-3 py-3 text-xs text-muted-foreground">{t("settings.browserProfiles.loading")}</p>
			) : profiles.length === 0 ? (
				<p className="px-3 py-3 text-xs text-muted-foreground">{t("settings.browserProfiles.empty")}</p>
			) : (
				profiles.map((profile) => (
					<SettingsRow key={profile.id} label={profile.name}>
						<div className="flex min-w-0 items-center gap-1.5">
							<Input
								aria-label={t("settings.browserProfiles.renameInput", { profile: profile.name })}
								className={cn("h-control-md w-36", !editing[profile.id] && "hidden")}
								maxLength={64}
								onChange={(event) => setEditing((current) => ({ ...current, [profile.id]: event.target.value }))}
								value={editing[profile.id] ?? profile.name}
							/>
							<Button
								aria-label={t("settings.browserProfiles.rename", { profile: profile.name })}
								onClick={() => {
									if (editing[profile.id] === undefined) setEditing((current) => ({ ...current, [profile.id]: profile.name }));
									else void rename(profile.id);
								}}
								size="icon-sm"
								type="button"
								variant="ghost"
							>
								{editing[profile.id] === undefined ? <Pencil aria-hidden="true" className="size-icon-base" /> : <Check aria-hidden="true" className="size-icon-base" />}
							</Button>
							<Button aria-label={t("settings.browserProfiles.clear", { profile: profile.name })} onClick={() => void clear(profile.id)} size="icon-sm" type="button" variant="ghost">
								<Eraser aria-hidden="true" className="size-icon-base" />
							</Button>
							<Button aria-label={t("settings.browserProfiles.delete", { profile: profile.name })} onClick={() => void remove(profile.id)} size="icon-sm" type="button" variant="ghost">
								<Trash2 aria-hidden="true" className="size-icon-base" />
							</Button>
						</div>
					</SettingsRow>
				))
			)}
			{error ? <p className="px-3 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
		</SettingsSection>
	);
}
