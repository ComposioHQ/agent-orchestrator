export function buildFlatLocalConfig(repo?: string): Record<string, unknown> {
  return {
    ...(repo ? { repo } : {}),
    defaultBranch: "main",
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
  };
}

export function extractFlatLocalConfig(
  config: Record<string, unknown>,
  projectKey: string,
): Record<string, unknown> {
  const projects = config["projects"];
  if (!projects || typeof projects !== "object") {
    return {};
  }

  const project = (projects as Record<string, unknown>)[projectKey];
  if (!project || typeof project !== "object") {
    return {};
  }

  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(project)) {
    if (key === "name" || key === "path" || key === "sessionPrefix") continue;
    flat[key] = value;
  }
  return flat;
}
