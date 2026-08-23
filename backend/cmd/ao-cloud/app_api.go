package main

import (
	"log/slog"
	"net/http"

	cloudconfig "github.com/aoagents/agent-orchestrator/backend/internal/cloud/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

// buildAppAPI composes the shared AO application API for the hosted control
// plane: the same controllers the desktop daemon mounts, narrowed to the
// routes classified ScopeCloud, and served behind the control plane's
// authentication and tenant resolution.
//
// This is the one injection point for the hosted composition. APIDeps is
// deliberately empty today: every field is an interface, so each controller
// answers 501 NOT_IMPLEMENTED with its OpenAPI-backed envelope until an
// implementation is supplied. That makes the route surface, the auth chain and
// the tenant plumbing deployable and verifiable ahead of the ports themselves,
// and leaves exactly one place to fill in:
//
//   - storage ports (sessions, projects, notifications, reviews, PRs, chat,
//     settings, CDC) — Postgres-backed, org-scoped by reading the request's
//     tenant identity from internal/tenant
//   - runtime/sandbox ports (session spawn, kill, agent messaging) — the
//     compute plane; terminal streams do not ride this handler, they ride the
//     compute plane's own authenticated published listener
//
// Nothing local-only belongs here. The classification in internal/httpd
// refuses those routes even if a local implementation were injected by
// mistake, so a wrong entry below cannot expose the user's filesystem or a
// host process to a hosted tenant.
func buildAppAPI(cfg cloudconfig.Config, logger *slog.Logger) http.Handler {
	if !cfg.AppAPIEnabled {
		return nil
	}
	return httpd.NewCloudAPIHandler(
		//nolint:exhaustruct // see below: the hosted composition is filled in as ports land
		config.Config{
			// The hosted plane has no data dir: it must never resolve a path
			// on the machine the process happens to run on. Every route that
			// would need one is classified local-only and refused.
			RequestTimeout: config.DefaultRequestTimeout,
		},
		logger,
		// No terminal relay yet. When the runtime adapter can back one, pass it
		// here and flip /mux to cloudStream() in internal/httpd/routescope.go —
		// the desktop then connects to the control plane's own /mux, never to a
		// provider-issued sandbox URL.
		nil,
		httpd.APIDeps{},
	)
}
