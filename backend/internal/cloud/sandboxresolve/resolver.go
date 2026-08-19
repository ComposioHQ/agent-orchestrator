// Package sandboxresolve selects the sandbox provider authorized for one
// sandbox row, without leaking provider credentials into domain records.
package sandboxresolve

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox"
)

// Resolver maps a sandbox row onto the provider that owns its compute.
type Resolver struct {
	nodeOps sandbox.Provider
	daytona sandbox.Provider
	docker  sandbox.Provider
}

// New creates a resolver backed by the providers enabled for this deployment.
func New(nodeOps, daytona, docker sandbox.Provider) *Resolver {
	return &Resolver{nodeOps: nodeOps, daytona: daytona, docker: docker}
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
	case sandbox.ProviderDocker:
		if record.ProviderConnectionID != "" {
			return nil, fmt.Errorf("per-organization Docker connections are not supported")
		}
		if r.docker == nil {
			return nil, fmt.Errorf("docker sandbox provider is not configured")
		}
		return r.docker, nil
	case sandbox.ProviderDaytona:
		if record.ProviderConnectionID != "" {
			return nil, fmt.Errorf("per-organization Daytona connections are not supported")
		}
		if r.daytona == nil {
			return nil, fmt.Errorf("daytona sandbox provider is not configured")
		}
		return r.daytona, nil
	case sandbox.ProviderECS:
		return nil, fmt.Errorf("sandbox provider %q is not configured", record.Provider)
	default:
		return nil, fmt.Errorf("unsupported sandbox provider %q", record.Provider)
	}
}
