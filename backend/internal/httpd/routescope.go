package httpd

import (
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

// RouteScope says where one route may be served.
type RouteScope string

const (
	// ScopeCloud marks a route the hosted control plane serves. Everything it
	// touches must come through an injected port — the durable store, the
	// runtime/sandbox plane — never the host the process happens to run on.
	ScopeCloud RouteScope = "cloud"

	// ScopeLocalOnly marks a route that only makes sense inside the desktop
	// daemon: it reads or writes the user's filesystem, drives a host process
	// (tmux/conpty, a preview server, an agent CLI), talks to the Electron
	// supervisor, or manages the LAN bridge to the user's phone. The cloud
	// mount refuses these.
	ScopeLocalOnly RouteScope = "local-only"
)

// RouteTransport says how long a route holds its connection open. It is a
// separate axis from RouteScope on purpose: "may the hosted plane serve this"
// and "does this run to completion in milliseconds or stay open for hours" are
// independent questions, and the second one is what infrastructure in front of
// the hosted plane has to be told about.
type RouteTransport string

const (
	// TransportBounded is an ordinary REST route. Inside /api/v1 these run
	// under the per-request timeout.
	TransportBounded RouteTransport = "bounded"

	// TransportStream is a long-lived connection — the terminal multiplex and
	// the server-sent event streams. These deliberately sit outside the
	// per-request timeout, which also means anything fronting them (load
	// balancer, API gateway) must permit long idle reads and must not buffer
	// the response. A stream accidentally registered inside the bounded group
	// would be cut off mid-connection, so
	// TestStreamRoutesBypassTheRequestTimeout checks this declaration against
	// the router's actual structure rather than trusting the table.
	TransportStream RouteTransport = "stream"
)

// RouteKey identifies one registered route by its HTTP method and its chi
// pattern (the pattern, not the concrete path, so `{sessionId}` classifies
// every session).
type RouteKey struct {
	Method  string
	Pattern string
}

// RouteClass is a route's scope, its transport, and — for a local-only route —
// the reason it cannot be hosted. The reason is required for local-only
// entries: it is what a future reader needs in order to decide whether a port
// has since made the route hostable, and TestRouteClassificationIsComplete
// enforces its presence.
type RouteClass struct {
	Scope     RouteScope
	Transport RouteTransport
	Reason    string

	// PendingPort names the injected port that will make this route hostable.
	// A non-empty value says the exclusion is temporary scaffolding, not a
	// decision that the hosted product does without this surface: the route is
	// refused today only because nothing can serve it yet.
	//
	// This distinction is load-bearing. Without it, "local-only" silently
	// doubles as both "this can never be hosted" and "this is not built yet",
	// and the second quietly becomes the first. Whether the hosted UX may
	// permanently lack a surface is a product decision, so
	// TestParityRequiredRoutesAreNeverPermanentlyLocal enforces it for the
	// views that must reach parity — project, session, terminal, chat, PR —
	// which may be ScopeCloud or pending, never permanently local.
	PendingPort string
}

// Stream reports whether the route holds a long-lived connection.
func (c RouteClass) Stream() bool { return c.Transport == TransportStream }

// Pending reports whether the route is destined for the hosted surface and
// waiting only on a port.
func (c RouteClass) Pending() bool { return c.PendingPort != "" }

func cloud() RouteClass { return RouteClass{Scope: ScopeCloud, Transport: TransportBounded} }

func cloudStream() RouteClass { return RouteClass{Scope: ScopeCloud, Transport: TransportStream} }

func local(reason string) RouteClass {
	return RouteClass{Scope: ScopeLocalOnly, Transport: TransportBounded, Reason: reason}
}

func localStream(reason string) RouteClass {
	return RouteClass{Scope: ScopeLocalOnly, Transport: TransportStream, Reason: reason}
}

// pending marks a route that belongs on the hosted surface and is refused only
// until port exists. Flipping it to cloud() is then a one-line change plus the
// composition that supplies the port.
func pending(port, reason string) RouteClass {
	return RouteClass{Scope: ScopeLocalOnly, Transport: TransportBounded, Reason: reason, PendingPort: port}
}

func pendingStream(port, reason string) RouteClass {
	return RouteClass{Scope: ScopeLocalOnly, Transport: TransportStream, Reason: reason, PendingPort: port}
}

// Reasons shared by whole route families. Naming them keeps the table below
// scannable and makes "why is this local-only" one grep away.
const (
	reasonHostProcess    = "drives a process on the user's machine (tmux/conpty shell, preview server, agent CLI)"
	reasonHostFilesystem = "reads or writes the user's filesystem (worktrees, data dir, agent usage logs)"
	reasonDesktopOnly    = "desktop/supervisor integration: local browser control, daemon control, dev import"
	reasonLANBridge      = "Connect Mobile LAN bridge and its locally-stored device registry"
	reasonCloudNative    = "the hosted plane serves its own equivalent under /api/cloud/v1"
)

// Ports that hosted equivalents of the currently-excluded surfaces are waiting
// on. Naming them here rather than inline keeps "what is actually blocking
// parity" a single grep, and keeps the pending entries below honest: a port
// that ships flips every route that named it.
const (
	portAttachmentStore    = "object-storage attachment port"
	portWorkspaceAdapter   = "runtime workspace adapter (file read/list/watch inside the sandbox)"
	portPreviewAdapter     = "runtime preview adapter (preview server lifecycle inside the sandbox)"
	portProjectProvisioner = "runtime project provisioner (clone/init inside the sandbox)"
	portAgentCatalog       = "sandbox-executing agent catalog (refresh/probe without a host CLI)"
)

// routeClasses is the single explicit classification of every route the router
// registers. It is deliberately exhaustive and deliberately not pattern-based:
// a prefix rule ("everything under /sessions is cloud") is exactly how a new
// local-filesystem route slips into the hosted surface unnoticed.
// TestRouteClassificationIsComplete walks the fully-wired local router and
// fails if any registered route is missing here, or if any entry here no longer
// corresponds to a registered route. Adding a route therefore forces an
// explicit decision about whether the hosted plane may serve it.
//
// The cloud mount is deny-by-default on top of that: an unclassified route
// (one that somehow reached production without the test running) is refused,
// not served.
var routeClasses = map[RouteKey]RouteClass{
	// ---- Daemon-process surface -------------------------------------------
	{"GET", "/healthz"}: local(reasonCloudNative),
	{"GET", "/readyz"}:  local(reasonCloudNative),
	{"GET", "/api/v1/desktop/sessions/{sessionId}/workspace"}: local(reasonDesktopOnly),
	{"GET", "/api/v1/system/requirements"}:                    local(reasonHostProcess),
	{"GET", "/api/v1/system/install/{target}"}:                local(reasonHostProcess),
	{"POST", "/api/v1/system/install/{target}"}:               local(reasonHostProcess),
	{"POST", "/shutdown"}:                                     local(reasonDesktopOnly + "; stops this daemon process"),
	// Terminal transport, and deliberately never hosted — settled architecture,
	// not a gap waiting on a port.
	//
	// This route is the daemon's own tmux/conpty mux. Against the hosted plane
	// the desktop does not use it and the control plane does not relay it:
	// Electron's main process dials the sandbox's authenticated published /mux
	// directly, using a one-time ticket and subprotocol obtained from the
	// control plane's terminal metadata. Relaying instead would put every byte
	// of every pane through the control plane for no security gain — the
	// ticket already scopes and expires the connection.
	//
	// /mux is the reserved path on both listeners a client can reach — this
	// loopback one and a sandbox's published one — so the desktop speaks one
	// path and one JSON frame contract either way, and Electron's main process
	// keeps a single terminal implementation behind the existing TerminalMux
	// IPC contract. What differs is which listener answers and whether a ticket
	// is required; see internal/terminal/muxproto for the handshake. The
	// control plane's /mux specifically must never be exposed publicly.
	//
	// Two invariants ride on this and are worth stating where the route is
	// classified. The ticket is one-time and control-plane-issued, so a leaked
	// URL is not a durable credential. And the provider URL, token and vendor
	// identity stop at Electron's main process: the renderer only ever sees
	// the existing TerminalMux IPC abstraction, so no sandbox provider detail
	// reaches a web context.
	//
	// Terminal parity is therefore met by a different transport, not by
	// hosting this route — see parityExemptPrefixes in the tests. When the
	// control-plane terminal-metadata endpoint that issues those tickets is
	// added, it is an ordinary bounded REST route and must be classified
	// ScopeCloud.
	{"GET", "/mux"}: localStream("hosted terminals connect straight to the sandbox's published /mux " +
		"with a one-time control-plane ticket; relaying through the control plane buys nothing"),
	{"POST", "/internal/telemetry/cli-invoked"}:     local("loopback-only CLI telemetry intake (localControlRequest)"),
	{"POST", "/internal/telemetry/cli-usage-error"}: local("loopback-only CLI telemetry intake (localControlRequest)"),

	// ---- Spec --------------------------------------------------------------
	{"GET", "/api/v1/openapi.yaml"}: cloud(),

	// ---- Agents ------------------------------------------------------------
	// Reads come off the store-backed catalog cache; refresh and probe execute
	// the agent CLIs installed on the host. They become cloud-eligible the day
	// the catalog is backed by a sandbox-executing implementation.
	{"GET", "/api/v1/agents"}:                         cloud(),
	{"GET", "/api/v1/agents/{agent}/models"}:          cloud(),
	{"POST", "/api/v1/agents/refresh"}:                pending(portAgentCatalog, "discovery executes the agent CLIs installed on the host"),
	{"POST", "/api/v1/agents/{agent}/models/refresh"}: pending(portAgentCatalog, "discovery executes the agent CLIs installed on the host"),
	{"POST", "/api/v1/agents/{agent}/probe"}:          pending(portAgentCatalog, "probes the agent CLI installed on the host"),

	// ---- Projects ----------------------------------------------------------
	// Registration and settings are store-backed; clone and initialize write a
	// git checkout into a local path.
	{"GET", "/api/v1/projects"}:             cloud(),
	{"POST", "/api/v1/projects"}:            cloud(),
	{"GET", "/api/v1/projects/{id}"}:        cloud(),
	{"PUT", "/api/v1/projects/{id}"}:        cloud(),
	{"PUT", "/api/v1/projects/{id}/config"}: cloud(),
	{"DELETE", "/api/v1/projects/{id}"}:     cloud(),
	{"POST", "/api/v1/projects/clone"}:      pending(portProjectProvisioner, "clones into the local filesystem; hosted clones happen inside the sandbox"),
	{"POST", "/api/v1/projects/initialize"}: pending(portProjectProvisioner, "initializes on the local filesystem; hosted init happens inside the sandbox"),

	// ---- Sessions ----------------------------------------------------------
	{"GET", "/api/v1/sessions"}:                                                                        cloud(),
	{"POST", "/api/v1/sessions"}:                                                                       cloud(),
	{"POST", "/api/v1/sessions/cleanup"}:                                                               cloud(),
	{"GET", "/api/v1/sessions/{sessionId}"}:                                                            cloud(),
	{"PATCH", "/api/v1/sessions/{sessionId}"}:                                                          cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/kill"}:                                                      cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/restore"}:                                                   cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/rollback"}:                                                  cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/send"}:                                                      cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/activity"}:                                                  cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/pin"}:                                                       cloud(),
	{"DELETE", "/api/v1/sessions/{sessionId}/pin"}:                                                     cloud(),
	{"PATCH", "/api/v1/sessions/{sessionId}/merge-policy"}:                                             cloud(),
	{"PATCH", "/api/v1/sessions/{sessionId}/auto-inject-review"}:                                       cloud(),
	{"PATCH", "/api/v1/sessions/{sessionId}/auto-inject-ci"}:                                           cloud(),
	{"PUT", "/api/v1/sessions/{sessionId}/reviewer"}:                                                   cloud(),
	{"PUT", "/api/v1/sessions/{sessionId}/auto-review"}:                                                cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/resume-agent"}:                                              cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/switch-agent"}:                                              cloud(),
	{"GET", "/api/v1/sessions/{sessionId}/agent-switches"}:                                             cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/agent-switches/{switchId}/recover"}:                         cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/agent-switches/{switchId}/handoff"}:                         cloud(),
	{"GET", "/api/v1/sessions/{sessionId}/interface-transition"}:                                       cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/interface-transition"}:                                      cloud(),
	{"DELETE", "/api/v1/sessions/{sessionId}/interface-transition"}:                                    cloud(),
	{"PUT", "/api/v1/sessions/{sessionId}/interface-transition/{transitionId}/notice-acknowledgement"}: cloud(),

	// Attachments land in the local data dir; the workspace and preview
	// surfaces read the local worktree and drive a local dev server.
	{"POST", "/api/v1/sessions/{sessionId}/attachments"}: pending(portAttachmentStore,
		"attachment staging writes the local data dir; hosted staging needs an object-storage port"),
	{"GET", "/api/v1/sessions/{sessionId}/workspace/files"}: pending(portWorkspaceAdapter,
		"reads the local worktree; hosted reads go through the runtime workspace adapter"),
	{"GET", "/api/v1/sessions/{sessionId}/workspace/file"}: pending(portWorkspaceAdapter,
		"reads the local worktree; hosted reads go through the runtime workspace adapter"),
	{"GET", "/api/v1/sessions/{sessionId}/workspace/file/blob"}: pending(portWorkspaceAdapter,
		"reads binary content from the local worktree; hosted reads go through the runtime workspace adapter"),
	{"GET", "/api/v1/sessions/{sessionId}/workspace/events"}: pendingStream(portWorkspaceAdapter,
		"watches the local worktree; hosted watches go through the runtime workspace adapter"),
	{"GET", "/api/v1/sessions/{sessionId}/preview"}:           pending(portPreviewAdapter, "preview state is local; hosted preview goes through the runtime preview adapter"),
	{"POST", "/api/v1/sessions/{sessionId}/preview"}:          pending(portPreviewAdapter, "preview state is local; hosted preview goes through the runtime preview adapter"),
	{"DELETE", "/api/v1/sessions/{sessionId}/preview"}:        pending(portPreviewAdapter, "preview state is local; hosted preview goes through the runtime preview adapter"),
	{"GET", "/api/v1/sessions/{sessionId}/preview/server"}:    pending(portPreviewAdapter, "drives a local preview server process; hosted lifecycle is the runtime preview adapter"),
	{"POST", "/api/v1/sessions/{sessionId}/preview/server"}:   pending(portPreviewAdapter, "drives a local preview server process; hosted lifecycle is the runtime preview adapter"),
	{"DELETE", "/api/v1/sessions/{sessionId}/preview/server"}: pending(portPreviewAdapter, "drives a local preview server process; hosted lifecycle is the runtime preview adapter"),
	{"GET", "/api/v1/sessions/{sessionId}/preview/files/*"}:   pending(portPreviewAdapter, "serves files from the local worktree; hosted serving goes through the runtime preview adapter"),

	// ---- Orchestrators -----------------------------------------------------
	{"GET", "/api/v1/orchestrators"}:           cloud(),
	{"POST", "/api/v1/orchestrators"}:          cloud(),
	{"POST", "/api/v1/orchestrators/delegate"}: cloud(),
	{"GET", "/api/v1/orchestrators/{id}"}:      cloud(),

	// ---- Conversations (chat) ----------------------------------------------
	{"GET", "/api/v1/sessions/{sessionId}/conversation"}:                                cloud(),
	{"GET", "/api/v1/sessions/{sessionId}/conversation/models"}:                         cloud(),
	{"GET", "/api/v1/sessions/{sessionId}/conversation/skills"}:                         cloud(),
	{"GET", "/api/v1/sessions/{sessionId}/conversation/config-options"}:                 cloud(),
	{"PATCH", "/api/v1/sessions/{sessionId}/conversation/config-options/{configId}"}:    cloud(),
	{"PATCH", "/api/v1/sessions/{sessionId}/conversation/settings"}:                     cloud(),
	{"PUT", "/api/v1/sessions/{sessionId}/conversation/title"}:                          cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/messages"}:                      cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/steer"}:                         cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/interrupt"}:                     cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/compact"}:                       cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/mcp/reload"}:                    cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/approvals/{requestId}/resolve"}: cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/inputs/{requestId}/resolve"}:    cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/branches/{branchId}/activate"}:  cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/turns/{turnId}/edit"}:           cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/turns/{turnId}/rollback"}:       cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/conversation/turns/{turnId}/steer"}:          cloud(),

	// ---- Reviews and PRs ---------------------------------------------------
	{"GET", "/api/v1/sessions/{sessionId}/reviews"}:                   cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/reviews/trigger"}:          cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/reviews/cancel"}:           cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/reviews/kill"}:             cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/reviews/restore"}:          cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/reviews/submit"}:           cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/reviews/switch"}:           cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/reviews/rerequest"}:        cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/reviews/comments/resolve"}: cloud(),
	{"POST", "/api/v1/reviews/{reviewSessionID}/activity"}:            cloud(),
	{"GET", "/api/v1/sessions/{sessionId}/pr"}:                        cloud(),
	{"POST", "/api/v1/sessions/{sessionId}/pr/claim"}:                 cloud(),
	{"POST", "/api/v1/prs/{id}/merge"}:                                cloud(),
	{"POST", "/api/v1/prs/{id}/resolve-comments"}:                     cloud(),

	// ---- Notifications, events, settings -----------------------------------
	{"GET", "/api/v1/notifications"}:                cloud(),
	{"PATCH", "/api/v1/notifications/{id}"}:         cloud(),
	{"POST", "/api/v1/notifications/read-all"}:      cloud(),
	{"GET", "/api/v1/notifications/stream"}:         cloudStream(),
	{"GET", "/api/v1/events"}:                       cloudStream(),
	{"GET", "/api/v1/settings"}:                     cloud(),
	{"PATCH", "/api/v1/settings/session-interface"}: cloud(),

	// ---- Usage -------------------------------------------------------------
	// Usage rows are collected by tailing ~/.claude and ~/.codex on the host.
	{"GET", "/api/v1/usage/sessions"}:             local(reasonHostFilesystem),
	{"GET", "/api/v1/usage/sessions/{sessionId}"}: local(reasonHostFilesystem),

	// ---- Shell terminals ---------------------------------------------------
	{"GET", "/api/v1/shell-terminals"}:               local(reasonHostProcess),
	{"POST", "/api/v1/shell-terminals"}:              local(reasonHostProcess),
	{"PATCH", "/api/v1/shell-terminals/{handleId}"}:  local(reasonHostProcess),
	{"DELETE", "/api/v1/shell-terminals/{handleId}"}: local(reasonHostProcess),

	// ---- Local browser control ---------------------------------------------
	{"GET", "/api/v1/browser/status"}:    local(reasonDesktopOnly),
	{"POST", "/api/v1/browser/commands"}: local(reasonDesktopOnly),

	// ---- Import / dev import -----------------------------------------------
	{"GET", "/api/v1/import"}:               local(reasonHostFilesystem),
	{"POST", "/api/v1/import"}:              local(reasonHostFilesystem),
	{"POST", "/api/v1/dev/import-projects"}: local(reasonDesktopOnly),

	// ---- Connect Mobile and push -------------------------------------------
	{"GET", "/api/v1/mobile/status"}:                 local(reasonLANBridge),
	{"POST", "/api/v1/mobile/enable"}:                local(reasonLANBridge),
	{"POST", "/api/v1/mobile/disable"}:               local(reasonLANBridge),
	{"POST", "/api/v1/mobile/regenerate"}:            local(reasonLANBridge),
	{"POST", "/api/v1/mobile/secure-pairing"}:        local(reasonLANBridge),
	{"GET", "/api/v1/mobile/devices"}:                local(reasonLANBridge),
	{"PATCH", "/api/v1/mobile/devices/{installId}"}:  local(reasonLANBridge),
	{"DELETE", "/api/v1/mobile/devices/{installId}"}: local(reasonLANBridge),
	{"POST", "/api/v1/push/devices"}:                 local(reasonLANBridge),
	{"DELETE", "/api/v1/push/devices/{token}"}:       local(reasonLANBridge),
	{"DELETE", "/api/v1/push/pairings/{id}"}:         local(reasonLANBridge),
}

