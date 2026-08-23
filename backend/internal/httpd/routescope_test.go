package httpd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// stubTerminalMux stands in for the host terminal manager so /mux mounts.
type stubTerminalMux struct{}

func (stubTerminalMux) Serve(context.Context, terminal.WSConn) {}

type stubRoster struct{}

func (stubRoster) List() []mobilebridge.PushDevice { return nil }
func (stubRoster) SetMuted(string, bool) error     { return nil }
func (stubRoster) Delete(string) error             { return nil }

type stubLiveSet struct{}

func (stubLiveSet) Live() map[string]bool             { return nil }
func (stubLiveSet) LastSeen(string) (time.Time, bool) { return time.Time{}, false }

type stubSink struct{}

func (stubSink) Emit(context.Context, ports.TelemetryEvent) {}
func (stubSink) Close(context.Context) error                { return nil }

// fullyWiredRouter mounts every conditional surface — /mux, /shutdown, the CLI
// telemetry intake, the Connect Mobile bridge and the device roster — so the
// walk below sees the daemon's complete route set rather than the subset a
// zero-valued APIDeps happens to register.
func fullyWiredRouter(t *testing.T) chi.Router {
	t.Helper()
	return NewRouterWithControl(
		config.Config{DataDir: t.TempDir()},
		discardLogger(),
		stubTerminalMux{},
		APIDeps{
			Telemetry:    stubSink{},
			Mobile:       &controllers.MobileController{},
			DeviceRoster: stubRoster{},
			DeviceLive:   stubLiveSet{},
		},
		ControlDeps{RequestShutdown: func() {}},
	)
}

func walkRoutes(t *testing.T, router chi.Router) map[RouteKey]bool {
	t.Helper()
	found := map[RouteKey]bool{}
	err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		found[RouteKey{Method: strings.ToUpper(method), Pattern: route}] = true
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	if len(found) == 0 {
		t.Fatal("no routes mounted — router wiring changed?")
	}
	return found
}

