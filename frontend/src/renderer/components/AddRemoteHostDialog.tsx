import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { remotesBridge, type RemoteHealth, type RemoteHostView } from "../hooks/useRemoteHosts";
import { reportHostConnect } from "../lib/host-telemetry";
import type { MessageKey } from "../i18n";
import { Button } from "./ui/button";
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
} from "./ui/dialog";

// Mirrors the CLI's hasUserinfo (backend/internal/cli/remote.go:116) so both
// surfaces refuse the same addresses with the same words.
function hasUserinfo(raw: string): boolean {
	let authority = raw;
	const scheme = authority.indexOf("://");
	if (scheme >= 0) authority = authority.slice(scheme + 3);
	const path = authority.search(/[/?#]/);
	if (path >= 0) authority = authority.slice(0, path);
	return authority.includes("@");
}

/**
 * Turns what people actually type — "192.168.1.250:3011", "workbox",
 * "[fe80::1]:3011" — into the URL that gets saved, or null when the string
 * cannot address a host at all.
 *
 * The scheme must be added before parsing, not after a failed parse: new URL()
 * reads "workbox:3011" as scheme "workbox", so a bare host:port never fails in
 * a way that could be detected afterwards. Getting this wrong is what made a
 * typo surface as "could not reach that host" — fetch() threw on the unparseable
 * address, probeRemote caught it, and the user went to debug their network.
 */
function normalizeHostUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	// Only "://" marks a scheme here; a lone colon is a port.
	const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
	if (schemed && !/^https?:\/\//i.test(trimmed)) return null;
	let parsed: URL;
	try {
		parsed = new URL(schemed ? trimmed : `http://${trimmed}`);
	} catch {
		return null;
	}
	if (parsed.hostname === "") return null;
	// A query or fragment cannot be part of a base address. A path can be — a
	// daemon behind a reverse proxy — so keep it, minus any trailing slash.
	return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

const healthErrorKeys: Record<Exclude<RemoteHealth, "online">, MessageKey> = {
	unauthorized: "hosts.add.errorUnauthorized",
	offline: "hosts.add.errorOffline",
	"not-a-daemon": "hosts.add.errorNotADaemon",
};

type AddRemoteHostDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * The saved host being edited, or omitted to add a new one. Password-free by
	 * construction: it is a RemoteHostView, the only shape the main process hands
	 * the renderer, so an edit cannot round-trip a credential through this window.
	 */
	host?: RemoteHostView | null;
	/** Fires only after a successful save, with the url that was written. */
	onSaved: (url: string) => void;
};

export function AddRemoteHostDialog({ open, onOpenChange, host, onSaved }: AddRemoteHostDialogProps) {
	const { t } = useTranslation();
	const nameId = useId();
	const addressId = useId();
	const passwordId = useId();
	const editing = host ?? null;
	const [label, setLabel] = useState("");
	const [url, setUrl] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		// Opening prefills what the renderer is allowed to know and nothing else:
		// the password field starts empty on an edit too, where blank means "keep
		// the saved one". Closing clears, so the next open is never the last host's.
		setLabel(open ? (editing?.label ?? "") : "");
		setUrl(open ? (editing?.url ?? "") : "");
		setPassword("");
		setError(null);
		setBusy(false);
	}, [open, editing?.label, editing?.url]);

	const address = url.trim();
	const normalized = normalizeHostUrl(address);
	// Only worth showing when it differs; echoing back what was just typed is noise.
	const preview = normalized !== null && normalized !== address ? normalized : null;

	const submit = async () => {
		if (hasUserinfo(address)) {
			setError(t("hosts.add.errorCredentialInUrl"));
			return;
		}
		// Three outcomes, three sentences: a string that cannot address a host is
		// the user's typo, not a silent host, and must never be reported as one.
		if (normalized === null) {
			setError(t("hosts.add.errorInvalidAddress"));
			return;
		}
		setBusy(true);
		setError(null);
		const startedAt = Date.now();
		try {
			// The main process probes before it saves, on both paths: a host that
			// never answered is worse than no host, because it looks configured.
			const health = editing
				? await remotesBridge().update(editing.url, {
						label: label.trim(),
						url: normalized,
						// Omitted, not "": an empty string would wipe a working password.
						...(password === "" ? {} : { password }),
					})
				: await remotesBridge().add({ label: label.trim(), url: normalized, password });
			// Which failure mode dominates here is the whole question behind
			// "is adding a host working?" — a wrong password and an unreachable
			// machine are the same dead dialog to a user and different bugs to us.
			reportHostConnect(normalized, editing ? "edit" : "add", health, Date.now() - startedAt);
			if (health === "online") {
				onSaved(normalized);
				onOpenChange(false);
				return;
			}
			setError(t(healthErrorKeys[health]));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} className={settingsDialogContentClass}>
				<div className={settingsDialogHeaderClass}>
					<DialogTitle className="settings-dialog-title">
						{editing ? t("hosts.edit.title") : t("hosts.add.title")}
					</DialogTitle>
					<DialogDescription className="text-control leading-4 text-settings-muted">
						{editing ? t("hosts.edit.hint") : t("hosts.addRemote.hint")}
					</DialogDescription>
				</div>

				{/* After the header in DOM order because it is positioned absolutely:
				    first in the source made it the first tabbable, so opening the
				    dialog landed on Close rather than the field you came here to fill. */}
				<DialogClose asChild>
					<button
						type="button"
						disabled={busy}
						className="settings-dialog-close-button settings-close-button"
						aria-label={t("common.close")}
					>
						<X className="size-5" aria-hidden="true" />
					</button>
				</DialogClose>

				{/* A real form, so Enter in any field saves the host — the buttons are
				    the only way through otherwise, which is a long trip from a field. */}
				<form
					className="flex min-h-0 flex-col"
					onSubmit={(event) => {
						event.preventDefault();
						if (busy) return;
						void submit();
					}}
				>
					<div className={settingsDialogBodyClass}>
						<div className="flex flex-col gap-1.5">
							<label className="settings-field-label" htmlFor={nameId}>
								{t("hosts.add.name")}
							</label>
							<input
								id={nameId}
								autoComplete="off"
								className="settings-field-control h-(--size-settings-action-height)"
								value={label}
								onChange={(event) => {
									setError(null);
									setLabel(event.target.value);
								}}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<label className="settings-field-label" htmlFor={addressId}>
								{t("hosts.add.address")}
							</label>
							<input
								id={addressId}
								autoComplete="off"
								spellCheck={false}
								className="settings-field-control h-(--size-settings-action-height)"
								value={url}
								onChange={(event) => {
									// Typing is the fix for every error here, so the old message goes
									// the moment it stops describing the input: a stale "Wrong
									// password" over a corrected one reads as a second rejection.
									setError(null);
									setUrl(event.target.value);
								}}
							/>
							{preview ? (
								// The address that gets saved is not always the one typed, and a
								// silent rewrite is how "but I entered the right host" starts.
								<p className="text-caption leading-4 text-settings-muted">
									{t("hosts.add.willConnectTo", { url: preview })}
								</p>
							) : null}
						</div>

						<div className="flex flex-col gap-1.5">
							<label className="settings-field-label" htmlFor={passwordId}>
								{t("hosts.add.password")}
							</label>
							<input
								id={passwordId}
								type="password"
								autoComplete="new-password"
								className="settings-field-control h-(--size-settings-action-height)"
								value={password}
								onChange={(event) => {
									setError(null);
									setPassword(event.target.value);
								}}
							/>
							<p className="text-caption leading-4 text-settings-muted">
								{editing ? t("hosts.edit.passwordHint") : t("hosts.add.passwordHint")}
							</p>
						</div>

						{/* A probe can take seconds, and a button that only greys out reads as
						    a dead dialog to everyone and as nothing at all to a screen reader.
						    This region stays mounted because role="status" is announced far
						    more reliably on a content change than on insertion; role="alert"
						    below is the exception, being defined to announce when inserted. */}
						<p role="status" className="empty:hidden text-control leading-4 text-settings-muted">
							{busy ? t("hosts.status.checking") : ""}
						</p>
						{/* Set in the dialog's smallest type before, where it was easy to miss. */}
						{!busy && error ? (
							<p role="alert" className="text-control leading-4 font-medium text-error">
								{error}
							</p>
						) : null}
					</div>

					<div className={settingsDialogFooterClass}>
						<DialogClose asChild>
							<Button type="button" variant="footer" disabled={busy}>
								{t("confirm.cancel")}
							</Button>
						</DialogClose>
						<Button type="submit" variant="footer-primary" aria-busy={busy} disabled={busy}>
							{editing ? t("hosts.edit.submit") : t("hosts.add.submit")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
