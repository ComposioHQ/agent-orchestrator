package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/systemcheck"
)

// SystemChecker is the controller-facing contract for the lightweight startup
// preflight the desktop loading screen runs before showing the board.
type SystemChecker interface {
	CheckStartup(ctx context.Context) (systemcheck.Report, error)
}

// SystemController owns the /system routes.
type SystemController struct {
	Checks SystemChecker
}

// Register mounts the system requirements route on the supplied router.
func (c *SystemController) Register(r chi.Router) {
	r.Get("/system/requirements", c.requirements)
}

func (c *SystemController) requirements(w http.ResponseWriter, r *http.Request) {
	if c.Checks == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/system/requirements")
		return
	}
	report, err := c.Checks.CheckStartup(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, report)
}