// TestRouteClassificationIsComplete is the guard that makes the hosted surface
// a decision rather than an accident: every route the daemon registers must
// carry an explicit cloud/local-only classification, and the table may not
// name routes that no longer exist. A new route fails this test until someone
// states where it may be served.
func TestRouteClassificationIsComplete(t *testing.T) {
	mounted := walkRoutes(t, fullyWiredRouter(t))

	var unclassified []string
	for key := range mounted {
		if _, ok := routeClasses[key]; !ok {
			unclassified = append(unclassified, key.Method+" "+key.Pattern)
		}
	}
	sort.Strings(unclassified)
	if len(unclassified) > 0 {
		t.Errorf("routes registered but not classified in routeClasses (add each as cloud() or local(reason)):\n  %s",
			strings.Join(unclassified, "\n  "))
	}

	var stale []string
	for key := range routeClasses {
		if !mounted[key] {
			stale = append(stale, key.Method+" "+key.Pattern)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("routeClasses names routes the router no longer registers:\n  %s", strings.Join(stale, "\n  "))
	}
}

// TestStreamRoutesBypassTheRequestTimeout checks the transport column against
// the router's own structure instead of trusting the table.
//
// API.Register puts bounded REST routes inside a Group carrying the
// per-request Timeout middleware and registers the long-lived streams outside
// it. chi.Walk hands back each route's accumulated middleware chain, so the
// two tiers are distinguishable at runtime: a route inside the bounded group
// carries strictly more middleware than one outside it. A stream that drifted
// into the bounded group would be severed mid-connection at the timeout, and a
// bounded route that drifted out would lose its deadline — this catches both
// without hard-coding a middleware count.
func TestStreamRoutesBypassTheRequestTimeout(t *testing.T) {
	depth := map[RouteKey]int{}
	err := chi.Walk(fullyWiredRouter(t), func(method, route string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		depth[RouteKey{Method: strings.ToUpper(method), Pattern: route}] = len(middlewares)
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}

	tiers := map[int]bool{}
	for _, n := range depth {
		tiers[n] = true
	}
	if len(tiers) != 2 {
		t.Fatalf("expected exactly two middleware tiers (bounded group vs outside it), got %d: %v", len(tiers), tiers)
	}
	bounded := 0
	for n := range tiers {
		if n > bounded {
			bounded = n
		}
	}

	for key, class := range routeClasses {
		inBoundedGroup := depth[key] == bounded
		switch {
		case class.Stream() && inBoundedGroup:
			t.Errorf("%s %s is declared a stream but is registered under the request timeout; "+
				"it would be cut off mid-connection", key.Method, key.Pattern)
		case !class.Stream() && !inBoundedGroup && strings.HasPrefix(key.Pattern, "/api/v1/") &&
			key.Pattern != "/api/v1/openapi.yaml" && !strings.HasPrefix(key.Pattern, "/api/v1/mobile"):
			t.Errorf("%s %s is declared bounded but is registered outside the request timeout; "+
				"either give it a deadline or classify it as a stream", key.Method, key.Pattern)
		}
	}
}

// CloudStreamRoutes is what the deploy has to configure long idle reads for,
// so it must list every hosted stream and nothing that is not one.
func TestCloudStreamRoutesListsHostedStreamsOnly(t *testing.T) {
	got := map[RouteKey]bool{}
	for _, key := range CloudStreamRoutes() {
		got[key] = true
	}
	want := map[RouteKey]bool{
		{Method: http.MethodGet, Pattern: "/api/v1/events"}:               true,
		{Method: http.MethodGet, Pattern: "/api/v1/notifications/stream"}: true,
	}
	for key := range want {
		if !got[key] {
			t.Errorf("CloudStreamRoutes omits %s %s", key.Method, key.Pattern)
		}
	}
	for key := range got {
		if !want[key] {
			t.Errorf("CloudStreamRoutes includes unexpected %s %s — if this is a new hosted stream, "+
				"the deploy's idle-timeout and buffering settings need it too", key.Method, key.Pattern)
		}
	}
}

// parityExemptPrefixes are the surfaces the hosted product may permanently do
// without. Everything else that the desktop shows must reach the hosted plane
// eventually — either already cloud-mounted, or local-only with a named port
// blocking it.
//
// Usage is exempt by explicit product decision: the figures come from tailing
// the agent CLIs' logs on the user's own machine, and the UI handles the
// surface being unavailable. The rest are desktop and device integrations that
// have no hosted meaning at all.
//
// /mux is exempt for a different reason, worth keeping distinct: hosted
// terminals reach full parity, just not through this route. The desktop dials
// the sandbox's own authenticated published /mux with a one-time
// control-plane-issued ticket rather than having the control plane relay every
// pane byte. Exempt here means "parity is delivered by another transport", not
// "the hosted product does without terminals" — see the /mux entry in
// routeClasses and TestHostedTerminalsBypassTheControlPlane below.
var parityExemptPrefixes = []string{
	"/healthz",
	"/readyz",
	"/shutdown",
	"/mux",
	"/internal/telemetry/",
	"/api/v1/usage/",
	"/api/v1/mobile",
	"/api/v1/push/",
	"/api/v1/browser/",
	"/api/v1/import",
	"/api/v1/dev/",
	"/api/v1/shell-terminals",
}

func parityExempt(pattern string) bool {
	for _, prefix := range parityExemptPrefixes {
		if strings.HasPrefix(pattern, prefix) {
			return true
		}
	}
	return false
}

// TestParityRequiredRoutesAreNeverPermanentlyLocal is the guard against the
// classification quietly becoming a product decision.
//
// "Local-only" has to mean two different things — this can never be hosted,
// and this is not built yet — and without a distinction the second decays into
// the first: a route excluded as scaffolding stays excluded because nothing
// ever forces the question again. So every route outside the explicitly exempt
// surfaces must be either cloud-mounted or local-only with a named blocking
// port. Shipping that port is then the trigger to flip it.
//
// Adding a prefix to parityExemptPrefixes is how you record "the hosted
// product does without this" — deliberately a visible, reviewable edit rather
// than something achieved by leaving a reason string vague.
func TestParityRequiredRoutesAreNeverPermanentlyLocal(t *testing.T) {
	for key, class := range routeClasses {
		if class.Scope == ScopeCloud || parityExempt(key.Pattern) {
			continue
		}
		if !class.Pending() {
			t.Errorf("%s %s is permanently local-only but is not an exempt surface; "+
				"either name the port that will make it hostable (pending(...)) or add it to parityExemptPrefixes",
				key.Method, key.Pattern)
		}
	}
}

// The named views the desktop and the hosted client must both be able to show.
// Spot-checking them by name catches an exemption prefix that is widened until
// it swallows a surface that was supposed to reach parity.
func TestNamedParityViewsReachTheHostedPlane(t *testing.T) {
	for _, pattern := range []string{
		// Terminal is deliberately absent: it reaches parity over the
		// sandbox's own published listener, not this route. See
		// TestHostedTerminalsBypassTheControlPlane.
		"/api/v1/projects",                             // project
		"/api/v1/sessions",                             // session
		"/api/v1/sessions/{sessionId}/conversation",    // chat
		"/api/v1/sessions/{sessionId}/pr",              // PR
		"/api/v1/sessions/{sessionId}/reviews",         // review
		"/api/v1/sessions/{sessionId}/workspace/files", // workspace
		"/api/v1/sessions/{sessionId}/preview",         // preview
		"/api/v1/sessions/{sessionId}/attachments",     // attachment staging
	} {
		found := false
		for key, class := range routeClasses {
			if key.Pattern != pattern {
				continue
			}
			found = true
			if class.Scope != ScopeCloud && !class.Pending() {
				t.Errorf("%s %s must reach the hosted plane but is permanently local-only",
					key.Method, key.Pattern)
			}
		}
		if !found {
			t.Errorf("%s is not classified at all", pattern)
		}
	}
}

// A pending entry whose port is unnamed is indistinguishable from a permanent
// exclusion, which is the exact failure this axis exists to prevent.
func TestPendingRoutesNameTheirBlockingPort(t *testing.T) {
	for key, class := range routeClasses {
		if class.Pending() && strings.TrimSpace(class.PendingPort) == "" {
			t.Errorf("%s %s is pending with no named port", key.Method, key.Pattern)
		}
		if class.Scope == ScopeCloud && class.Pending() {
			t.Errorf("%s %s is already cloud-mounted; it should not still name a pending port",
				key.Method, key.Pattern)
		}
	}
}

// TestHostedTerminalsBypassTheControlPlane pins the settled terminal
// architecture at the one place a future change would have to pass through.
//
// Hosted panes do not go through the control plane at all: Electron's main
// process dials the sandbox's authenticated published /mux with a one-time
// control-plane-issued ticket. Relaying instead would push every byte of every
// pane through the control plane for no security gain, and would show up here
// as /mux becoming cloud-mounted or appearing in the hosted stream list.
//
// If hosted terminals are ever genuinely re-routed through the control plane,
// this test is the deliberate stop: update it together with the /mux entry in
// routeClasses, not around it.
func TestHostedTerminalsBypassTheControlPlane(t *testing.T) {
	class, ok := ClassifyRoute(http.MethodGet, "/mux")
	if !ok {
		t.Fatal("/mux is not classified")
	}
	if !class.Stream() {
		t.Error("/mux must be classified as a stream: it is the long-lived terminal transport")
	}
	if class.Scope != ScopeLocalOnly {
		t.Errorf("/mux scope = %q, want local-only: hosted terminals dial the sandbox directly", class.Scope)
	}
	if class.Pending() {
		t.Errorf("/mux names pending port %q, but not hosting it is a settled decision, not a gap",
			class.PendingPort)
	}
	for _, key := range CloudStreamRoutes() {
		if key.Pattern == "/mux" {
			t.Error("/mux appears in the hosted stream list; the control plane must not carry pane bytes")
		}
	}
}

// The cloud handler must not mount /mux under any composition — there is no
// relay seam to wire one through, and the guard refuses the route regardless.
func TestCloudHandlerNeverMountsTheTerminalMux(t *testing.T) {
	handler := NewCloudAPIHandler(config.Config{}, discardLogger(), APIDeps{})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/mux", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /mux on the cloud handler = %d, want 404", rec.Code)
	}
}

