import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { getRepoDir, isDirty } from "@/lib/git";
import { getServices } from "@/lib/services";

/** POST /api/self-update/trigger — Start self-update process */
export async function POST() {
  try {
    const dirty = await isDirty();
    if (dirty) {
      return NextResponse.json(
        { error: "Uncommitted changes detected. Commit or stash first." },
        { status: 409 },
      );
    }

    const repoDir = await getRepoDir();
    const { config } = await getServices();
    const port = config.port ?? 3000;

    // Find the first project id (for restart)
    const projectIds = Object.keys(config.projects);
    const projectId = projectIds.length === 1 ? projectIds[0] : "";

    const scriptPath = resolve(repoDir, "scripts/ao-self-update");

    const child = spawn("bash", [scriptPath], {
      cwd: repoDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AO_REPO_DIR: repoDir,
        AO_PORT: String(port),
        AO_PROJECT: projectId,
        AO_RESTART: "true",
      },
    });
    child.unref();

    return NextResponse.json({ ok: true, message: "Update started. Dashboard will restart shortly." });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to trigger update";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
