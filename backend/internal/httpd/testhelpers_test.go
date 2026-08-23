package httpd

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
)

// newTestRouter builds a router with empty API and control deps. It is the
// test-only convenience that used to be the exported NewRouter wrapper; keeping
// it here leaves the package's exported surface to the production constructors.
func newTestRouter(cfg config.Config, log *slog.Logger, termMgr TerminalMux) chi.Router {
	return NewRouterWithControl(cfg, log, termMgr, APIDeps{}, ControlDeps{})
}
