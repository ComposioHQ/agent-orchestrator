package muse

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
)

// ResolveBinary resolves the executable path for the plugin.
func (p *Plugin) ResolveBinary(ctx context.Context) (string, error) {
	return p.museBinary(ctx)
}

// ResolveBinaryPresence resolves a local Muse executable without running its
// version-signature check. Full resolution still validates Muse before launch.
func (p *Plugin) ResolveBinaryPresence(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, museBinarySpec)
}
