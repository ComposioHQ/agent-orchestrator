import { useState } from "react";
import { Check, Laptop, Loader2, Plus, Server, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LOCAL_WORKSPACE_ID, validateRemoteWorkspace, workspaceLabel } from "../../../shared/workspaces";
import type { DaemonStatus } from "../../../shared/daemon-status";
import { useWorkspaces } from "../../hooks/useWorkspaces";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import { SettingsSection } from "./SettingsSection";

/**
 * Pick the machine agents run on.
 *
 * Each workspace runs its own AO daemon; selecting one repoints this client at
 * it over SSH. Only the selected workspace's state is shown anywhere in the app,
 * so this row is the single place the answer to "where is my work happening"
 * lives — which is why the connection status is rendered inline on the row
 * rather than left to the daemon banner.
 */
export function WorkspacesSection({ daemonStatus, titleHidden }: { daemonStatus: DaemonStatus; titleHidden?: boolean }) {
	const { t } = useTranslation();
	const { registry, activeId, error, add, remove, setActive, clearError } = useWorkspaces();
	const [adding, setAdding] = useState(false);

	const rows = [
		{ id: LOCAL_WORKSPACE_ID, label: t("workspaces.local"), detail: t("workspaces.localHint"), removable: false },
		...registry.remotes.map((remote) => ({
			id: remote.id,
			label: workspaceLabel(remote),
			detail: remote.sshTarget,
			removable: true,
		})),
	];

	return (
		<SettingsSection title={t("workspaces.title")} sectionId="workspaces" titleHidden={titleHidden}>
			{rows.map((row) => (
				<WorkspaceRow
					key={row.id}
					{...row}
					selected={row.id === activeId}
					// The daemon status describes whichever workspace is selected, so it
					// is only meaningful on that row.
					status={row.id === activeId ? daemonStatus : undefined}
					onSelect={() => void setActive(row.id)}
					onRemove={() => void remove(row.id)}
				/>
			))}

			{adding ? (
				<AddWorkspaceForm
					onCancel={() => {
						clearError();
						setAdding(false);
					}}
					onSubmit={async (workspace) => {
						if (await add(workspace)) setAdding(false);
					}}
				/>
			) : (
				<button
					type="button"
					onClick={() => setAdding(true)}
					className="settings-row-bar w-full text-left transition-colors hover:bg-settings-menu-selected"
				>
					<div className="flex shrink-0 items-center gap-(--size-settings-row-icon-gap)">
						<Plus className="size-icon-lg shrink-0 text-settings-muted" aria-hidden="true" />
						<span className="whitespace-nowrap text-sm leading-5 text-settings-label">{t("workspaces.add")}</span>
					</div>
				</button>
			)}

			{error ? (
				<p role="alert" className="px-1 text-xs leading-4 text-destructive">
					{error}
				</p>
			) : null}
		</SettingsSection>
	);
}

function WorkspaceRow({
	id,
	label,
	detail,
	removable,
	selected,
	status,
	onSelect,
	onRemove,
}: {
	id: string;
	label: string;
	detail: string;
	removable: boolean;
	selected: boolean;
	status?: DaemonStatus;
	onSelect: () => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation();
	const Icon = id === LOCAL_WORKSPACE_ID ? Laptop : Server;

	return (
		<div className={cn("settings-row-bar", selected && "bg-settings-menu-selected")}>
			<button
				type="button"
				aria-pressed={selected}
				onClick={onSelect}
				className="flex min-w-0 flex-1 items-center gap-(--size-settings-row-icon-gap) text-left"
			>
				<Icon className="size-icon-lg shrink-0 text-settings-muted" aria-hidden="true" />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm leading-5 text-settings-label">{label}</span>
					<span className="block truncate text-xs leading-4 text-settings-muted">{detail}</span>
				</span>
				{selected ? <ConnectionState status={status} /> : null}
			</button>
			{removable ? (
				<button
					type="button"
					onClick={onRemove}
					aria-label={t("workspaces.removeAria", { name: label })}
					className="ml-2 shrink-0 rounded p-1 text-settings-muted transition-colors hover:text-destructive"
				>
					<Trash2 className="size-icon-base" aria-hidden="true" />
				</button>
			) : null}
		</div>
	);
}

/**
 * The selected workspace's connection state. A failure is shown as text here
 * and not merely as an icon: for a remote workspace the message carries the
 * remedy (accept the host key, load your key, install `ao` there), and losing
 * it would leave the user with a silent, unexplained disconnection.
 */
function ConnectionState({ status }: { status?: DaemonStatus }) {
	const { t } = useTranslation();
	if (!status) return null;

	if (status.state === "starting") {
		return (
			<span className="ml-2 flex shrink-0 items-center gap-1 text-xs text-settings-muted">
				<Loader2 className="size-icon-base animate-spin" aria-hidden="true" />
				{t("workspaces.connecting")}
			</span>
		);
	}
	if (status.state === "ready") {
		return (
			<span className="ml-2 flex shrink-0 items-center gap-1 text-xs text-settings-muted">
				<Check className="size-icon-base" aria-hidden="true" />
				{t("workspaces.connected")}
			</span>
		);
	}
	return <span className="ml-2 max-w-[18rem] shrink-0 truncate text-xs text-destructive">{status.message}</span>;
}

function AddWorkspaceForm({
	onCancel,
	onSubmit,
}: {
	onCancel: () => void;
	onSubmit: (workspace: { id: string; sshTarget: string }) => void;
}) {
	const { t } = useTranslation();
	const [id, setId] = useState("");
	const [sshTarget, setSshTarget] = useState("");
	// Validated with the same function the supervisor uses, so the inline
	// message and the persisted rejection can never disagree.
	const invalid = validateRemoteWorkspace({ id, sshTarget });
	const touched = id !== "" || sshTarget !== "";

	return (
		<form
			className="flex w-full flex-col gap-2 rounded-md bg-settings-menu-selected/50 p-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!invalid) onSubmit({ id: id.trim(), sshTarget: sshTarget.trim() });
			}}
		>
			<div className="flex gap-2">
				<Input
					value={id}
					onChange={(event) => setId(event.target.value)}
					placeholder={t("workspaces.idPlaceholder")}
					aria-label={t("workspaces.id")}
					autoFocus
				/>
				<Input
					value={sshTarget}
					onChange={(event) => setSshTarget(event.target.value)}
					placeholder={t("workspaces.targetPlaceholder")}
					aria-label={t("workspaces.target")}
				/>
			</div>
			<p className="text-xs leading-4 text-settings-muted">{t("workspaces.targetHint")}</p>
			{touched && invalid ? (
				<p role="alert" className="text-xs leading-4 text-destructive">
					{invalid.message}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					{t("workspaces.cancel")}
				</Button>
				<Button type="submit" size="sm" disabled={Boolean(invalid)}>
					{t("workspaces.save")}
				</Button>
			</div>
		</form>
	);
}
