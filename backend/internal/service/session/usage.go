package session

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/pricing"
)

// RecordUsage prices and emits token-usage telemetry reported by an agent hook.
// Each completed turn becomes an ao.session.turn_usage event; an optional
// whole-session summary becomes one ao.session.usage event. Harness and
// project are taken from the stored session record, not the caller, so the
// tags cannot be spoofed by whatever posted the report. It is best-effort:
// with no telemetry sink it is a no-op, and an unpriced model records tokens
// with a zero cost rather than failing.
func (s *Service) RecordUsage(ctx context.Context, id domain.SessionID, report ports.UsageReport) error {
	if !report.HasData() {
		return nil
	}
	rec, ok, err := s.store.GetSession(ctx, id)
	if err != nil {
		return err
	}
	if !ok {
		return apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	if s.telemetry == nil {
		return nil
	}
	projectID := rec.ProjectID
	sessionID := rec.ID
	harness := string(rec.Harness)

	base := func() map[string]any {
		return map[string]any{"harness": harness, "kind": string(rec.Kind)}
	}
	emit := func(name string, payload map[string]any) {
		s.telemetry.Emit(context.Background(), ports.TelemetryEvent{
			Name:       name,
			Source:     "session_service",
			OccurredAt: s.now(),
			Level:      ports.TelemetryLevelInfo,
			ProjectID:  &projectID,
			SessionID:  &sessionID,
			Payload:    payload,
		})
	}

	for _, t := range report.Turns {
		p := base()
		addUsage(p, t)
		emit("ao.session.turn_usage", p)
	}
	if report.Summary != nil {
		p := base()
		addUsage(p, report.Summary.TokenUsage)
		p["turn_count"] = report.Summary.TurnCount
		if report.Summary.DurationMs > 0 {
			p["duration_ms"] = report.Summary.DurationMs
		}
		emit("ao.session.usage", p)
	}
	return nil
}

// addUsage writes a turn's token fields, total, and priced cost onto a payload.
func addUsage(p map[string]any, t ports.TokenUsage) {
	p["model"] = t.Model
	p["input_tokens"] = t.InputTokens
	p["output_tokens"] = t.OutputTokens
	p["cache_read_tokens"] = t.CacheReadTokens
	p["cache_write_tokens"] = t.CacheWriteTokens
	p["total_tokens"] = t.InputTokens + t.OutputTokens + t.CacheReadTokens + t.CacheWriteTokens
	cost, priced := pricing.Cost(t.Model, t.InputTokens, t.OutputTokens, t.CacheReadTokens, t.CacheWriteTokens)
	p["cost_usd"] = cost
	p["model_priced"] = priced
}
