import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Loader2, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import type { WorkspaceSession } from "../types/workspace";
import { cn } from "../lib/utils";
import { aoBridge } from "../lib/bridge";
import { codexCapacityRemainingPercent } from "../lib/codex-capacity";
import { cacheCodexProfile, startCodexProfileLogin, useCodexProfileLoginEvents, type CodexProfileLoginEvent, type CodexProfileLoginStart } from "../hooks/useCodexProfilesQuery";
import { useCodexProfileSwitchOptions, useControlCodexProfileSwitch, useStartCodexProfileSwitch } from "../hooks/useCodexProfileSwitch";

export function CodexProfileSwitchControl({ session }: { session: WorkspaceSession }) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState("");
	const [acknowledge, setAcknowledge] = useState(false);
	const [login, setLogin] = useState<CodexProfileLoginStart | null>(null);
	const [error, setError] = useState<string | null>(null);
	const options = useCodexProfileSwitchOptions(session.id, open);
	const start = useStartCodexProfileSwitch(session.id);
	const operation = session.activeCodexProfileSwitch;
	const hadActiveOperation = useRef(Boolean(operation));
	const control = useControlCodexProfileSwitch(session.id, operation?.id);
	const capacity = session.codexProfile?.capacity;
	const suggested = capacity?.freshness === "fresh" && (capacity.state === "near_limit" || capacity.state === "exhausted");
	const selectedCandidate = options.data?.candidates.find((candidate) => candidate.id === selected);

	useEffect(() => {
		if (!open || selected) return;
		setSelected(options.data?.recommendedProfileId ?? options.data?.candidates.find((candidate) => candidate.selectable)?.id ?? "");
	}, [open, options.data, selected]);
	useEffect(() => {
		if (operation) {
			hadActiveOperation.current = true;
			return;
		}
		if (!hadActiveOperation.current || !session.isArchived || !session.continuedTo) return;
		hadActiveOperation.current = false;
		void navigate({ to: "/projects/$projectId/sessions/$sessionId", params: { projectId: session.workspaceId, sessionId: session.continuedTo.sessionId } });
	}, [navigate, operation, session.continuedTo, session.isArchived, session.workspaceId]);

	const onLoginEvent = useCallback((event: CodexProfileLoginEvent) => {
		if (event.profile) cacheCodexProfile(queryClient, event.profile);
		if (event.status !== "pending") {
			setLogin(null);
			options.ensure();
		}
	}, [options, queryClient]);
	useCodexProfileLoginEvents(login, onLoginEvent);

	if (!session.codexProfile || session.cloud || session.kind === "orchestrator") return null;
	if (session.isArchived && session.continuedTo) {
		return <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/projects/$projectId/sessions/$sessionId", params: { projectId: session.workspaceId, sessionId: session.continuedTo!.sessionId } })}>{t("codexProfileSwitch.continuedTo", { label: session.continuedTo.label })}<ArrowRight className="size-3.5" /></Button>;
	}
	if (operation) {
		const actionError = control.error instanceof Error ? control.error.message : null;
		return (
			<div className="mt-2 rounded-md border border-border bg-background/50 p-2.5" role="status">
				<div className="flex items-center gap-2 text-xs font-medium"><Loader2 className="size-3.5 animate-spin" />{operation.progressReason}</div>
				{actionError ? <p className="mt-1 text-2xs text-destructive">{actionError}</p> : null}
				<div className="mt-2 flex gap-2">
					{operation.canCancel ? <Button size="sm" variant="outline" disabled={control.isPending} onClick={() => control.mutate("cancel")}>{t("codexProfileSwitch.cancel")}</Button> : null}
					{operation.canRecover ? <Button size="sm" disabled={control.isPending} onClick={() => control.mutate("recover")}>{t("codexProfileSwitch.retryTarget")}</Button> : null}
					{operation.canRestoreSource ? <Button size="sm" variant="outline" disabled={control.isPending} onClick={() => control.mutate("restore-source")}>{t("codexProfileSwitch.restoreSource")}</Button> : null}
				</div>
			</div>
		);
	}

	return (
		<>
			<Button className={cn("mt-2 w-full", capacity?.state === "exhausted" && "border-warning text-warning")} size="sm" variant="outline" onClick={() => setOpen(true)}>
				{suggested ? <TriangleAlert className="size-3.5" /> : null}
				{capacity?.state === "near_limit" ? t("codexProfileSwitch.nearLimitAction") : t("codexProfileSwitch.action")}
			</Button>
			<Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setError(null); setAcknowledge(false); } }}>
				<DialogContent className="max-w-lg gap-0 overflow-hidden rounded-xl border-border bg-popover p-0">
					<DialogHeader className="border-b border-border px-5 py-4">
						<DialogTitle>{t("codexProfileSwitch.title")}</DialogTitle>
						<DialogDescription className="pt-1 text-xs leading-5">{t("codexProfileSwitch.description")}</DialogDescription>
					</DialogHeader>
					<div className="grid max-h-80 gap-2 overflow-y-auto px-5 py-4">
						<p className="text-xs text-muted-foreground">{t("codexProfileSwitch.current", { profile: session.codexProfile.label })}</p>
						{options.isLoading && !options.data ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t("codexProfileSwitch.checking")}</div> : null}
						{options.data?.candidates.map((candidate) => {
							const remainingPercent = codexCapacityRemainingPercent(candidate.capacity.usedPercent);
							return <div key={candidate.id} className={cn("rounded-lg border p-3", selected === candidate.id ? "border-primary" : "border-border")}>
								<button className="w-full text-left disabled:opacity-55" disabled={!candidate.selectable} onClick={() => { setSelected(candidate.id); setAcknowledge(false); options.ensure(); }} type="button">
									<span className="flex items-center justify-between gap-2 text-sm font-medium"><span>{candidate.label}</span>{candidate.recommended ? <span className="text-2xs text-success">{t("codexProfileSwitch.recommended")}</span> : null}</span>
									<span className="mt-1 block text-2xs text-muted-foreground">{candidate.capacity.plan ? `${candidate.capacity.plan} · ` : ""}{remainingPercent === undefined ? candidate.capacity.state : t("codexProfileSwitch.remaining", { percent: remainingPercent })} · {candidate.reason}</span>
								</button>
								{candidate.authentication.state === "unauthorized" ? <Button className="mt-2" size="sm" variant="outline" disabled={Boolean(login)} onClick={async () => { try { const next = await startCodexProfileLogin(candidate.id); setLogin(next); await aoBridge.app.openExternal(next.authUrl); } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-in failed"); } }}>{t("codexProfileSwitch.signIn")}</Button> : null}
							</div>;
						})}
						{selectedCandidate?.requiresCapacityAcknowledgement ? <label className="flex items-start gap-2 text-xs"><input checked={acknowledge} className="mt-0.5" onChange={(event) => setAcknowledge(event.target.checked)} type="checkbox" /><span>{t("codexProfileSwitch.capacityAcknowledgement")}</span></label> : null}
						{error || start.error ? <p className="text-xs text-destructive" role="alert">{error ?? (start.error instanceof Error ? start.error.message : "Unable to start profile switch")}</p> : null}
					</div>
					<DialogFooter className="border-t border-border px-5 py-3">
						<Button variant="outline" disabled={start.isPending} onClick={() => setOpen(false)}>{t("codexProfileSwitch.keep")}</Button>
						<Button disabled={!selectedCandidate?.selectable || (selectedCandidate.requiresCapacityAcknowledgement && !acknowledge) || start.isPending} onClick={() => start.mutate({ targetProfileId: selected, acknowledgeUnknownCapacity: acknowledge }, { onSuccess: () => setOpen(false) })}>{start.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}{t("codexProfileSwitch.create")}</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
