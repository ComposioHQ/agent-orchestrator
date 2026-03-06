import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier, validateString, stripControlChars } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

interface SwarmTask {
  issueId?: string;
  prompt?: string;
}

const MAX_TASKS = 20;
const MAX_PROMPT_LENGTH = 2000;

/** POST /api/swarm — Batch-spawn multiple agent sessions */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return NextResponse.json({ error: "tasks must be a non-empty array" }, { status: 400 });
  }

  if (body.tasks.length > MAX_TASKS) {
    return NextResponse.json(
      { error: `Cannot spawn more than ${MAX_TASKS} sessions at once` },
      { status: 400 },
    );
  }

  // Validate each task
  const tasks: SwarmTask[] = [];
  for (let i = 0; i < body.tasks.length; i++) {
    const task = body.tasks[i] as Record<string, unknown>;
    if (!task || typeof task !== "object") {
      return NextResponse.json({ error: `tasks[${i}] must be an object` }, { status: 400 });
    }
    if (task.issueId === undefined && task.prompt === undefined) {
      return NextResponse.json(
        { error: `tasks[${i}] must have either issueId or prompt` },
        { status: 400 },
      );
    }
    if (task.issueId !== undefined) {
      const err = validateIdentifier(task.issueId, `tasks[${i}].issueId`);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }
    if (task.prompt !== undefined) {
      const err = validateString(task.prompt, `tasks[${i}].prompt`, MAX_PROMPT_LENGTH);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }
    tasks.push({
      issueId: task.issueId as string | undefined,
      prompt: task.prompt !== undefined ? stripControlChars(task.prompt as string) : undefined,
    });
  }

  try {
    const { sessionManager } = await getServices();
    const results = await Promise.allSettled(
      tasks.map((task) =>
        sessionManager.spawn({
          projectId: body.projectId as string,
          issueId: task.issueId,
          prompt: task.prompt,
        }),
      ),
    );

    const created = [];
    const failed = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        created.push(sessionToDashboard(result.value));
      } else {
        failed.push({
          task: tasks[i],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    return NextResponse.json({ created, failed }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to spawn swarm" },
      { status: 500 },
    );
  }
}