// A local-only entry without a reason is unreviewable: the next reader cannot
// tell whether a port has since made the route hostable.
func TestLocalOnlyRoutesCarryAReason(t *testing.T) {
	for key, class := range routeClasses {
		switch class.Scope {
		case ScopeLocalOnly:
			if strings.TrimSpace(class.Reason) == "" {
				t.Errorf("%s %s is local-only with no reason", key.Method, key.Pattern)
			}
		case ScopeCloud:
		default:
			t.Errorf("%s %s has unknown scope %q", key.Method, key.Pattern, class.Scope)
		}
	}
}

// TestCloudHandlerMountsTheSameAPI proves the hosted plane serves the daemon's
// API rather than a hand-maintained copy: the /api/v1 route set registered by
// NewCloudAPIHandler is identical to the daemon router's, before the scope
// guard narrows it. A controller added to one and not the other fails here.
func TestCloudHandlerMountsTheSameAPI(t *testing.T) {
	localAPI := map[RouteKey]bool{}
	for key := range walkRoutes(t, fullyWiredRouter(t)) {
		if strings.HasPrefix(key.Pattern, "/api/v1/") && !strings.HasPrefix(key.Pattern, "/api/v1/mobile") {
			localAPI[key] = true
		}
	}

	cloudRouter := chi.NewRouter()
	NewAPI(config.Config{}, APIDeps{}).Register(cloudRouter)
	cloudAPI := walkRoutes(t, cloudRouter)

	for key := range localAPI {
		if !cloudAPI[key] {
			t.Errorf("daemon serves %s %s but the cloud API mount does not", key.Method, key.Pattern)
		}
	}
	for key := range cloudAPI {
		if !localAPI[key] {
			t.Errorf("cloud API mount serves %s %s but the daemon does not", key.Method, key.Pattern)
		}
	}
}

