package controllers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	settingssvc "github.com/aoagents/agent-orchestrator/backend/internal/service/settings"
)

type settingsServiceStub struct{}

func (settingsServiceStub) Get(context.Context) (settingssvc.Snapshot, error) {
	return settingssvc.Snapshot{DefaultSessionMode: domain.SessionModeChat}, nil
}

func (settingsServiceStub) SetDefaultSessionMode(
	context.Context,
	domain.SessionMode,
) (settingssvc.Snapshot, error) {
	return settingssvc.Snapshot{}, nil
}

func (settingsServiceStub) ChatHarnesses([]domain.AgentHarness) []domain.AgentHarness {
	return []domain.AgentHarness{domain.HarnessCodex, domain.HarnessClaudeCode}
}

func (settingsServiceStub) PreventiveReadOnlyChatHarnesses([]domain.AgentHarness) []domain.AgentHarness {
	return []domain.AgentHarness{domain.HarnessCodex}
}

func TestSettingsResponseExposesPreventiveReadOnlyHarnesses(t *testing.T) {
	router := chi.NewRouter()
	controller := SettingsController{Svc: settingsServiceStub{}}
	controller.Register(router)

	request := httptest.NewRequest(http.MethodGet, "/settings", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET settings = %d; body=%s", response.Code, response.Body.String())
	}
	var payload SettingsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if len(payload.PreventiveReadOnlyChatHarnesses) != 1 ||
		payload.PreventiveReadOnlyChatHarnesses[0] != string(domain.HarnessCodex) {
		t.Fatalf("preventive read-only harnesses = %v, want [codex]", payload.PreventiveReadOnlyChatHarnesses)
	}
}
