import { CornerLeftUp, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { remotesBridge } from "../hooks/useRemoteHosts";
import { daemonErrorMessage } from "../lib/daemon-error";
import { parseResponseArray } from "../lib/response-validation";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogFooterClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";

type Listing = components["schemas"]["ListDirsResponse"];
type Entry = components["schemas"]["FSEntry"];

function isEntry(value: unknown): value is Entry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<Entry>;
	return typeof entry.name === "string" && typeof entry.path === "string";
}

/**
 * A 200 is not proof of a listing. This body came off another machine, possibly
 * from a build that predates GET /api/v1/fs/dirs, where the web-UI catch-all
 * answers an unknown route with 200 and an HTML page. Casting that to Listing
 * put `undefined.map` on the render path and took the whole window down, so the
 * shape is checked once here rather than guessed at every render site.
 */
function parseListing(body: unknown): Listing | null {
	if (typeof body !== "object" || body === null) return null;
	const candidate = body as Partial<Listing>;
	if (typeof candidate.path !== "string" || typeof candidate.parent !== "string") return null;
	const entries = parseResponseArray(body, "entries", isEntry);
	if (entries === null) return null;
	return {
		entries,
		parent: candidate.parent,
		path: candidate.path,
		truncated: candidate.truncated === true,
	};
}

/**
 * Browses a remote daemon's directories over GET /api/v1/fs/dirs so a project
 * path can be picked instead of typed blind. Every path decision belongs to the
 * daemon: this dialog never joins, normalises, or judges a path itself, because
 * it may be looking at a different OS than the one it runs on.
 */
export function RemoteFolderPicker({
	hostLabel,
	hostUrl,
	onOpenChange,
	onSelect,
	open,
}: {
	hostLabel: string;
	hostUrl: string;
	onOpenChange: (open: boolean) => void;
	onSelect: (path: string) => void;
	open: boolean;
}) {
	const { t } = useTranslation();
	// null means "wherever the daemon calls home" — the endpoint's own default.
	const [path, setPath] = useState<string | null>(null);
	const [listing, setListing] = useState<Listing | null>(null);
	const [error, setError] = useState<string | null>(null);
	// A listing off another machine can take seconds. Without this the dialog
	// just sits there showing the folder you left, which reads as a dead dialog
	// to everyone and as nothing at all to a screen reader.
	const [loading, setLoading] = useState(false);
	const list = useRef<HTMLUListElement>(null);
	// Stepping into a folder replaces every row, so the row that had focus stops
	// existing and focus falls back to the dialog. Move it to the new listing
	// instead — but only after a step, never on the first open, where the focus
	// Radix just placed is the right one.
	const stepped = useRef(false);

	useEffect(() => {
		if (!open) {
			setPath(null);
			setListing(null);
			setError(null);
			setLoading(false);
			stepped.current = false;
			return;
		}
		let cancelled = false;
		setLoading(true);
		void (async () => {
			const query = path === null ? "" : `?path=${encodeURIComponent(path)}`;
			try {
				const response = await remotesBridge().request(hostUrl, {
					method: "GET",
					path: `/api/v1/fs/dirs${query}`,
				});
				if (cancelled) return;
				setLoading(false);
				if (response.status === 200) {
					const parsed = parseListing(response.body);
					if (parsed !== null) {
						setListing(parsed);
						setError(null);
						return;
					}
					// A 200 we cannot read is a version gap, not an empty folder, and
					// saying "no subfolders" would be a lie that costs an hour to unpick.
					setError(t("fsBrowse.unsupported"));
					return;
				}
				// Keep the last good listing on screen so a refused directory is a
				// dead end, not a dead dialog.
				setError(daemonErrorMessage(response.body) ?? t("fsBrowse.failed"));
			} catch (err) {
				if (cancelled) return;
				setLoading(false);
				setError(err instanceof Error ? err.message : t("fsBrowse.failed"));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [hostUrl, open, path, t]);

	useEffect(() => {
		if (listing === null || !stepped.current) return;
		stepped.current = false;
		list.current?.querySelector("button")?.focus();
	}, [listing]);

	const step = (next: string) => {
		stepped.current = true;
		setPath(next);
	};

	const canGoUp = listing !== null && listing.parent !== listing.path;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className={settingsDialogContentClass}>
				<div className={settingsDialogHeaderClass}>
					<DialogTitle className="settings-dialog-title">{t("fsBrowse.title", { host: hostLabel })}</DialogTitle>
					<DialogDescription
						aria-live="polite"
						className="truncate font-mono text-control leading-4 text-settings-muted"
					>
						{listing?.path ?? t("fsBrowse.hint")}
					</DialogDescription>
				</div>

				<div className={settingsDialogBodyClass}>
					{error ? (
						<p role="alert" className="text-caption leading-4 text-error">
							{error}
						</p>
					) : null}

					<p role="status" className="empty:hidden text-caption leading-4 text-settings-muted">
						{loading ? t("fsBrowse.loading") : ""}
					</p>

					<ul ref={list} className="flex flex-col gap-0.5">
						{canGoUp && listing ? (
							<li>
								<FolderRow icon={CornerLeftUp} label={t("fsBrowse.up")} onClick={() => step(listing.parent)} />
							</li>
						) : null}
						{listing?.entries?.map((entry) => (
							<li key={entry.path}>
								<FolderRow
									icon={Folder}
									label={entry.name}
									badge={entry.gitRepo ? t("fsBrowse.gitRepo") : undefined}
									onClick={() => step(entry.path)}
								/>
							</li>
						))}
					</ul>

					{listing !== null && listing.entries.length === 0 ? (
						<p className="text-caption leading-4 text-settings-muted">{t("fsBrowse.empty")}</p>
					) : null}
					{listing?.truncated ? (
						<p className="text-caption leading-4 text-settings-muted">
							{t("fsBrowse.truncated", { limit: listing.entries.length })}
						</p>
					) : null}
				</div>

				<div className={settingsDialogFooterClass}>
					<Button type="button" variant="footer" onClick={() => onOpenChange(false)}>
						{t("confirm.cancel")}
					</Button>
					<Button
						type="button"
						variant="footer-primary"
						disabled={listing === null}
						onClick={() => {
							if (!listing) return;
							onSelect(listing.path);
							onOpenChange(false);
						}}
					>
						{t("fsBrowse.chooseThis")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function FolderRow({
	badge,
	icon: Icon,
	label,
	onClick,
}: {
	badge?: string;
	icon: typeof Folder;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-control text-settings-label transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
			onClick={onClick}
		>
			<Icon className="size-4 shrink-0 text-settings-muted" aria-hidden="true" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{badge ? (
				<span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-caption text-settings-muted">
					{badge}
				</span>
			) : null}
		</button>
	);
}
