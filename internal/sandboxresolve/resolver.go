// Package sandboxresolve selects the sandbox provider authorized for one
// sandbox row, without leaking provider credentials into domain records.
package sandboxresolve

import (
	"context"
	"fmt"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/sandbox"
)

// Resolver maps a sandbox row onto the provider that owns its compute.
type Resolver struct {
	nodeOps sandbox.Provider
}

// New creates a resolver backed by the platform-default NodeOps provider.
func New(nodeOps sandbox.Provider) *Resolver {
	return &Resolver{nodeOps: nodeOps}
}

// Resolve returns the provider authorized for sandbox. The reconciler never
// learns which provider it is talking to.
func (r *Resolver) Resolve(_ context.Context, record domain.Sandbox) (sandbox.Provider, error) {
	switch record.Provider {
	case sandbox.ProviderNodeOps:
		if record.ProviderConnectionID != "" {
			// Bring-your-own-NodeOps credentials live encrypted in
			// ao_provider_connections. Decrypting them needs the secrets
			// cipher, which this slice does not build.
			return nil, fmt.Errorf(
				"per-organization NodeOps credentials are not supported yet (connection %s)",
				record.ProviderConnectionID,
			)
		}
		if r.nodeOps == nil {
			return nil, fmt.Errorf("nodeops sandbox provider is not configured")
		}
		return r.nodeOps, nil
	case sandbox.ProviderDocker, sandbox.ProviderDaytona, sandbox.ProviderECS:
		return nil, fmt.Errorf("sandbox provider %q is not configured", record.Provider)
	default:
		return nil, fmt.Errorf("unsupported sandbox provider %q", record.Provider)
	}
}
