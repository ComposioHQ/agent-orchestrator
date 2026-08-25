import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClock, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
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
		<CardHeader><CardTitle className="flex items-center gap-2"><button type="button" className="grid size-6 place-items-center rounded hover:bg-muted" aria-label={`${expanded ? "Hide" : "Show"} run history for ${item.displayName}`} onClick={onExpand}>{expanded ? <ChevronDown /> : <ChevronRight />}</button>{item.displayName}</CardTitle><CardDescription>{item.projectId} · {scheduleLabel(item)}</CardDescription><CardAction className="flex items-center gap-3"><label className="flex items-center gap-2 text-xs text-muted-foreground"><span>{item.enabled ? "Enabled" : "Disabled"}</span><Switch size="sm" checked={item.enabled} aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.displayName}`} onCheckedChange={(checked) => void onToggle(checked)} /></label><Button variant="ghost" size="icon-sm" aria-label={`Delete ${item.displayName}`} onClick={onDelete}><Trash2 /></Button></CardAction></CardHeader>
		<CardContent><div className="grid gap-3 text-sm sm:grid-cols-3"><div><span className="block text-xs text-muted-foreground">Next run</span>{item.enabled ? displayTime(item.nextRunAt) : "Paused"}</div><div><span className="block text-xs text-muted-foreground">Latest state</span>{item.latestRun?.status ?? "Never run"}</div><div><span className="block text-xs text-muted-foreground">Agent</span>{item.harness || "Project default"} · {item.kind}</div></div>{item.latestRun?.errorMessage ? <p role="alert" className="mt-3 rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{item.latestRun.errorMessage}</p> : null}
		{expanded ? <div className="mt-4 border-t border-border pt-4"><h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Run history</h3>{runs.isLoading ? <p className="text-sm text-muted-foreground">Loading runs…</p> : runs.data?.length ? <div className="space-y-2">{runs.data.map((run) => <div key={run.id} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm"><div><span className="font-medium capitalize">{run.status}</span><span className="ml-2 text-xs text-muted-foreground">{displayTime(run.scheduledFor)}</span>{run.errorMessage ? <p className="text-xs text-destructive">{run.errorMessage}</p> : null}</div>{run.sessionId ? <Button variant="outline" size="sm" onClick={() => void navigate({ to: "/sessions/$sessionId", params: { sessionId: run.sessionId! } })}>Open session</Button> : null}</div>)}</div> : <p className="text-sm text-muted-foreground">No runs yet.</p>}</div> : null}</CardContent>
	</Card>;
}

type WorkspaceOption = { id: string; name: string };
type HarnessOption = { id: string; label: string };
function CreateAutomationDialog({ open, workspaces, harnesses, busy, error, onOpenChange, onCreate }: { open: boolean; workspaces: WorkspaceOption[]; harnesses: HarnessOption[]; busy: boolean; error: string | null; onOpenChange: (open: boolean) => void; onCreate: (input: { projectId: string; displayName: string; prompt: string; kind: "worker" | "orchestrator"; harness?: string; timezone: string; rrule: string }) => Promise<void> }) {
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const [projectId, setProjectId] = useState(""); const [name, setName] = useState(""); const [prompt, setPrompt] = useState(""); const [kind, setKind] = useState<"worker" | "orchestrator">("worker"); const [harness, setHarness] = useState(""); const [preset, setPreset] = useState("daily"); const [hour, setHour] = useState("09:00"); const [raw, setRaw] = useState("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0");
	async function submit(event: FormEvent) { event.preventDefault(); const [hours, minutes] = hour.split(":").map(Number); const rrule = preset === "daily" ? `FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${minutes};BYSECOND=0` : preset === "weekly" ? `FREQ=WEEKLY;BYDAY=MO;BYHOUR=${hours};BYMINUTE=${minutes};BYSECOND=0` : raw; await onCreate({ projectId, displayName: name, prompt, kind, harness: harness || undefined, timezone, rrule }); }
	return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Create automation</DialogTitle><DialogDescription>The daemon schedules sessions in the selected timezone, including daylight-saving changes.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={(event) => void submit(event)}><Field label="Project"><select required value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-control-form w-full rounded-md bg-input/50 px-3 text-sm"><option value="">Select a project</option>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Name"><Input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Prompt"><textarea required maxLength={4096} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-24 w-full rounded-md bg-input/50 px-3 py-2 text-sm" /></Field><div className="grid grid-cols-2 gap-3"><Field label="Session kind"><select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="h-control-form w-full rounded-md bg-input/50 px-3 text-sm"><option value="worker">Worker</option><option value="orchestrator">Orchestrator</option></select></Field><Field label="Agent"><select value={harness} onChange={(e) => setHarness(e.target.value)} className="h-control-form w-full rounded-md bg-input/50 px-3 text-sm"><option value="">Project default</option>{harnesses.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field></div><Field label="Schedule"><select value={preset} onChange={(e) => setPreset(e.target.value)} className="h-control-form w-full rounded-md bg-input/50 px-3 text-sm"><option value="daily">Daily</option><option value="weekly">Weekly on Monday</option><option value="raw">Custom RRule</option></select></Field>{preset === "raw" ? <Field label="RRule"><Input required value={raw} onChange={(e) => setRaw(e.target.value)} /></Field> : <Field label="Local time"><Input required type="time" value={hour} onChange={(e) => setHour(e.target.value)} /></Field>}<p className="text-xs text-muted-foreground">Timezone: {timezone}</p>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<DialogFooter className="flex-row justify-end"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create automation"}</Button></DialogFooter></form></DialogContent></Dialog>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1.5 text-sm"><span className="font-medium">{label}</span>{children}</label>; }
