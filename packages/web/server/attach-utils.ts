import {
  createPluginRegistry,
  createSessionManager,
  loadConfig,
  type AttachInfo,
  type OpenCodeSessionManager,
} from "@composio/ao-core";
import { findTmux, resolveTmuxSession } from "./tmux-utils.js";

let sessionManagerPromise: Promise<OpenCodeSessionManager> | null = null;
let tmuxPath: string | null = null;

async function getSessionManager(): Promise<OpenCodeSessionManager> {
  if (!sessionManagerPromise) {
    sessionManagerPromise = (async () => {
      const config = loadConfig();
      const registry = createPluginRegistry();
      await registry.loadFromConfig(config, (pkg: string) => import(pkg));
      return createSessionManager({ config, registry });
    })();
  }
  return sessionManagerPromise;
}

function resolveLegacyTmuxAttachInfo(sessionId: string): AttachInfo | null {
  const tmux = tmuxPath ?? findTmux();
  tmuxPath = tmux;

  const tmuxTarget = resolveTmuxSession(sessionId, tmux);
  if (!tmuxTarget) {
    return null;
  }

  return {
    type: "tmux",
    target: tmuxTarget,
    command: `tmux attach -t ${tmuxTarget}`,
    program: tmux,
    args: ["attach", "-t", tmuxTarget],
    requiresPty: true,
  };
}

export async function resolveAttachInfo(sessionId: string): Promise<AttachInfo | null> {
  try {
    const sessionManager = await getSessionManager();
    const attachInfo = await sessionManager.getAttachInfo(sessionId).catch(() => null);
    if (attachInfo) {
      return attachInfo;
    }

    const session = await sessionManager.get(sessionId).catch(() => null);
    if (session) {
      return null;
    }
  } catch {
    // Fall through to the legacy tmux lookup below.
  }

  // Keep web terminal flows compatible with raw tmux sessions that predate
  // AO-managed metadata, including hash-prefixed session names.
  return resolveLegacyTmuxAttachInfo(sessionId);
}