// TestCloudScopeGuardRefusesLocalOnlyRoutes drives a concrete request at every
// classified /api/v1 route through the cloud handler. No local-only route may
// be served — either the guard refuses it (ROUTE_NOT_AVAILABLE) or it was
// never registered on this mount at all (ROUTE_NOT_FOUND, which is how the
// Connect Mobile surface lands here). Every cloud route must reach the router,
// which with empty deps answers 501 NOT_IMPLEMENTED — anything but a 404.
func TestCloudScopeGuardRefusesLocalOnlyRoutes(t *testing.T) {
	handler := NewCloudAPIHandler(config.Config{DataDir: t.TempDir()}, discardLogger(), APIDeps{})

	for key, class := range routeClasses {
		if !strings.HasPrefix(key.Pattern, "/api/v1/") {
			continue // daemon-process routes are covered separately
		}
		t.Run(key.Method+" "+key.Pattern, func(t *testing.T) {
			req := httptest.NewRequest(key.Method, concretePath(key.Pattern), strings.NewReader("{}"))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			switch class.Scope {
			case ScopeLocalOnly:
				if rec.Code != http.StatusNotFound {
					t.Fatalf("local-only route served by the cloud mount: status %d body %s", rec.Code, rec.Body.String())
				}
			case ScopeCloud:
				if rec.Code == http.StatusNotFound {
					t.Fatalf("cloud route not reachable on the cloud mount: %s", rec.Body.String())
				}
			}
		})
	}
}

// An unclassified route must fail closed. The guard cannot be handed a real
// unclassified daemon route (the completeness test forbids one existing), so
// this builds a router with a route the table deliberately does not name.
func TestCloudScopeGuardDeniesUnclassifiedRoutes(t *testing.T) {
	router := chi.NewRouter()
	router.NotFound(notFoundJSON)
	router.Get("/api/v1/unclassified-surface", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	if _, ok := ClassifyRoute("GET", "/api/v1/unclassified-surface"); ok {
		t.Fatal("test fixture route is unexpectedly classified")
	}

	rec := httptest.NewRecorder()
	CloudScopeGuard(router).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/unclassified-surface", nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "ROUTE_NOT_AVAILABLE") {
		t.Fatalf("unclassified route was not denied: status %d body %s", rec.Code, rec.Body.String())
	}
}

// A path that matches no route keeps the router's ordinary 404 envelope, so a
// client typo is not reported as "this route exists but is hosted elsewhere".
func TestCloudScopeGuardLeavesUnmatchedPathsAlone(t *testing.T) {
	handler := NewCloudAPIHandler(config.Config{}, discardLogger(), APIDeps{})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/no-such-route", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ROUTE_NOT_FOUND") {
		t.Fatalf("unmatched path did not get the ordinary 404 envelope: %s", rec.Body.String())
	}
}

