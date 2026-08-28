package omp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	ompExtensionsDirName = "extensions"
	ompExtensionFileName = "ao-activity.ts"
	ompExtensionSentinel = "agent-orchestrator: managed omp activity extension"
)

func ompExtensionPath(workspacePath string) string {
	return filepath.Join(workspacePath, ".omp", ompExtensionsDirName, ompExtensionFileName)
}

// GetAgentHooks installs AO's project-local OMP activity extension. Launch and
// restore also pass this exact file explicitly, so status tracking does not
// depend on extension auto-discovery.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("omp.GetAgentHooks: WorkspacePath is required")
	}

	path := ompExtensionPath(cfg.WorkspacePath)
	if data, err := os.ReadFile(path); err == nil { //nolint:gosec // caller-owned workspace path
		if !strings.Contains(string(data), ompExtensionSentinel) {
			return fmt.Errorf("omp.GetAgentHooks: refusing to overwrite non-AO file at %s", path)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("omp.GetAgentHooks: read managed extension: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("omp.GetAgentHooks: create extension dir: %w", err)
	}
	if err := hookutil.AtomicWriteFile(path, []byte(ompActivityExtensionSource()), 0o600); err != nil {
		return fmt.Errorf("omp.GetAgentHooks: write extension: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(path), ompExtensionFileName); err != nil {
		return fmt.Errorf("omp.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

func appendOMPExtensionFlag(cmd *[]string, workspacePath string) {
	if strings.TrimSpace(workspacePath) == "" {
		return
	}
	*cmd = append(*cmd, "--extension", ompExtensionPath(workspacePath))
}

func ompActivityExtensionSource() string {
	return `// ` + ompExtensionSentinel + ` (do not edit)
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawnSync } from "node:child_process";

const HOOK_TIMEOUT_MS = 5_000;

function callHookSync(hookName: string, payload: Record<string, unknown>) {
  try {
    const result = spawnSync("ao", ["hooks", "omp", hookName], {
      input: JSON.stringify(payload) + "\n",
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
      timeout: HOOK_TIMEOUT_MS,
      windowsHide: true,
    });
    // The hook command records daemon delivery failures itself. Reporting is
    // best-effort and must never interrupt the OMP session.
    void result;
  } catch {
    // A missing AO executable or timeout must not interrupt OMP.
  }
}

function sessionID(ctx: any): string {
  return ctx.sessionManager.getSessionId() ?? "";
}

export default function (omp: ExtensionAPI) {
  omp.on("session_start", async (_event, ctx) => {
    callHookSync("session-start", { session_id: sessionID(ctx) });
  });
  omp.on("before_agent_start", async (event, ctx) => {
    callHookSync("user-prompt-submit", { session_id: sessionID(ctx), prompt: event.prompt });
  });
  omp.on("tool_approval_requested", async (event, ctx) => {
    callHookSync("permission-request", {
      session_id: sessionID(ctx),
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
    });
  });
  omp.on("tool_approval_resolved", async (event, ctx) => {
    callHookSync("permission-resolved", {
      session_id: sessionID(ctx),
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      approved: event.approved,
    });
  });
  omp.on("agent_end", async (event, ctx) => {
    if (!event.willContinue) {
      callHookSync("stop", { session_id: sessionID(ctx) });
    }
  });
  omp.on("session_shutdown", async (_event, ctx) => {
    callHookSync("session-end", { session_id: sessionID(ctx) });
  });
}
`
}