// ClassifyRoute returns the recorded class for one method + chi pattern.
// The bool is false when the route is not classified at all, which the cloud
// mount treats as "deny".
func ClassifyRoute(method, pattern string) (RouteClass, bool) {
	class, ok := routeClasses[RouteKey{Method: strings.ToUpper(method), Pattern: pattern}]
	return class, ok
}

// CloudStreamRoutes returns the hosted plane's long-lived routes. Anything
// fronting the control plane — load balancer, API gateway, proxy — has to
// allow long idle reads on exactly these and must not buffer them.
func CloudStreamRoutes() []RouteKey {
	var keys []RouteKey
	for key, class := range routeClasses {
		if class.Scope == ScopeCloud && class.Stream() {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Pattern != keys[j].Pattern {
			return keys[i].Pattern < keys[j].Pattern
		}
		return keys[i].Method < keys[j].Method
	})
	return keys
}

// RouteClasses returns a copy of the classification table, for tests and for
// operators who want to render the hosted surface.
func RouteClasses() map[RouteKey]RouteClass {
	out := make(map[RouteKey]RouteClass, len(routeClasses))
	for key, class := range routeClasses {
		out[key] = class
	}
	return out
}

// NewCloudAPIHandler builds the application API for the hosted control plane.
//
// It mounts the same API object the local daemon mounts — the same controllers
// registered by the same API.Register call — so the two surfaces cannot drift.
// What differs is composition, not code: deps carry cloud implementations of
// the storage and runtime ports, and the returned handler is wrapped in a
// classification guard that refuses every route not marked ScopeCloud.
//
// Deliberately not mounted here: health probes (the control plane serves its
// own), daemon control, CLI telemetry intake, the Connect Mobile bridge, and
// the terminal mux. Those are local-only by classification too, so they are
// refused twice over — once by never being registered, once by the guard.
//
// There is deliberately no terminal relay parameter. Hosted terminals do not
// pass through the control plane at all: the desktop dials the sandbox's own
// authenticated published /mux with a one-time control-plane-issued ticket.
// See the /mux entry in routeClasses.
//
// The caller is responsible for authentication and for putting a tenant
// identity on the request context before this handler runs; the guard does not
// authenticate.
func NewCloudAPIHandler(cfg config.Config, log *slog.Logger, deps APIDeps) http.Handler {
	log = loggerOrDefault(log)
	deps = normalizeAPIDeps(deps, log)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(requestLogger(log, deps.Telemetry))
	r.Use(recoverTelemetry(log, deps.Telemetry))
	r.Use(corsMiddleware(cfg.AllowedOrigins))
	r.NotFound(notFoundJSON)
	r.MethodNotAllowed(methodNotAllowedJSON)

	NewAPI(cfg, deps).Register(r)

	return CloudScopeGuard(r)
}