// TestCloudHandlerOmitsDaemonProcessRoutes covers the exclusions by name:
// daemon control, the loopback CLI telemetry intake, the terminal multiplex,
// and the whole Connect Mobile control surface including the device roster.
// These are never registered on the cloud mount in the first place, so they
// 404 as unknown paths rather than as scope refusals — excluded twice over,
// since each is also classified local-only.
func TestCloudHandlerOmitsDaemonProcessRoutes(t *testing.T) {
	handler := NewCloudAPIHandler(config.Config{}, discardLogger(), APIDeps{})
	for _, probe := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/healthz"},
		{http.MethodGet, "/readyz"},
		{http.MethodPost, "/shutdown"},
		{http.MethodGet, "/mux"},
		{http.MethodPost, "/internal/telemetry/cli-invoked"},
		{http.MethodPost, "/internal/telemetry/cli-usage-error"},
		{http.MethodGet, "/api/v1/mobile/status"},
		{http.MethodPost, "/api/v1/mobile/enable"},
		{http.MethodPost, "/api/v1/mobile/disable"},
		{http.MethodPost, "/api/v1/mobile/regenerate"},
		{http.MethodPost, "/api/v1/mobile/secure-pairing"},
		{http.MethodGet, "/api/v1/mobile/devices"},
		{http.MethodPatch, "/api/v1/mobile/devices/probe-id"},
		{http.MethodDelete, "/api/v1/mobile/devices/probe-id"},
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(probe.method, probe.path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404", probe.method, probe.path, rec.Code)
		}
	}
}

// The same exclusions stated as a classification invariant, so a future edit
// cannot quietly promote one of them to the hosted surface by flipping a
// table entry — the routes above would still 404, but the intent would have
// silently changed.
func TestExcludedSurfacesAreClassifiedLocalOnly(t *testing.T) {
	for _, key := range []RouteKey{
		{Method: http.MethodPost, Pattern: "/shutdown"},
		{Method: http.MethodPost, Pattern: "/internal/telemetry/cli-invoked"},
		{Method: http.MethodPost, Pattern: "/internal/telemetry/cli-usage-error"},
		{Method: http.MethodGet, Pattern: "/mux"},
	} {
		assertLocalOnly(t, key)
	}
	for key := range routeClasses {
		if strings.HasPrefix(key.Pattern, "/api/v1/mobile") || strings.HasPrefix(key.Pattern, "/api/v1/push") {
			assertLocalOnly(t, key)
		}
	}
}

func assertLocalOnly(t *testing.T, key RouteKey) {
	t.Helper()
	class, ok := ClassifyRoute(key.Method, key.Pattern)
	if !ok {
		t.Errorf("%s %s is not classified", key.Method, key.Pattern)
		return
	}
	if class.Scope != ScopeLocalOnly {
		t.Errorf("%s %s scope = %q, want local-only", key.Method, key.Pattern, class.Scope)
	}
}

// concretePath turns a chi pattern into a requestable path.
func concretePath(pattern string) string {
	segments := strings.Split(pattern, "/")
	for i, segment := range segments {
		switch {
		case segment == "*":
			segments[i] = "file.txt"
		case strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}"):
			segments[i] = "probe-id"
		}
	}
	return strings.Join(segments, "/")
}

// TestDaemonRouterStaysUnauthenticated locks the hard rule that survives the
// cloud work: the daemon's primary listener is loopback and unauthenticated,
// and the hosted composition is a separate listener with its own auth. If the
// control plane's bearer requirement ever leaked into the shared router, every
// desktop client would break at once — so assert here that an app request with
// no Authorization header is never answered with 401 or 403.
//
// With empty deps each controller answers its OpenAPI-backed 501, which is the
// point: the router reached the controller without asking who was calling.
func TestDaemonRouterStaysUnauthenticated(t *testing.T) {
	router := fullyWiredRouter(t)

	for key, class := range routeClasses {
		if class.Scope != ScopeCloud || !strings.HasPrefix(key.Pattern, "/api/v1/") {
			continue
		}
		t.Run(key.Method+" "+key.Pattern, func(t *testing.T) {
			req := httptest.NewRequest(key.Method, concretePath(key.Pattern), strings.NewReader("{}"))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code == http.StatusUnauthorized || rec.Code == http.StatusForbidden {
				t.Fatalf("daemon router demanded credentials on the loopback listener: status %d body %s",
					rec.Code, rec.Body.String())
			}
		})
	}
}

// The scope guard belongs to the hosted composition only. Wrapping the daemon
// router in it would silently drop the local-only surface the desktop app
// depends on, so assert the daemon still serves those routes.
func TestDaemonRouterKeepsLocalOnlyRoutes(t *testing.T) {
	router := fullyWiredRouter(t)

	for _, path := range []string{
		"/api/v1/shell-terminals",
		"/api/v1/browser/status",
		"/api/v1/usage/sessions",
		"/api/v1/mobile/status",
		"/healthz",
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code == http.StatusNotFound {
			t.Errorf("daemon no longer serves local-only route GET %s", path)
		}
	}
}
