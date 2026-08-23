package controllers_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/systeminstall"
)

type fakeInstaller struct {
	startJob   systeminstall.Job
	startErr   error
	statusJob  systeminstall.Job
	statusErr  error
	plans      []systeminstall.AgentPlan
	plansErr   error
	startCalls int
	lastTarget systeminstall.Target
}

func (f *fakeInstaller) Start(_ context.Context, target systeminstall.Target) (systeminstall.Job, error) {
	f.startCalls++
	f.lastTarget = target
	return f.startJob, f.startErr
}

func (f *fakeInstaller) Status(_ context.Context, target systeminstall.Target) (systeminstall.Job, error) {
	f.lastTarget = target
	return f.statusJob, f.statusErr
}

func (f *fakeInstaller) AgentPlans(context.Context) ([]systeminstall.AgentPlan, error) {
	return f.plans, f.plansErr
}

func TestAgentInstallRoutes(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	installer := &fakeInstaller{
		plans:    []systeminstall.AgentPlan{{AgentID: "codex", Available: true, Automatic: true, Method: "npm"}},
		startJob: systeminstall.Job{Target: systeminstall.TargetCodex, Status: systeminstall.StatusRunning},
	}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Installer: installer,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/agents/installers", "")
	if status != http.StatusOK || !strings.Contains(string(body), `"agentId":"codex"`) {
		t.Fatalf("GET /agents/installers = %d, body=%s", status, body)
	}
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/agents/codex/install", "")
	if status != http.StatusAccepted || installer.lastTarget != systeminstall.TargetCodex {
		t.Fatalf("POST /agents/codex/install = %d, target=%q, body=%s", status, installer.lastTarget, body)
	}
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/agents/not-real/install", "")
	if status != http.StatusBadRequest || !strings.Contains(string(body), `"code":"UNKNOWN_AGENT_INSTALL_TARGET"`) {
		t.Fatalf("POST /agents/not-real/install = %d, body=%s", status, body)
	}
}

func TestPostSystemInstall(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	installer := &fakeInstaller{startJob: systeminstall.Job{
		Target:  systeminstall.TargetGH,
		Status:  systeminstall.StatusRunning,
		Command: "brew install gh",
	}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Installer: installer,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/system/install/gh", "")
	if status != http.StatusAccepted {
		t.Fatalf("POST /system/install/gh = %d, body=%s", status, body)
	}
	for _, want := range []string{`"target":"gh"`, `"status":"running"`, `"command":"brew install gh"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
	if installer.startCalls != 1 {
		t.Fatalf("startCalls = %d, want 1", installer.startCalls)
	}
}

func TestPostSystemInstall_UnknownTarget(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	installer := &fakeInstaller{}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Installer: installer,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	// A junk single path segment (not one of the 6 known targets) must be
	// rejected before ever reaching the service — same guard that stops a
	// path-traversal-shaped value from being passed through.
	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/system/install/rm-rf-everything", "")
	if status != http.StatusBadRequest {
		t.Fatalf("POST /system/install/<junk> = %d, want %d, body=%s", status, http.StatusBadRequest, body)
	}
	if !strings.Contains(string(body), `"code":"UNKNOWN_INSTALL_TARGET"`) {
		t.Fatalf("body missing UNKNOWN_INSTALL_TARGET code: %s", body)
	}
	if installer.startCalls != 0 {
		t.Fatalf("startCalls = %d, want 0 (unknown target must never reach the service)", installer.startCalls)
	}
}

func TestPostSystemInstall_NotImplemented(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	defer srv.Close()

	_, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/system/install/gh", "")
	if status != http.StatusNotImplemented {
		t.Fatalf("POST /system/install/gh = %d, want %d", status, http.StatusNotImplemented)
	}
}

func TestGetSystemInstallStatus(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	installer := &fakeInstaller{statusJob: systeminstall.Job{
		Target: systeminstall.TargetOpencode,
		Status: systeminstall.StatusSucceeded,
	}}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Installer: installer,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/system/install/opencode", "")
	if status != http.StatusOK {
		t.Fatalf("GET /system/install/opencode = %d, body=%s", status, body)
	}
	if !strings.Contains(string(body), `"status":"succeeded"`) {
		t.Fatalf("body missing status: %s", body)
	}
	if installer.lastTarget != systeminstall.TargetOpencode {
		t.Fatalf("lastTarget = %q, want %q", installer.lastTarget, systeminstall.TargetOpencode)
	}
}

func TestGetSystemInstallStatus_UnknownTarget(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	installer := &fakeInstaller{}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Installer: installer,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/system/install/bogus", "")
	if status != http.StatusBadRequest {
		t.Fatalf("GET /system/install/bogus = %d, want %d, body=%s", status, http.StatusBadRequest, body)
	}
}

func TestGetSystemInstallStatus_NotImplemented(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	defer srv.Close()

	_, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/system/install/gh", "")
	if status != http.StatusNotImplemented {
		t.Fatalf("GET /system/install/gh = %d, want %d", status, http.StatusNotImplemented)
	}
}

func TestSystemInstallController_ServiceError(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	installer := &fakeInstaller{startErr: errors.New("boom")}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Installer: installer,
	}, httpd.ControlDeps{}))
	defer srv.Close()

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/system/install/tmux", "")
	if status != http.StatusInternalServerError {
		t.Fatalf("POST /system/install/tmux = %d, want %d, body=%s", status, http.StatusInternalServerError, body)
	}
	for _, want := range []string{
		`"error":"internal"`,
		`"code":"INTERNAL_ERROR"`,
		`"message":"Internal server error"`,
		`"requestId":"`,
	} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("body missing %s: %s", want, body)
		}
	}
	if strings.Contains(string(body), "boom") {
		t.Fatalf("body leaked internal service error: %s", body)
	}
}