// CloudScopeGuard wraps a router so only ScopeCloud routes reach it.
//
// The check runs before the router, against a throwaway route context, so it
// sees the chi pattern the request would match without disturbing the real
// routing pass. Deny-by-default: a route with no entry in routeClasses is
// refused exactly like an explicitly local-only one, so a route added without
// a classification fails closed in production as well as failing the test.
//
// A request that matches nothing falls through to the router's own 404/405
// envelope rather than being reported as "not available", so a typo stays a
// typo.
func CloudScopeGuard(router chi.Router) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rctx := chi.NewRouteContext()
		if router.Match(rctx, r.Method, routeMatchPath(r)) {
			if class, ok := ClassifyRoute(r.Method, rctx.RoutePattern()); !ok || class.Scope != ScopeCloud {
				envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "ROUTE_NOT_AVAILABLE",
					r.Method+" "+r.URL.Path+" is not available on the hosted control plane", nil)
				return
			}
		}
		router.ServeHTTP(w, r)
	})
}

// routeMatchPath mirrors how chi picks the path it routes on, so the dry-run
// match resolves the same pattern the real routing pass will.
func routeMatchPath(r *http.Request) string {
	if r.URL.RawPath != "" {
		return r.URL.RawPath
	}
	return r.URL.Path
}
