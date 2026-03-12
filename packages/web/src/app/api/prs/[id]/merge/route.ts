import { type NextRequest, NextResponse } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import { loadHarnessSnapshot, resolveSessionHarnessContext } from "@/lib/harness-plan";

/** POST /api/prs/:id/merge — Merge a PR */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: "Invalid PR number" }, { status: 400 });
  }
  const prNumber = Number(id);

  try {
    const { config, registry, sessionManager } = await getServices();
    const harnessSnapshot = await loadHarnessSnapshot(config);
    const sessions = await sessionManager.list();

    const session = sessions.find((s) => s.pr?.number === prNumber);
    if (!session?.pr) {
      return NextResponse.json({ error: "PR not found" }, { status: 404 });
    }

    const harness = resolveSessionHarnessContext(harnessSnapshot, session.id, session.issueId);
    if (harness?.workState?.work_status && new Set(["killed", "abandoned"]).has(harness.workState.work_status)) {
      return NextResponse.json(
        { error: `Merge blocked by repo policy: work is ${harness.workState.work_status}` },
        { status: 409 },
      );
    }
    if (harness?.reconciliation?.next_action && harness.reconciliation.next_action !== "monitor") {
      return NextResponse.json(
        {
          error: "Merge blocked by repo policy: reconciliation is still pending",
          nextAction: harness.reconciliation.next_action,
          reason: harness.reconciliation.reason ?? null,
        },
        { status: 409 },
      );
    }
    if (harness?.dispatchPlan && harness.dispatchPlan.next_action !== "monitor") {
      return NextResponse.json(
        {
          error: "Merge blocked by repo policy: work has a pending harness action",
          nextAction: harness.dispatchPlan.next_action,
          reason: harness.dispatchPlan.reason,
        },
        { status: 409 },
      );
    }
    const workId = harness?.workId ?? session.issueId ?? null;
    if (workId) {
      const rescore = harnessSnapshot.needsRescore.find((entry) => entry.subject_id === workId);
      if (rescore) {
        return NextResponse.json(
          {
            error: "Merge blocked by repo policy: scorecard requires revision",
            scoreBand: rescore.score_band,
            recommendedAction: rescore.recommended_action,
          },
          { status: 409 },
        );
      }
    }

    const project = config.projects[session.projectId];
    const scm = getSCM(registry, project);
    if (!scm) {
      return NextResponse.json(
        { error: "No SCM plugin configured for this project" },
        { status: 500 },
      );
    }

    // Validate PR is in a mergeable state
    const state = await scm.getPRState(session.pr);
    if (state !== "open") {
      return NextResponse.json({ error: `PR is ${state}, not open` }, { status: 409 });
    }

    const mergeability = await scm.getMergeability(session.pr);
    if (!mergeability.mergeable) {
      return NextResponse.json(
        { error: "PR is not mergeable", blockers: mergeability.blockers },
        { status: 422 },
      );
    }

    await scm.mergePR(session.pr, "squash");
    return NextResponse.json({ ok: true, prNumber, method: "squash" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to merge PR" },
      { status: 500 },
    );
  }
}
