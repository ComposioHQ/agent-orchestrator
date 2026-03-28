import type { AttachInfo } from "@composio/ao-core";
import { formatAttachCommand } from "./attach.js";
import { exec } from "./shell.js";

interface OpenItermOptions {
  tabTitle: string;
  tmuxTarget: string;
  runtimeName: string;
  attachInfo?: AttachInfo | null;
  newWindow?: boolean;
}

export function buildOpenItermArgs(options: OpenItermOptions): string[] | null {
  const args: string[] = [];
  if (options.newWindow) {
    args.push("--new-window");
  }

  if (options.runtimeName === "tmux") {
    args.push(options.tmuxTarget);
    return args;
  }

  if (!options.attachInfo) {
    return null;
  }

  args.push(
    "--title",
    options.tabTitle,
    "--command",
    formatAttachCommand(options.attachInfo, `tmux attach -t ${options.tmuxTarget}`),
  );
  return args;
}

export async function openInIterm(options: OpenItermOptions): Promise<boolean> {
  const args = buildOpenItermArgs(options);
  if (!args) {
    return false;
  }

  try {
    await exec("open-iterm-tab", args);
    return true;
  } catch {
    return false;
  }
}
