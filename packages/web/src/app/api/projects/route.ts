import { type NextRequest, NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  findConfigFile,
  readOriginRemoteUrl,
  parseRepoUrl,
  generateConfigFromUrl,
  configToYaml,
  sanitizeProjectId,
} from "@composio/ao-core";
import { getAllProjects } from "@/lib/project-name";
import { RegisterProjectSchema } from "@/lib/api-schemas";
import { getPortfolioServices } from "@/lib/portfolio-services";
import { registerAndResolveProject } from "@/lib/project-registration";

/** Check if an agent-orchestrator config file exists directly at the given path (no upward walk). */
function hasLocalConfigFile(dirPath: string): string | null {
  for (const filename of ["agent-orchestrator.yaml", "agent-orchestrator.yml"]) {
    const configPath = resolve(dirPath, filename);
    if (existsSync(configPath)) return configPath;
  }
  return null;
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const scope = request.nextUrl.searchParams.get("scope");

    if (scope === "portfolio") {
      const { portfolio } = getPortfolioServices();
      // Strip sensitive paths before returning to the client
      const sanitized = portfolio.map((p) => ({
        id: p.id,
        name: p.name,
        repo: p.repo,
        defaultBranch: p.defaultBranch,
        sessionPrefix: p.sessionPrefix,
        source: p.source,
        enabled: p.enabled,
        pinned: p.pinned,
        lastSeenAt: p.lastSeenAt,
        degraded: p.degraded,
        degradedReason: p.degradedReason,
      }));
      return NextResponse.json({ projects: sanitized });
    }

    const projects = getAllProjects();
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load projects" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = RegisterProjectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid project payload" },
        { status: 400 },
      );
    }

    const dirPath = resolve(parsed.data.path);
    let configProjectKey = parsed.data.configProjectKey;

    // 1. Check for config directly in the project path (no upward walk)
    let localConfig = hasLocalConfigFile(dirPath);

    if (!localConfig) {
      // 2. Check if a parent/global config exists (would be the wrong one)
      const parentConfig = findConfigFile(dirPath);
      if (parentConfig) {
        // A config exists up the tree but doesn't cover this directory — don't use it.
        // Fall through to auto-generation instead of erroring.
      }

      // 3. No config — auto-generate from git remote
      if (!existsSync(join(dirPath, ".git"))) {
        return NextResponse.json(
          { error: "This directory is not a git repository. Initialize it with `git init` or select a git repository." },
          { status: 400 },
        );
      }

      const originUrl = readOriginRemoteUrl(dirPath);
      if (!originUrl) {
        return NextResponse.json(
          { error: "No git remote 'origin' found. Add a remote with `git remote add origin <url>` and try again." },
          { status: 400 },
        );
      }

      let parsedUrl;
      try {
        parsedUrl = parseRepoUrl(originUrl);
      } catch {
        return NextResponse.json(
          { error: `Could not parse the git remote URL: ${originUrl}` },
          { status: 400 },
        );
      }

      const config = generateConfigFromUrl({ parsed: parsedUrl, repoPath: dirPath });
      const configYaml = configToYaml(config);

      try {
        await writeFile(join(dirPath, "agent-orchestrator.yaml"), configYaml, "utf-8");
      } catch (writeErr) {
        return NextResponse.json(
          { error: `Could not write config file: ${writeErr instanceof Error ? writeErr.message : "permission denied"}` },
          { status: 500 },
        );
      }

      configProjectKey = configProjectKey || sanitizeProjectId(parsedUrl.repo);
      localConfig = join(dirPath, "agent-orchestrator.yaml");
    }

    const project = registerAndResolveProject(dirPath, {
      configProjectKey,
      displayName: parsed.data.name,
    });

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to register project" },
      { status: 500 },
    );
  }
}
