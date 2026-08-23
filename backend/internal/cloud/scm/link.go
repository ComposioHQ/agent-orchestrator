package scm

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// InstallRedirect describes the short-lived GitHub App installation redirect.
type InstallRedirect struct {
	InstallURL string
	ExpiresAt  time.Time
}

// CallbackParams carries the state and installation identity returned by GitHub.
type CallbackParams struct {
	State                  string
	ExternalInstallationID int64
}

// LinkService is implemented by the GitHub App installation boundary. The
// transport depends only on this narrow contract.
type LinkService interface {
	StartInstall(context.Context, tenant.Identity) (InstallRedirect, error)
	CompleteInstall(context.Context, CallbackParams) (domain.SCMInstallation, error)
}
