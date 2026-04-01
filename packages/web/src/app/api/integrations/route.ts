import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);

async function hasGitHubCliAuth(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export const dynamic = "force-dynamic";

export async function GET() {
  const githubConnected =
    Boolean(process.env.GITHUB_TOKEN) || Boolean(process.env.GH_TOKEN) || (await hasGitHubCliAuth());
  const linearConnected = Boolean(process.env.LINEAR_API_KEY);
  const slackConnected = Boolean(process.env.SLACK_WEBHOOK_URL);

  return NextResponse.json({
    integrations: [
      {
        name: "GitHub",
        connected: githubConnected,
        details: githubConnected ? "SCM and PR data are available." : "Authenticate with GitHub CLI or set a token.",
      },
      {
        name: "Linear",
        connected: linearConnected,
        details: linearConnected ? "Issue tracking is configured." : "Set LINEAR_API_KEY to enable Linear-backed flows.",
      },
      {
        name: "Slack",
        connected: slackConnected,
        details: slackConnected ? "Slack notifications are configured." : "Set SLACK_WEBHOOK_URL to enable Slack notifications.",
      },
    ],
  });
}
