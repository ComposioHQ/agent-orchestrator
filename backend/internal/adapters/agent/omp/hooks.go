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

// GetAgentHooks installs AO's project-local OMP extension. Launch and restore
// pass it explicitly with --extension, so activity reporting does not depend on
// OMP's project auto-discovery.
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

// UninstallHooks removes AO's OMP activity extension when it carries the AO
// sentinel. A missing file, or a same-named file without the sentinel, is a no-op.
func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return errors.New("omp.UninstallHooks: workspacePath is required")
	}

	path := ompExtensionPath(workspacePath)
	managed, err := isAOManagedExtension(path)
	if err != nil {
		return fmt.Errorf("omp.UninstallHooks: %w", err)
	}
	if !managed {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("omp.UninstallHooks: remove extension: %w", err)
	}
	return nil
}

// AreHooksInstalled reports whether AO's OMP activity extension is present.
// A missing file, or a same-named file without the AO sentinel, means none.
func (p *Plugin) AreHooksInstalled(ctx context.Context, workspacePath string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return false, errors.New("omp.AreHooksInstalled: workspacePath is required")
	}
	managed, err := isAOManagedExtension(ompExtensionPath(workspacePath))
	if err != nil {
		return false, fmt.Errorf("omp.AreHooksInstalled: %w", err)
	}
	return managed, nil
}

func appendOmpExtensionFlag(cmd *[]string, workspacePath string) {
	if strings.TrimSpace(workspacePath) == "" {
		return
	}
	*cmd = append(*cmd, "--extension", ompExtensionPath(workspacePath))
}

func isAOManagedExtension(path string) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // path built from caller-owned workspace dir
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read %s: %w", path, err)
	}
	return strings.Contains(string(data), ompExtensionSentinel), nil
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
    // AO's hook command records daemon delivery failures itself. A missing AO
    // executable or timeout is deliberately ignored so OMP remains usable.
    void result;
  } catch {
    // Activity reporting is best-effort and must never interrupt OMP.
  }
}

function sessionID(ctx: any): string {
  return ctx.sessionManager.getSessionId() ?? "";
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    callHookSync("session-start", { session_id: sessionID(ctx) });
  });
  pi.on("before_agent_start", async (event, ctx) => {
    callHookSync("user-prompt-submit", { session_id: sessionID(ctx), prompt: event.prompt });
  });
  // session_stop is OMP's settle event: the main-agent turn is about to go
  // idle. agent_end can fire before retries or compaction, so stop waits here.
  pi.on("session_stop", async (_event, ctx) => {
    callHookSync("stop", { session_id: sessionID(ctx) });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    callHookSync("session-end", { session_id: sessionID(ctx) });
  });
}
`
}
