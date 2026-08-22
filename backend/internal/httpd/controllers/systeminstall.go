package controllers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/systeminstall"
)

// Installer is the controller-facing contract for real, async install runs
// against the fixed systeminstall.Target allowlist.
type Installer interface {
	Start(ctx context.Context, target systeminstall.Target) (systeminstall.Job, error)
	Status(ctx context.Context, target systeminstall.Target) (systeminstall.Job, error)
}

// SystemInstallController owns the /system/install routes.
type SystemInstallController struct {
	Installer Installer
}

// Register mounts the system install routes on the supplied router.
func (c *SystemInstallController) Register(r chi.Router) {
	r.Post("/system/install/{target}", c.start)
	r.Get("/system/install/{target}", c.status)
}

func (c *SystemInstallController) start(w http.ResponseWriter, r *http.Request) {
	if c.Installer == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/system/install/{target}")
		return
	}
	target, ok := parseInstallTarget(w, r)
	if !ok {
		return
	}
	job, err := c.Installer.Start(r.Context(), target)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusAccepted, job)
}

func (c *SystemInstallController) status(w http.ResponseWriter, r *http.Request) {
	if c.Installer == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/system/install/{target}")
		return
	}
	target, ok := parseInstallTarget(w, r)
	if !ok {
		return
	}
	job, err := c.Installer.Status(r.Context(), target)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, job)
}

// parseInstallTarget reads and validates the {target} path param against the
// fixed systeminstall allowlist before it ever reaches the service, so a path
// traversal attempt or other junk value gets a clean 400 here rather than
// being passed through.
func parseInstallTarget(w http.ResponseWriter, r *http.Request) (systeminstall.Target, bool) {
	target := systeminstall.Target(chi.URLParam(r, "target"))
	if !systeminstall.Valid(target) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "UNKNOWN_INSTALL_TARGET",
			"unknown install target", nil)
		return "", false
	}
	return target, true
}
