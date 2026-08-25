import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClock, ChevronDown, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
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
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { ConfirmDialog } from "./ConfirmDialog";
import { useAgentsQuery } from "../hooks/useAgentsQuery";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import {
	useAutomationRuns,
	useAutomations,
	useCreateAutomation,
	useDeleteAutomation,
	useUpdateAutomation,
	type Automation,
} from "../hooks/useAutomations";

function displayTime(value?: string) {
	if (!value) return "—";
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function scheduleLabel(item: Automation) {
	const frequency = item.rrule.match(/FREQ=([^;\n]+)/)?.[1]?.toLowerCase() ?? "recurring";
	return `${frequency} · ${item.timezone}`;
}

export function AutomationsView() {
	const query = useAutomations();
	const workspaces = useWorkspaceQuery().data ?? [];
	const harnesses = useAgentsQuery().data?.supported ?? [];
	const create = useCreateAutomation();
	const update = useUpdateAutomation();
	const remove = useDeleteAutomation();
	const [createOpen, setCreateOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-auto bg-background">
			<header className="flex items-center justify-between border-b border-border px-8 py-5">
				<div><h1 className="text-xl font-semibold">Automations</h1><p className="mt-1 text-sm text-muted-foreground">Schedule recurring AO sessions with durable run history.</p></div>
				<Button onClick={() => setCreateOpen(true)}><Plus aria-hidden="true" />New automation</Button>
			</header>
			<main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-8">
				{actionError ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p> : null}
				{query.isLoading ? <p className="text-sm text-muted-foreground">Loading automations…</p> : null}
				{query.error ? <p role="alert" className="text-sm text-destructive">{query.error.message}</p> : null}
				{!query.isLoading && !query.error && query.data?.length === 0 ? <EmptyAutomations onCreate={() => setCreateOpen(true)} /> : null}
				{query.data?.map((item) => (
					<AutomationCard key={item.id} item={item} expanded={expanded === item.id} onExpand={() => setExpanded(expanded === item.id ? null : item.id)} onDelete={() => setDeleteTarget(item)} onToggle={async (enabled) => { setActionError(null); try { await update.mutateAsync({ id: item.id, body: { enabled } }); } catch (error) { setActionError(error instanceof Error ? error.message : "Could not update automation"); } }} />
				))}
			</main>
			<CreateAutomationDialog open={createOpen} workspaces={workspaces} harnesses={harnesses} busy={create.isPending} error={create.error?.message ?? null} onOpenChange={setCreateOpen} onCreate={async (input) => { await create.mutateAsync(input); setCreateOpen(false); }} />
			<ConfirmDialog open={Boolean(deleteTarget)} title="Delete automation?" description={<>This permanently deletes <strong>{deleteTarget?.displayName}</strong> and its run history. Linked sessions remain available.</>} confirmLabel="Delete automation" destructive busy={remove.isPending} error={remove.error?.message ?? null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} onConfirm={() => { if (!deleteTarget) return; remove.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) }); }} />
		</div>
	);
}

function EmptyAutomations({ onCreate }: { onCreate: () => void }) {
	return <div className="grid min-h-64 place-items-center rounded-xl border border-dashed border-border p-8 text-center"><div><CalendarClock className="mx-auto mb-3 size-8 text-muted-foreground" /><h2 className="font-medium">No automations yet</h2><p className="mt-1 text-sm text-muted-foreground">Create a daily, weekly, or custom recurring session.</p><Button className="mt-4" onClick={onCreate}>Create automation</Button></div></div>;
}

