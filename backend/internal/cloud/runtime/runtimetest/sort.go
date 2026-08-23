package runtimetest

import (
	"sort"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

func sortSandboxes(sandboxes []runtime.Sandbox) {
	sort.Slice(sandboxes, func(i, j int) bool { return sandboxes[i].ID < sandboxes[j].ID })
}

func sortStrings(values []string) { sort.Strings(values) }
