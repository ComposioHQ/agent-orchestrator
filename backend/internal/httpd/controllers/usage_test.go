package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

type fakeUsageSummaryService struct {
	projectID domain.ProjectID
	sessionID domain.SessionID
	items     []domain.CompactSessionUsage
	detail    domain.SessionUsageSummary
	err       error
}

func (f *fakeUsageSummaryService) ListCompact(_ context.Context, projectID domain.ProjectID) ([]domain.CompactSessionUsage, error) {
	f.projectID = projectID
	return f.items, f.err
}

func (f *fakeUsageSummaryService) Get(_ context.Context, sessionID domain.SessionID) (domain.SessionUsageSummary, error) {
	f.sessionID = sessionID
	return f.detail, f.err
}

func newUsageTestServer(t *testing.T, svc *fakeUsageSummaryService) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{UsageSummary: svc}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestUsageAPIListsCompactProjectUsage(t *testing.T) {
	processed := int64(12300)
	svc := &fakeUsageSummaryService{items: []domain.CompactSessionUsage{{
		SessionID: "reverb-12", ProcessedTokens: &processed, Incomplete: true,
	}}}
	srv := newUsageTestServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/usage/sessions?projectId=reverb", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if svc.projectID != "reverb" {
		t.Fatalf("project id = %q, want reverb", svc.projectID)
	}
	var got struct {
		Sessions []struct {
			SessionID       string `json:"sessionId"`
			ProcessedTokens int64  `json:"processedTokens"`
			TotalTokens     int64  `json:"totalTokens"`
			Incomplete      bool   `json:"incomplete"`
		} `json:"sessions"`
	}
	mustJSON(t, body, &got)
	if len(got.Sessions) != 1 || got.Sessions[0].SessionID != "reverb-12" ||
		got.Sessions[0].ProcessedTokens != 12300 || got.Sessions[0].TotalTokens != 12300 ||
		!got.Sessions[0].Incomplete {
		t.Fatalf("response = %+v", got)
	}
}

func TestUsageAPIShowsDetailedSessionTokenTelemetryWithoutCost(t *testing.T) {
	input := int64(1000)
	uncached := int64(600)
	output := int64(200)
	cachedInput := int64(400)
	cacheWrite := int64(100)
	reasoning := int64(40)
	processed := int64(1200)
	svc := &fakeUsageSummaryService{detail: domain.SessionUsageSummary{
		SessionID: "reverb-12", Incomplete: true,
		Totals: domain.UsageMetricTotals{
			InputTokens: &input, CachedInputTokens: &cachedInput, UncachedInputTokens: &uncached,
			OutputTokens: &output, ProcessedTokens: &processed,
			Provenance: domain.UsageMetricProvenanceSet{
				InputTokens: domain.UsageMetricReported, CachedInputTokens: domain.UsageMetricReported,
				UncachedInputTokens: domain.UsageMetricDerived,
				OutputTokens:        domain.UsageMetricReported,
			},
			ProviderDetails: domain.UsageProviderDetails{OpenAI: &domain.OpenAIUsageDetails{
				ReasoningOutputTokens: &reasoning, CacheWriteInputTokens: &cacheWrite,
			}},
		},
		Harnesses: []domain.HarnessUsageSummary{{
			Harness: domain.HarnessCodex,
			Models:  []domain.ModelUsageSummary{{ModelID: "gpt-5.6"}},
		}},
	}}
	srv := newUsageTestServer(t, svc)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/usage/sessions/reverb-12", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if svc.sessionID != "reverb-12" {
		t.Fatalf("session id = %q", svc.sessionID)
	}
	for _, forbidden := range []string{`"cost"`, `"valueNanos"`, `"pricingVersion"`, `"totalTokens"`} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("detailed usage exposed %s: %s", forbidden, body)
		}
	}
	var got struct {
		SessionID  string `json:"sessionId"`
		Incomplete bool   `json:"incomplete"`
		Totals     struct {
			InputTokens         int64 `json:"inputTokens"`
			CachedInputTokens   int64 `json:"cachedInputTokens"`
			UncachedInputTokens int64 `json:"uncachedInputTokens"`
			OutputTokens        int64 `json:"outputTokens"`
			ProcessedTokens     int64 `json:"processedTokens"`
			CacheReadTokens     int64 `json:"cacheReadTokens"`
			CacheWriteTokens    int64 `json:"cacheWriteTokens"`
			ReasoningTokens     int64 `json:"reasoningTokens"`
			ProviderDetails     struct {
				OpenAI struct {
					Reasoning  int64 `json:"openaiReasoningOutputTokens"`
					CacheWrite int64 `json:"openaiCacheWriteInputTokens"`
				} `json:"openai"`
			} `json:"providerDetails"`
		} `json:"totals"`
		Harnesses []struct {
			Models []struct {
				ModelID string `json:"modelId"`
			} `json:"models"`
		} `json:"harnesses"`
	}
	mustJSON(t, body, &got)
	if got.SessionID != "reverb-12" || !got.Incomplete || got.Totals.InputTokens != 1000 ||
		got.Totals.CachedInputTokens != 400 || got.Totals.UncachedInputTokens != 600 ||
		got.Totals.OutputTokens != 200 ||
		got.Totals.ProcessedTokens != 1200 || got.Totals.CacheReadTokens != 400 ||
		got.Totals.CacheWriteTokens != 100 || got.Totals.ReasoningTokens != 40 ||
		got.Totals.ProviderDetails.OpenAI.Reasoning != 40 ||
		got.Totals.ProviderDetails.OpenAI.CacheWrite != 100 ||
		len(got.Harnesses) != 1 || len(got.Harnesses[0].Models) != 1 ||
		got.Harnesses[0].Models[0].ModelID != "gpt-5.6" {
		t.Fatalf("response = %+v", got)
	}
}
