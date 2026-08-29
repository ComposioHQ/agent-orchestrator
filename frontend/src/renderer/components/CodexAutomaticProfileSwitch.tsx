import { useEffect, useMemo, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2, Settings2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import type { WorkspaceSession } from "../types/workspace";
import { cn } from "../lib/utils";
import { useCancelCodexAutomaticProfileSwitchAttempt, useCodexAutomaticProfileSwitchPolicy, useSaveCodexAutomaticProfileSwitchPolicy } from "../hooks/useCodexAutomaticProfileSwitch";
import { useCodexProfilesQuery } from "../hooks/useCodexProfilesQuery";

function SortableProfile({ id, label, detail, reorderLabel, checked, current, onToggle }: { id: string; label: string; detail: string; reorderLabel: string; checked: boolean; current: boolean; onToggle: () => void }) {
	const sortable = useSortable({ id, disabled: !checked });
	return (
		<div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="flex items-center gap-2 rounded-md border border-border p-2">
		<button type="button" aria-label={reorderLabel} className="cursor-grab text-muted-foreground disabled:cursor-default disabled:opacity-30" disabled={!checked} {...sortable.attributes} {...sortable.listeners}><GripVertical className="size-4" /></button>
		<input type="checkbox" checked={checked} onChange={onToggle} />
		<div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{label}{current ? " · Current" : ""}</p><p className="truncate text-2xs text-muted-foreground">{detail}</p></div>
	</div>
	);
}

export function CodexAutomaticProfileSwitchControl({ session }: { session: WorkspaceSession }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [ordered, setOrdered] = useState<string[]>([]);
	const [enabled, setEnabled] = useState(false);
	const policy = useCodexAutomaticProfileSwitchPolicy(session.id, Boolean(session.codexProfile && !session.cloud && session.kind !== "orchestrator"), open);
	const profiles = useCodexProfilesQuery(open);
	const save = useSaveCodexAutomaticProfileSwitchPolicy(session.id);
	const attempt = session.latestAutomaticCodexProfileSwitchAttempt;
	const cancel = useCancelCodexAutomaticProfileSwitchAttempt(session.id, attempt?.id);
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

	useEffect(() => {
		if (!open || !policy.data) return;
		setEnabled(policy.data.enabled);
		setOrdered(policy.data.profiles.map((entry) => entry.id));
	}, [open, policy.data]);

	const allProfiles = useMemo(() => {
		const configured = new Map(policy.data?.profiles.map((entry) => [entry.id, entry]) ?? []);
		for (const profile of profiles.data?.profiles ?? []) {
			if (!configured.has(profile.id)) configured.set(profile.id, {
				id: profile.id, label: profile.label, source: profile.source, availability: profile.status === "valid" ? "available" : "unavailable",
				authentication: profile.authentication, capacity: profile.capacity, current: profile.id === session.codexProfile?.id,
				reasonCode: "automatic_profile_switch_profile_available", reason: profile.reason,
			});
		}
		const byID = new Map(configured);
		const unselected = [...configured.keys()].filter((id) => !ordered.includes(id));
		return [...ordered, ...unselected].map((id) => byID.get(id)!).filter(Boolean);
	}, [ordered, policy.data?.profiles, profiles.data?.profiles, session.codexProfile?.id]);

	if (!session.codexProfile || session.cloud || session.kind === "orchestrator" || session.isArchived) return null;
	const onDragEnd = (event: DragEndEvent) => {
		if (!event.over || event.active.id === event.over.id) return;
		const from = ordered.indexOf(String(event.active.id));
		const to = ordered.indexOf(String(event.over.id));
		if (from >= 0 && to >= 0) setOrdered(arrayMove(ordered, from, to));
	};
	const attemptActive = attempt && (attempt.state === "evaluating" || attempt.state === "delegated_to_phase5" || attempt.state === "needs_attention");
	return (
		<>
			<div className="mt-2 rounded-md border border-border bg-background/50 p-2.5">
				<div className="flex items-center justify-between gap-2"><div><p className="text-xs font-medium">{t("codexAutomaticSwitch.title")}</p><p className="text-2xs text-muted-foreground">{policy.data?.enabled ? t("codexAutomaticSwitch.enabled") : t("codexAutomaticSwitch.disabled")}</p></div><Button size="sm" variant="outline" onClick={() => setOpen(true)}><Settings2 className="size-3.5" />{t("codexAutomaticSwitch.configure")}</Button></div>
				{attempt ? <div className={cn("mt-2 flex items-start gap-2 text-2xs", attempt.state === "needs_attention" || attempt.state === "no_candidate" ? "text-warning" : "text-muted-foreground")}>{attemptActive ? <Loader2 className="mt-0.5 size-3 animate-spin" /> : attempt.state === "no_candidate" ? <TriangleAlert className="mt-0.5 size-3" /> : null}<span>{attempt.reason}</span>{attempt.canCancel ? <Button className="ml-auto" size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>{t("codexAutomaticSwitch.cancel")}</Button> : null}</div> : null}
			</div>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-w-lg gap-0 overflow-hidden rounded-xl border-border bg-popover p-0">
					<DialogHeader className="border-b border-border px-5 py-4"><DialogTitle>{t("codexAutomaticSwitch.title")}</DialogTitle><DialogDescription className="pt-1 text-xs leading-5">{t("codexAutomaticSwitch.description")}</DialogDescription></DialogHeader>
					<div className="grid max-h-[28rem] gap-3 overflow-y-auto px-5 py-4">
						<label className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-xs font-medium"><span>{t("codexAutomaticSwitch.enableLabel")}</span><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /></label>
						<p className="text-2xs text-muted-foreground">{t("codexAutomaticSwitch.orderHelp")}</p>
						<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={ordered} strategy={verticalListSortingStrategy}><div className="grid gap-2">{allProfiles.map((profile) => {
							const checked = ordered.includes(profile.id);
							const auth = profile.authentication?.state ?? "unknown";
							const capacity = profile.capacity?.state ?? "unknown";
							return <SortableProfile key={profile.id} id={profile.id} label={profile.label} reorderLabel={t("codexAutomaticSwitch.reorderProfile")} checked={checked} current={profile.current} detail={`${auth} · ${capacity} · ${profile.reason}`} onToggle={() => setOrdered((current) => checked ? current.filter((id) => id !== profile.id) : [...current, profile.id])} />;
						})}</div></SortableContext></DndContext>
						{save.error ? <p className="text-xs text-destructive" role="alert">{save.error instanceof Error ? save.error.message : t("codexAutomaticSwitch.saveFailed")}</p> : null}
					</div>
					<DialogFooter className="border-t border-border px-5 py-3"><Button variant="outline" onClick={() => setOpen(false)}>{t("codexProfileSwitch.keep")}</Button><Button disabled={(enabled && ordered.length === 0) || save.isPending || !policy.data} onClick={() => policy.data && save.mutate({ enabled, profileIds: ordered, expectedRevision: policy.data.revision }, { onSuccess: () => setOpen(false) })}>{save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}{t("codexAutomaticSwitch.save")}</Button></DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
