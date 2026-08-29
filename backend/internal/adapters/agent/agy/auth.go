package agy

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/modelcatalog"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// discoverModels is a seam over modelcatalog.Discover so tests can substitute
// a fake result instead of executing the real Antigravity CLI.
var discoverModels = modelcatalog.Discover

// AuthStatus returns the plugin's local authentication status.
//
// Antigravity authenticates through its OS keyring and browser sign-in, and
// the official CLI exposes no documented non-interactive credential file or
// status/whoami command, so auth cannot be read directly. `agy models` fetches
// its catalog from a remote service and only succeeds when the CLI is
// authenticated, so the same discovery AO already runs for the model catalog
// (modelcatalog.Discover) doubles as a safe, already-exercised proxy signal: a
// successful run proves the session is authorized. A failed run is reported as
// Unknown rather than Unauthorized, because the failure could equally mean
// "not logged in", "offline", or a transient CLI hiccup, and this adapter has
// no documented way to tell those apart without guessing at the CLI's error
// text.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.ResolveBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if _, err := discoverModels(ctx, adapterID, binary, "", nil); err != nil {
		return ports.AgentAuthStatusUnknown, nil
	}
	return ports.AgentAuthStatusAuthorized, nil
}
