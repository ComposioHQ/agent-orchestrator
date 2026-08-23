package credentials

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// ScopeFromContext reuses the control plane's one tenant identity type.
func ScopeFromContext(ctx context.Context) (tenant.Identity, error) {
	scope, ok := tenant.FromContext(ctx)
	if !ok {
		return tenant.Identity{}, tenant.ErrNoTenant
	}
	return scope, nil
}

func encryptionContext(scope tenant.Identity, provider string) map[string]string {
	return map[string]string{
		"ao:org-id":   scope.OrgID,
		"ao:user-id":  scope.UserID,
		"ao:provider": provider,
	}
}

func associatedData(context map[string]string) []byte {
	return []byte(fmt.Sprintf("ao-credential-v1\x00%s\x00%s\x00%s", context["ao:org-id"], context["ao:user-id"], context["ao:provider"]))
}