function AutomationCard({ item, expanded, onExpand, onDelete, onToggle }: { item: Automation; expanded: boolean; onExpand: () => void; onDelete: () => void; onToggle: (enabled: boolean) => Promise<void> }) {
	const runs = useAutomationRuns(expanded ? item.id : null);
	const navigate = useNavigate();
	return <Card size="sm">
		<CardHeader><CardTitle className="flex items-center gap-2"><button type="button" className="grid size-6 place-items-center rounded hover:bg-muted" aria-label={`${expanded ? "Hide" : "Show"} run history for ${item.displayName}`} onClick={onExpand}>{expanded ? <ChevronDown /> : <ChevronRight />}</button>{item.displayName}</CardTitle><CardDescription>{item.projectId} · {scheduleLabel(item)}</CardDescription><CardAction className="flex items-center gap-3"><label className="flex items-center gap-2 text-xs text-muted-foreground"><span>{item.enabled ? "Enabled" : "Disabled"}</span><Switch size="sm" checked={item.enabled} aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.displayName}`} onCheckedChange={(checked) => void onToggle(checked)} /></label><Button variant="ghost" size="icon-sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${item.displayName}`} onClick={onDelete}><Trash2 /></Button></CardAction></CardHeader>
		<CardContent><div className="grid gap-3 text-sm sm:grid-cols-3"><div><span className="block text-xs text-muted-foreground">Next run</span>{item.enabled ? displayTime(item.nextRunAt) : "Paused"}</div><div><span className="block text-xs text-muted-foreground">Latest state</span>{item.latestRun?.status ?? "Never run"}</div><div><span className="block text-xs text-muted-foreground">Agent</span>{item.harness || "Project default"} · {item.kind}</div></div>{item.latestRun?.errorMessage ? <p role="alert" className="mt-3 rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{item.latestRun.errorMessage}</p> : null}
		{expanded ? <div className="mt-4 border-t border-border pt-4"><h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Run history</h3>{runs.isLoading ? <p className="text-sm text-muted-foreground">Loading runs…</p> : runs.data?.length ? <div className="space-y-2">{runs.data.map((run) => <div key={run.id} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm"><div><span className="font-medium capitalize">{run.status}</span><span className="ml-2 text-xs text-muted-foreground">{displayTime(run.scheduledFor)}</span>{run.errorMessage ? <p className="text-xs text-destructive">{run.errorMessage}</p> : null}</div>{run.sessionId ? <Button variant="outline" size="sm" onClick={() => void navigate({ to: "/sessions/$sessionId", params: { sessionId: run.sessionId! } })}>Open session</Button> : null}</div>)}</div> : <p className="text-sm text-muted-foreground">No runs yet.</p>}</div> : null}</CardContent>
	</Card>;
}

type WorkspaceOption = { id: string; name: string };
type HarnessOption = { id: string; label: string };
type CreateAutomationDialogProps = {
	open: boolean;
	workspaces: WorkspaceOption[];
	harnesses: HarnessOption[];
	busy: boolean;
	error: string | null;
	onOpenChange: (open: boolean) => void;
	onCreate: (input: {
		projectId: string;
		displayName: string;
		prompt: string;
		kind: "worker" | "orchestrator";
		harness?: string;
		timezone: string;
		rrule: string;
	}) => Promise<void>;
};

const PROJECT_DEFAULT = "__project_default__";

function CreateAutomationDialog({
	open,
	workspaces,
	harnesses,
	busy,
	error,
	onOpenChange,
	onCreate,
}: CreateAutomationDialogProps) {
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const [projectId, setProjectId] = useState("");
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [kind, setKind] = useState<"worker" | "orchestrator">("worker");
	const [harness, setHarness] = useState("");
	const [preset, setPreset] = useState("daily");
	const [hour, setHour] = useState("09");
	const [minute, setMinute] = useState("00");
	const [raw, setRaw] = useState("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0");

	async function submit(event: FormEvent) {
		event.preventDefault();
		const rrule =
			preset === "daily"
				? `FREQ=DAILY;BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)};BYSECOND=0`
				: preset === "weekly"
					? `FREQ=WEEKLY;BYDAY=MO;BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)};BYSECOND=0`
					: raw;
		await onCreate({
			projectId,
			displayName: name,
			prompt,
			kind,
			harness: harness || undefined,
			timezone,
			rrule,
		});
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={false} className={settingsDialogContentClass}>
				<DialogClose asChild>
					<button
						type="button"
						disabled={busy}
						className="settings-dialog-close-button settings-close-button"
						aria-label="Close create automation"
					>
						<X className="size-5" aria-hidden="true" />
					</button>
				</DialogClose>
				<div className={settingsDialogHeaderClass}>
					<DialogTitle className="settings-dialog-title">Create automation</DialogTitle>
					<DialogDescription className="text-control leading-4 text-settings-muted">
						The daemon schedules sessions in the selected timezone, including daylight-saving changes.
					</DialogDescription>
				</div>
				<form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
					<div className={settingsDialogBodyClass}>
						<Field label="Project">
							<AutomationSelect
								label="Project"
								placeholder="Select a project"
								required
								value={projectId}
								onValueChange={setProjectId}
								options={workspaces.map((item) => ({ value: item.id, label: item.name }))}
							/>
						</Field>
						<Field label="Name">
							<Input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
						</Field>
						<Field label="Prompt">
							<textarea
								required
								maxLength={4096}
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
								className="min-h-24 w-full rounded-md bg-input/50 px-3 py-2 text-sm outline-none"
							/>
						</Field>
						<div className="grid grid-cols-2 gap-3">
							<Field label="Session kind">
								<AutomationSelect
									label="Session kind"
									value={kind}
									onValueChange={(value) => setKind(value as typeof kind)}
									options={[
										{ value: "worker", label: "Worker" },
										{ value: "orchestrator", label: "Orchestrator" },
									]}
								/>
							</Field>
							<Field label="Agent">
								<AutomationSelect
									label="Agent"
									value={harness || PROJECT_DEFAULT}
									onValueChange={(value) => setHarness(value === PROJECT_DEFAULT ? "" : value)}
									options={[
										{ value: PROJECT_DEFAULT, label: "Project default" },
										...harnesses.map((item) => ({ value: item.id, label: item.label })),
									]}
								/>
							</Field>
						</div>
						<Field label="Schedule">
							<AutomationSelect
								label="Schedule"
								value={preset}
								onValueChange={setPreset}
								options={[
									{ value: "daily", label: "Daily" },
									{ value: "weekly", label: "Weekly on Monday" },
									{ value: "raw", label: "Custom RRule" },
								]}
							/>
						</Field>
						{preset === "raw" ? (
							<Field label="RRule">
								<Input required value={raw} onChange={(event) => setRaw(event.target.value)} />
							</Field>
						) : (
							<Field label="Local time">
								<div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
									<TimePartInput label="Hour" value={hour} max={23} onChange={setHour} />
									<span aria-hidden="true" className="text-center font-semibold text-muted-foreground">:</span>
									<TimePartInput label="Minute" value={minute} max={59} onChange={setMinute} />
								</div>
							</Field>
						)}
						<p className="text-xs text-settings-muted">Timezone: {timezone}</p>
						{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
					</div>
					<div className={settingsDialogFooterClass}>
						<Button type="button" variant="footer" disabled={busy} onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" variant="footer-primary" disabled={busy}>
							{busy ? "Creating…" : "Create automation"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function TimePartInput({ label, value, max, onChange }: { label: string; value: string; max: number; onChange: (value: string) => void }) {
	return (
		<Input
			type="text"
			inputMode="numeric"
			required
			maxLength={2}
			pattern={max === 23 ? "(?:[01]?[0-9]|2[0-3])" : "[0-5]?[0-9]"}
			value={value}
			aria-label={label}
			className="text-control tabular-nums"
			onFocus={(event) => event.currentTarget.select()}
			onChange={(event) => onChange(event.target.value)}
			onBlur={(event) => {
				if (event.currentTarget.validity.valid && event.currentTarget.value !== "") {
					onChange(String(Number(event.currentTarget.value)).padStart(2, "0"));
				}
			}}
		/>
	);
}

function AutomationSelect({
	label,
	value,
	onValueChange,
	options,
	placeholder,
	required,
}: {
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	options: Array<{ value: string; label: string }>;
	placeholder?: string;
	required?: boolean;
}) {
	return (
		<Select value={value} onValueChange={onValueChange} required={required}>
			<SelectTrigger size="sm" className="w-full text-control" aria-label={label}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent position="popper" side="bottom" align="start" sideOffset={4} className="max-h-64">
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5 text-sm">
			<span className="font-medium text-settings-label">{label}</span>
			{children}
		</div>
	);
}
