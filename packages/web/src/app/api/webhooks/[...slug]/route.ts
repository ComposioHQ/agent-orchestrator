import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import {
  buildWebhookRequest,
  eventMatchesProject,
  findAffectedSessions,
  findRestorableSessions,
  findWebhookProjects,
} from "@/lib/scm-webhooks";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const services = await getServices();
    const path = new URL(request.url).pathname;
    const candidates = findWebhookProjects(services.config, services.registry, path);

    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "No SCM webhook configured for this path" },
        { status: 404 },
      );
    }

    const rawContentLength = request.headers.get("content-length");
    const contentLength = rawContentLength ? Number(rawContentLength) : NaN;
    const candidateMaxBodyBytes = candidates.map(
      (candidate) => candidate.project.scm?.webhook?.maxBodyBytes,
    );
    const allCandidatesBounded = candidateMaxBodyBytes.every((value) => typeof value === "number");
    const maxBodyBytes = allCandidatesBounded
      ? Math.max(...(candidateMaxBodyBytes as number[]))
      : undefined;
    if (
      maxBodyBytes !== undefined &&
      Number.isFinite(contentLength) &&
      contentLength > maxBodyBytes
    ) {
      return NextResponse.json(
        { error: "Webhook payload exceeds configured maxBodyBytes" },
        { status: 413 },
      );
    }

    const rawBody = new Uint8Array(await request.arrayBuffer());
    const body = new TextDecoder().decode(rawBody);
    const webhookRequest = buildWebhookRequest(request, body, rawBody);

    const sessions = await services.sessionManager.list();
    const sessionIds = new Set<string>();
    const projectIds = new Set<string>();
    let verified = false;
    const errors: string[] = [];
    const parseErrors: string[] = [];
    const lifecycleErrors: string[] = [];

    for (const candidate of candidates) {
      const verification = await candidate.scm.verifyWebhook?.(webhookRequest, candidate.project);
      if (!verification?.ok) {
        if (verification?.reason) errors.push(verification.reason);
        continue;
      }
      verified = true;

      let event;
      try {
        event = await candidate.scm.parseWebhook?.(webhookRequest, candidate.project);
      } catch (err) {
        parseErrors.push(err instanceof Error ? err.message : "Invalid webhook payload");
        continue;
      }

      if (!event || !eventMatchesProject(event, candidate.project)) {
        continue;
      }

      projectIds.add(candidate.projectId);
      const affectedSessions = findAffectedSessions(sessions, candidate.projectId, event);

      const lifecycle = services.lifecycleManager;

      if (affectedSessions.length === 0) {
        // Gap 1: session exists but is terminal — restore it, then let existing reaction engine handle ci-failed
        const restorable = findRestorableSessions(sessions, candidate.projectId, event);
        for (const session of restorable) {
          sessionIds.add(session.id);
          try {
            await services.sessionManager.restore(session.id);
            await lifecycle.check(session.id);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Restore failed";
            lifecycleErrors.push(`restore ${session.id}: ${message}`);
          }
        }

        // Gap 2: no session at all — auto-spawn if project opts in
        if (restorable.length === 0) {
          const autoSpawn = candidate.project.scm?.webhook?.autoSpawnOnCIFailure ?? false;
          if (autoSpawn && event.kind === "ci" && event.prNumber !== undefined && event.branch) {
            try {
              const spawned = await services.sessionManager.spawn({
                projectId: candidate.projectId,
                branch: event.branch,
                prompt: `CI failed on PR #${event.prNumber}. Investigate the failure, fix the root cause, and push a fix to this branch.`,
              });
              sessionIds.add(spawned.id);
              await lifecycle.check(spawned.id);
            } catch (err) {
              const message = err instanceof Error ? err.message : "Spawn failed";
              lifecycleErrors.push(`auto-spawn PR #${event.prNumber}: ${message}`);
            }
          }
        }

        continue;
      }

      for (const session of affectedSessions) {
        sessionIds.add(session.id);
        try {
          await lifecycle.check(session.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Lifecycle check failed";
          lifecycleErrors.push(`session ${session.id}: ${message}`);
        }
      }
    }

    if (!verified) {
      return NextResponse.json(
        { error: errors[0] ?? "Webhook verification failed", ok: false },
        { status: 401 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        projectIds: [...projectIds],
        sessionIds: [...sessionIds],
        matchedSessions: sessionIds.size,
        parseErrors,
        lifecycleErrors,
      },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to process SCM webhook" },
      { status: 500 },
    );
  }
}
