import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  configToYaml,
  generateConfigFromUrl,
  isPortfolioEnabled,
  parseRepoUrl,
  sanitizeProjectId,
} from "@aoagents/ao-core";
import { CloneProjectSchema } from "@/lib/api-schemas";
import { extractFlatLocalConfig } from "@/lib/local-project-config";
import { assertPathWithinHome } from "@/lib/path-security";
import { registerAndResolveProject } from "@/lib/project-registration";

const execFileAsync = promisify(execFile);

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function ensureMissingOrEmptyDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${path}`);
    }
    throw new Error(`Target directory already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    if (!isPortfolioEnabled()) {
      return NextResponse.json({ error: "Portfolio mode is disabled" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = CloneProjectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid clone request" },
        { status: 400 },
      );
    }

    const repo = parseRepoUrl(parsed.data.url);
    const cloneRoot = await assertPathWithinHome(parsed.data.location);
    const targetDir = resolve(cloneRoot, repo.repo);
    let projectKey = sanitizeProjectId(repo.repo);

    await ensureDirectory(cloneRoot);
    await ensureMissingOrEmptyDirectory(targetDir);

    await execFileAsync("git", ["clone", repo.cloneUrl, targetDir], {
      timeout: 120_000,
    });

    const localConfigPath = [join(targetDir, "agent-orchestrator.yaml"), join(targetDir, "agent-orchestrator.yml")];
    const existingConfigPath = await (async () => {
      for (const path of localConfigPath) {
        try {
          await stat(path);
          return path;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
      return null;
    })();

    if (!existingConfigPath) {
      const config = generateConfigFromUrl({
        parsed: repo,
        repoPath: targetDir,
      });
      await writeFile(
        localConfigPath[0],
        configToYaml(extractFlatLocalConfig(config, projectKey)),
        "utf-8",
      );
    }

    const project = registerAndResolveProject(targetDir, {
      configProjectKey: projectKey,
    });

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        path: targetDir,
        repo: basename(targetDir),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to clone repository" },
      { status: 500 },
    );
  }
}
