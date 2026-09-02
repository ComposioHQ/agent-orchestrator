import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon, Pencil, Trash2 } from "lucide-react";
import { LOCAL_HOST_ID, probeFailed, type Host, type HostStatus, type RemoteHostView } from "../hooks/useRemoteHosts";
import type { MessageKey } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const statusKeys: Record<Exclude<HostStatus, "local">, MessageKey> = {
	online: "hosts.status.online",
	checking: "hosts.status.checking",
	offline: "hosts.status.offline",
	unauthorized: "hosts.status.unauthorized",
	"not-a-daemon": "hosts.status.notADaemon",
};

// Copied from SelectTrigger/SelectItem so the picker still looks like every
// other dropdown in the flow; only the semantics underneath changed.
const TRIGGER_CLASS =
	"flex h-control-board w-full items-center justify-between gap-2 rounded-md border border-transparent bg-input/50 px-3 py-2 text-sm whitespace-nowrap transition-[color,box-shadow,background-color,border-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";
const ROW_CLASS =
	"relative flex min-w-0 flex-1 select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:bg-interactive-hover focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 aria-disabled:pointer-events-none aria-disabled:opacity-50";

// A host you cannot reach can only fail one step later, so it is not selectable.
function unreachable(host: Host): boolean {
	return probeFailed(host.status);
}

type HostSelectProps = {
	hosts: Host[];
	value: string;
	onChange: (hostId: string) => void;
	onAddHost: () => void;
	/** Re-probe one host — a host has no session to open, reachability is the whole state. */
	onReconnect?: (url: string) => void;
	/** Fix a saved host in place: renamed, re-pointed, or given a rotated password. */
	onEditHost?: (host: RemoteHostView) => void;
	onRemoveHost?: (host: RemoteHostView) => void;
};

/**
 * Picks the host a project is created on, and manages the saved ones in place.
 *
 * A popover rather than a Select, because each row carries its own Connect,
 * Edit and Remove buttons: Radix's Select calls preventDefault() on Tab inside
 * its listbox and moves focus only between options, so those buttons were
 * mouse-only, and a listbox whose children are buttons is not a listbox any
 * screen reader can report faithfully. Plain buttons in a popover are reachable
 * with Tab, announced as what they are, and cost no keyboard code of our own.
 * `modal` keeps Tab inside the open list, the way the Select it replaced did,
 * so a row's three actions cannot spill you into the dialog behind it.
 */
export function HostSelect({
	hosts,
	value,
	onChange,
	onAddHost,
	onReconnect,
	onEditHost,
	onRemoveHost,
}: HostSelectProps) {
	const { t } = useTranslation();
	const selected = hosts.find((host) => host.id === value);
	// Open is controlled only so Edit, Remove and picking a host can close it.
	// Connect deliberately does not, because its result is the status shown in
	// the list.
	const [open, setOpen] = useState(false);

	const pick = (hostId: string) => {
		setOpen(false);
		onChange(hostId);
	};

	return (
		<Popover modal open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				className={TRIGGER_CLASS}
				// The value belongs in the name: a bare "Host" would leave a screen
				// reader announcing the control without what it is set to.
				aria-label={t("hosts.switcher", { host: selected?.label ?? "" })}
			>
				<span className="min-w-0 truncate">{selected?.label ?? ""}</span>
				<ChevronDownIcon aria-hidden="true" className="size-icon-base shrink-0 opacity-50" />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				aria-label={t("hosts.label")}
				className="w-(--radix-popover-trigger-width) bg-card p-1"
				onOpenAutoFocus={(event) => {
					// Open on the host in use, the way a Select opens on its value.
					const content = event.currentTarget as HTMLElement | null;
					const current = content?.querySelector<HTMLElement>("[data-host-current]");
					if (!current) return;
					event.preventDefault();
					current.focus();
				}}
			>
				<ul className="flex flex-col gap-0.5">
					{hosts.map((host) => {
						const url = host.url;
						const blocked = unreachable(host);
						return (
							<li key={host.id} className="flex items-center gap-1">
								<button
									type="button"
									// Kept focusable while unselectable: a disabled button is
									// silent, and "why can I not pick this one" is answered by
									// the status text this row is the only place to hear.
									aria-disabled={blocked || undefined}
									aria-current={host.id === value ? "true" : undefined}
									data-host-current={host.id === value ? "" : undefined}
									className={ROW_CLASS}
									onClick={() => {
										if (blocked) return;
										pick(host.id);
									}}
								>
									<span className="flex min-w-0 flex-col items-start">
										<span className="min-w-0 truncate text-foreground">{host.label}</span>
										{host.status === "local" ? null : (
											<span className="text-xs text-muted-foreground">{t(statusKeys[host.status])}</span>
										)}
									</span>
								</button>
								{host.id === LOCAL_HOST_ID ? null : (
									<>
										{blocked && url && onReconnect ? (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="shrink-0"
												aria-label={t("hosts.connectTo", { host: host.label })}
												onClick={() => onReconnect(url)}
											>
												{t("hosts.connect")}
											</Button>
										) : null}
										{/* Icons, not words: a row already carries a name, a status and
										    sometimes Connect, and three text buttons would push the name
										    it identifies out of view. Each carries its host's name in its
										    label so the action is never just "Edit" to a screen reader. */}
										{url && onEditHost ? (
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className="shrink-0"
												aria-label={t("hosts.edit", { host: host.label })}
												onClick={() => {
													setOpen(false);
													onEditHost({ label: host.label, url });
												}}
											>
												<Pencil aria-hidden="true" />
											</Button>
										) : null}
										{url && onRemoveHost ? (
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className="shrink-0"
												aria-label={t("hosts.remove", { host: host.label })}
												onClick={() => {
													setOpen(false);
													onRemoveHost({ label: host.label, url });
												}}
											>
												<Trash2 aria-hidden="true" />
											</Button>
										) : null}
									</>
								)}
							</li>
						);
					})}
					<li aria-hidden="true" className="-mx-1 my-1 h-px shrink-0 bg-border" />
					<li className="flex">
						{/* Lives in the same list as the hosts so it is reachable the same
										way, but it opens a dialog instead of picking anything. */}
						<button
							type="button"
							className={cn(ROW_CLASS, "flex-col items-start gap-0")}
							onClick={() => {
								setOpen(false);
								onAddHost();
							}}
						>
							<span className="text-foreground">{t("hosts.addRemote")}</span>
							<span className="text-xs text-muted-foreground">{t("hosts.addRemote.hint")}</span>
						</button>
					</li>
				</ul>
			</PopoverContent>
		</Popover>
	);
}
