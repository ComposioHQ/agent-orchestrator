package main

import (
	"log/slog"
	"net/http"

	cloudconfig "github.com/aoagents/agent-orchestrator/backend/internal/cloud/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

// buildAppAPI composes the shared AO application API for the hosted control
// plane: the same controllers the desktop daemon mounts, narrowed to the
// routes classified ScopeCloud, and served behind the control plane's
// authentication and tenant resolution.
//
// This is the one injection point for the hosted composition. Durable project
// and session reads are backed by the tenant-scoped PostgreSQL store. Commands
// that require the compute plane still answer 501 until a SessionExecution is
// injected; they never fall back to local process or filesystem adapters.
//
//   - storage ports (sessions, projects, notifications, reviews, PRs, chat,
//     settings, CDC) — Postgres-backed, org-scoped by reading the request's
//     tenant identity from internal/tenant
//   - runtime/sandbox ports (session spawn, kill, agent messaging) — the
//     compute plane. Terminal streams never ride this handler: the desktop
//     dials the sandbox's authenticated published /mux directly with a
//     one-time control-plane-issued ticket. The endpoint that issues those
//     tickets is ordinary bounded REST and belongs on this handler; the
//     terminal bytes do not.
//
// Nothing local-only belongs here. The classification in internal/httpd
// refuses those routes even if a local implementation were injected by
// mistake, so a wrong entry below cannot expose the user's filesystem or a
// host process to a hosted tenant.
func buildAppAPI(cfg cloudconfig.Config, logger *slog.Logger, store hostedAppStore) http.Handler {
	if !cfg.AppAPIEnabled {
		return nil
	}
	projects := newHostedProjectManager(store)
	sessions := sessionsvc.NewWithDeps(sessionsvc.Deps{
		Manager: &unavailableHostedSessionCommands{},
		Store:   hostedSessionStore{hostedAppStore: store},
		Logger:  logger,
	})
	return httpd.NewCloudAPIHandler(
		//nolint:exhaustruct // see below: the hosted composition is filled in as ports land
		config.Config{
			// The hosted plane has no data dir: it must never resolve a path
			// on the machine the process happens to run on. Every route that
			// would need one is classified local-only and refused.
			RequestTimeout: config.DefaultRequestTimeout,
		},
		logger,
		httpd.APIDeps{Projects: projectsvc.Manager(projects), Sessions: sessions},
	)
}
