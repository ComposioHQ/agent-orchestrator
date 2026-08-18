import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plus, Target, Trash2 } from "lucide-react";
import type { components } from "../../api/schema";
import {
	fetchProjectControl,
	newProjectControlIdempotencyKey,
	ProjectControlRevisionConflict,
	projectControlQueryKey,
	setProjectOutcome,
} from "../lib/project-control";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type CriterionDraft = {
	key: string;
	id?: string;
	statement: string;
	verificationMethod: string;
};

function emptyCriterion(key: string): CriterionDraft {
	return { key, statement: "", verificationMethod: "" };
}

function draftsFrom(criteria: components["schemas"]["AcceptanceCriterion"][]): CriterionDraft[] {
	return [...criteria]
		.sort((a, b) => a.displayOrder - b.displayOrder)
		.map((criterion) => ({
			key: criterion.id,
			id: criterion.id,
			statement: criterion.statement,
			verificationMethod: criterion.verificationMethod,
		}));
}

export function ProjectControlCockpit({ projectId }: { projectId: string }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const formId = useId();
	const nextCriterionKey = useRef(1);
	const [editing, setEditing] = useState(false);
	const [statement, setStatement] = useState("");
	const [criteria, setCriteria] = useState<CriterionDraft[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const query = useQuery({
		queryKey: projectControlQueryKey(projectId),
		queryFn: ({ signal }) => fetchProjectControl(projectId, signal),
		retry: false,
	});

	useEffect(() => {
		setEditing(false);
		setError(undefined);
	}, [projectId]);

	const beginEdit = () => {
		const outcome = query.data?.outcome;
		setStatement(outcome?.statement ?? "");
		setCriteria(outcome ? draftsFrom(outcome.criteria) : [emptyCriterion(`${formId}-criterion-0`)]);
		setError(undefined);
		setEditing(true);
	};

	const reloadAfterConflict = async (conflict: ProjectControlRevisionConflict) => {
		const current = await queryClient.fetchQuery({
			queryKey: projectControlQueryKey(projectId),
			queryFn: ({ signal }) => fetchProjectControl(projectId, signal),
			staleTime: 0,
		});
		setStatement(current.outcome?.statement ?? "");
		setCriteria(current.outcome ? draftsFrom(current.outcome.criteria) : [emptyCriterion(`${formId}-criterion-0`)]);
		setError(
			t("projectControl.conflict", {
				revision: conflict.currentRevision ?? current.revision,
			}),
		);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!query.data || saving) return;
		setSaving(true);
		setError(undefined);
		try {
			const saved = await setProjectOutcome(projectId, {
				statement,
				expectedRevision: query.data.revision,
				idempotencyKey: newProjectControlIdempotencyKey(),
				criteria: criteria.map((criterion, displayOrder) => ({
					...(criterion.id ? { id: criterion.id } : {}),
					statement: criterion.statement,
					verificationMethod: criterion.verificationMethod,
					displayOrder,
				})),
			});
			queryClient.setQueryData(projectControlQueryKey(projectId), saved);
			setEditing(false);
		} catch (caught) {
			if (caught instanceof ProjectControlRevisionConflict) {
				try {
					await reloadAfterConflict(caught);
				} catch {
					setError(t("projectControl.conflictReloadFailed"));
				}
			} else {
				setError(caught instanceof Error ? caught.message : t("projectControl.saveFailed"));
			}
		} finally {
			setSaving(false);
		}
	};

	if (query.isPending) {
		return <div className="mx-3 mt-3 h-20 shrink-0 animate-pulse rounded-lg bg-muted/50" data-testid="project-control-loading" />;
	}
	if (query.isError || !query.data) {
		return (
		<section className="mx-3 mt-3 flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
			<p className="min-w-0 flex-1 text-sm text-destructive">{t("projectControl.loadFailed")}</p>
			<Button onClick={() => void query.refetch()} size="sm" variant="outline">{t("projectControl.retry")}</Button>
		</section>
		);
	}

	const control = query.data;
	const orderedCriteria = control.outcome ? [...control.outcome.criteria].sort((a, b) => a.displayOrder - b.displayOrder) : [];
	return (
		<section aria-label={t("projectControl.title")} className="mx-3 mt-3 shrink-0 rounded-lg border border-border bg-card px-4 py-3 shadow-sm" data-testid="project-control-cockpit">
			<div className="flex items-start gap-3">
				<Target aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="font-heading text-sm font-medium">{t("projectControl.title")}</h2>
						<Badge variant="outline">{t("projectControl.revision", { revision: control.revision })}</Badge>
						{control.configured ? <Badge>{t("projectControl.health", { health: control.health })}</Badge> : null}
						{control.configured ? <Badge>{t("projectControl.confidence", { confidence: control.confidence })}</Badge> : null}
					</div>
					{!editing && !control.configured ? (
						<p className="mt-1 text-xs text-muted-foreground">{t("projectControl.unconfigured")}</p>
					) : null}
					{!editing && control.outcome ? (
						<div className="mt-2">
							<p className="text-sm font-medium text-foreground">{control.outcome.statement}</p>
							<ol className="mt-1 space-y-0.5 text-xs text-muted-foreground">
								{orderedCriteria.map((criterion) => (
									<li key={criterion.id} data-criterion-id={criterion.id}>
										<span className="font-medium text-foreground">{criterion.statement}</span>
										<span> — {criterion.verificationMethod}</span>
									</li>
								))}
							</ol>
						</div>
					) : null}
				</div>
				{!editing ? <Button onClick={beginEdit} size="sm">{t(control.configured ? "projectControl.edit" : "projectControl.configure")}</Button> : null}
			</div>

			{editing ? (
				<form className="mt-3 space-y-3 border-t border-border pt-3" onSubmit={(event) => void submit(event)}>
					<label className="block text-xs font-medium" htmlFor={`${formId}-statement`}>
						{t("projectControl.outcome")}
					</label>
					<textarea
						className="min-h-16 w-full resize-y rounded-md border border-border bg-input/50 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
						id={`${formId}-statement`}
						onChange={(event) => setStatement(event.target.value)}
						required
						value={statement}
					/>
					<div className="space-y-2">
						{criteria.map((criterion, index) => (
							<div className="grid grid-cols-[1fr_1fr_auto] gap-2" data-criterion-id={criterion.id} key={criterion.key}>
								<Input aria-label={t("projectControl.criterionStatement", { index: index + 1 })} onChange={(event) => setCriteria((current) => current.map((item) => item.key === criterion.key ? { ...item, statement: event.target.value } : item))} required value={criterion.statement} />
								<Input aria-label={t("projectControl.verificationMethod", { index: index + 1 })} onChange={(event) => setCriteria((current) => current.map((item) => item.key === criterion.key ? { ...item, verificationMethod: event.target.value } : item))} required value={criterion.verificationMethod} />
								<Button aria-label={t("projectControl.removeCriterion", { index: index + 1 })} disabled={criteria.length === 1} onClick={() => setCriteria((current) => current.filter((item) => item.key !== criterion.key))} size="icon" type="button" variant="ghost"><Trash2 aria-hidden="true" /></Button>
							</div>
						))}
					</div>
					<div className="flex items-center gap-2">
						<Button
							onClick={() =>
								setCriteria((current) => [
									...current,
									emptyCriterion(`${formId}-criterion-new-${nextCriterionKey.current++}`),
								])
							}
							size="sm"
							type="button"
							variant="outline"
						>
							<Plus aria-hidden="true" />
							{t("projectControl.addCriterion")}
						</Button>
						<span className="min-w-0 flex-1" />
						<Button onClick={() => { setEditing(false); setError(undefined); }} size="sm" type="button" variant="ghost">{t("projectControl.cancel")}</Button>
						<Button disabled={saving} size="sm" type="submit">{t(saving ? "projectControl.saving" : "projectControl.save")}</Button>
					</div>
					{error ? <p aria-live="assertive" className="text-xs text-destructive" role="alert">{error}</p> : null}
				</form>
			) : null}
		</section>
	);
}
