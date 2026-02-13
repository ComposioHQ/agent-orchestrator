import chalk from "chalk";

export function header(title: string): string {
  const line = "─".repeat(76);
  return [
    chalk.dim(`┌${line}┐`),
    chalk.dim("│") + chalk.bold(` ${title}`.padEnd(76)) + chalk.dim("│"),
    chalk.dim(`└${line}┘`),
  ].join("\n");
}

export function banner(title: string): string {
  const line = "═".repeat(76);
  return [
    chalk.dim(`╔${line}╗`),
    chalk.dim("║") + chalk.bold.cyan(` ${title}`.padEnd(76)) + chalk.dim("║"),
    chalk.dim(`╚${line}╝`),
  ].join("\n");
}

export function formatAge(epochMs: number): string {
  const diff = Math.floor((Date.now() - epochMs) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function statusColor(status: string): string {
  switch (status) {
    case "working":
      return chalk.green(status);
    case "idle":
      return chalk.yellow(status);
    case "pr_open":
    case "review_pending":
      return chalk.blue(status);
    case "approved":
    case "mergeable":
    case "merged":
      return chalk.green(status);
    case "ci_failed":
    case "errored":
    case "stuck":
      return chalk.red(status);
    case "changes_requested":
    case "needs_input":
      return chalk.magenta(status);
    case "spawning":
      return chalk.cyan(status);
    case "killed":
    case "cleanup":
      return chalk.gray(status);
    default:
      return status;
  }
}
