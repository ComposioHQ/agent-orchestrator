package controllers_test

import (
	"context"
	"encoding/json"
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
	inputCost := int64(300000000)
	svc := &fakeUsageSummaryService{items: []domain.CompactSessionUsage{
		{
			SessionID: "reverb-12", TotalTokens: 12400, Incomplete: true,
			EstimatedCost: &domain.EstimatedCost{
				TotalNanos: 420000000, UncachedInputNanos: &inputCost,
				Coverage: domain.EstimatedCostCoveragePartial,
			},
		},
		{SessionID: "unavailable", TotalTokens: 3},
	}}
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
			SessionID     string          `json:"sessionId"`
			TotalTokens   int64           `json:"totalTokens"`
			Incomplete    bool            `json:"incomplete"`
			EstimatedCost json.RawMessage `json:"estimatedCost"`
		} `json:"sessions"`
	}
	mustJSON(t, body, &got)
	if len(got.Sessions) != 2 || got.Sessions[0].SessionID != "reverb-12" ||
		got.Sessions[0].TotalTokens != 12400 || !got.Sessions[0].Incomplete {
		t.Fatalf("response = %+v", got)
	}
	var cost struct {
		TotalNanos         int64  `json:"totalNanos"`
		UncachedInputNanos *int64 `json:"uncachedInputNanos"`
		CacheReadNanos     *int64 `json:"cacheReadNanos"`
		Coverage           string `json:"coverage"`
	}
	mustJSON(t, got.Sessions[0].EstimatedCost, &cost)
	if cost.TotalNanos != 420000000 || cost.UncachedInputNanos == nil || *cost.UncachedInputNanos != 300000000 ||
		cost.CacheReadNanos != nil || cost.Coverage != "partial" {
		t.Fatalf("estimated cost = %+v", cost)
	}
	if string(got.Sessions[1].EstimatedCost) != "null" {
		t.Fatalf("unavailable estimatedCost = %s, want explicit null", got.Sessions[1].EstimatedCost)
	}
}

func TestUsageAPIShowsDetailedEstimatedCostAndProviderAttribution(t *testing.T) {
	input := int64(1000)
	output := int64(200)
	cacheRead := int64(400)
	zero := int64(0)
	svc := &fakeUsageSummaryService{detail: domain.SessionUsageSummary{
		SessionID: "reverb-12", Incomplete: true,
		Totals: domain.UsageMetricTotals{
			InputTokens: &input, CacheReadTokens: &cacheRead, OutputTokens: &output,
			EstimatedCost: &domain.EstimatedCost{
				TotalNanos: 135, UncachedInputNanos: &input, CacheWriteNanos: &zero,
				OutputNanos: &output, Coverage: domain.EstimatedCostCoveragePartial,
			},
		},
		Harnesses: []domain.HarnessUsageSummary{{
			Harness: domain.HarnessCodex,
			Models: []domain.ModelUsageSummary{{
				ProviderID: "openai", ModelID: "gpt-5.6",
				Totals: domain.UsageMetricTotals{EstimatedCost: &domain.EstimatedCost{
					TotalNanos: 0, UncachedInputNanos: &zero, CacheReadNanos: &zero,
					CacheWriteNanos: &zero, OutputNanos: &zero, Coverage: domain.EstimatedCostCoverageComplete,
				}},
			}},
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
	for _, forbidden := range []string{`"valueNanos"`, `"pricingVersion"`} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("detailed usage exposed %s: %s", forbidden, body)
		}
	}
	var got struct {
		SessionID  string `json:"sessionId"`
		Incomplete bool   `json:"incomplete"`
		Totals     struct {
			InputTokens   int64 `json:"inputTokens"`
			EstimatedCost struct {
				TotalNanos      int64  `json:"totalNanos"`
				CacheReadNanos  *int64 `json:"cacheReadNanos"`
				CacheWriteNanos *int64 `json:"cacheWriteNanos"`
				Coverage        string `json:"coverage"`
			} `json:"estimatedCost"`
		} `json:"totals"`
		Harnesses []struct {
			Models []struct {
				ProviderID string `json:"providerId"`
				ModelID    string `json:"modelId"`
				Totals     struct {
					EstimatedCost struct {
						TotalNanos int64  `json:"totalNanos"`
						Coverage   string `json:"coverage"`
					} `json:"estimatedCost"`
				} `json:"totals"`
			} `json:"models"`
		} `json:"harnesses"`
	}
	mustJSON(t, body, &got)
	if got.SessionID != "reverb-12" || !got.Incomplete || got.Totals.InputTokens != 1000 ||
		got.Totals.EstimatedCost.TotalNanos != 135 || got.Totals.EstimatedCost.CacheReadNanos != nil ||
		got.Totals.EstimatedCost.CacheWriteNanos == nil || *got.Totals.EstimatedCost.CacheWriteNanos != 0 ||
		got.Totals.EstimatedCost.Coverage != "partial" ||
		len(got.Harnesses) != 1 || len(got.Harnesses[0].Models) != 1 ||
		got.Harnesses[0].Models[0].ProviderID != "openai" || got.Harnesses[0].Models[0].ModelID != "gpt-5.6" ||
		got.Harnesses[0].Models[0].Totals.EstimatedCost.TotalNanos != 0 ||
		got.Harnesses[0].Models[0].Totals.EstimatedCost.Coverage != "complete" {
		t.Fatalf("response = %+v", got)
	}
}
