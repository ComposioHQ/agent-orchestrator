package usagetelemetry

import (
	"context"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// SummaryReader reads a session's aggregated usage. Satisfied by
// *usage.SummaryReader.
type SummaryReader interface {
	Get(ctx context.Context, id domain.SessionID) (domain.SessionUsageSummary, error)
}

// SessionStore resolves the session's project so a usage event can be
// attributed to a GitHub owner.
type SessionStore interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
}

// SCMParser extracts the owner from a project's remote. Satisfied by the SCM
// adapter's ParseRepository.
type SCMParser interface {
	ParseRepository(remote string) (ports.SCMRepo, bool)
}

// Emitter emits one ao.session.token_usage event per session once its usage is
// fully settled (all transcript ingestion complete), carrying measured token
// counts attributed to the owning GitHub org. Cost is intentionally not
// emitted: it is a query-time view in PostHog (tokens x per-model rate).
//
// It is driven by the usage pipeline's settle signal, NOT by session exit: at
// exit the pipeline has only been *poked*, so the transcript is typically not
// yet ingested and a read would see zero tokens. Emitting after settle is what
// makes the numbers real.
//
// Idempotent: it remembers the last total emitted per session and skips a
// repeat with the same total, so the retries and multi-binding settles the
// pipeline performs never double-count. A later genuine increase (a reactivated
// session that runs more) re-emits with the higher total, which downstream
// ranking treats as the session's latest figure.
type Emitter struct {
	summary   SummaryReader
	store     SessionStore
	scm       SCMParser
	telemetry ports.EventSink
	now       func() time.Time

	mu        sync.Mutex
	lastTotal map[domain.SessionID]int64
}

// NewEmitter builds an Emitter. A nil telemetry or summary makes EmitSessionUsage
// a no-op (keeps wiring simple when telemetry is disabled).
func NewEmitter(summary SummaryReader, store SessionStore, scm SCMParser, telemetry ports.EventSink, clock func() time.Time) *Emitter {
	if clock == nil {
		clock = time.Now
	}
	return &Emitter{
		summary:   summary,
		store:     store,
		scm:       scm,
		telemetry: telemetry,
		now:       clock,
		lastTotal: make(map[domain.SessionID]int64),
	}
}

// AllBindingsSettled reports whether every binding for a session has reached a
// terminal ingestion state (complete or partial). Only then is the session's
// usage summary final and worth emitting. Empty input is treated as not
// settled: a session with no bindings has nothing to report.
func AllBindingsSettled(bindings []domain.UsageBindingRecord) bool {
	if len(bindings) == 0 {
		return false
	}
	for _, b := range bindings {
		if b.State != domain.UsageBindingComplete && b.State != domain.UsageBindingPartial {
			return false
		}
	}
	return true
}

// EmitSessionUsage reads the (now settled) usage summary for a session and emits
// one ao.session.token_usage event, unless an identical total was already
// emitted for it. Best-effort: any read error or empty usage is a silent no-op.
func (e *Emitter) EmitSessionUsage(ctx context.Context, id domain.SessionID) {
	if e.telemetry == nil || e.summary == nil {
		return
	}
	summary, err := e.summary.Get(ctx, id)
	if err != nil {
		return
	}
	// InputTokens is the total input (cached + uncached); cached is a subset,
	// so the session total is input + output rather than summing cached again.
	input := deref(summary.Totals.InputTokens)
	cached := deref(summary.Totals.CachedInputTokens)
	output := deref(summary.Totals.OutputTokens)
	total := input + output
	if total == 0 {
		return // nothing ingested yet; not worth an event.
	}

	// Idempotency: skip a repeat with no new usage (multi-binding settles and
	// pipeline retries both re-signal the same session). Record before emitting
	// so a concurrent duplicate also short-circuits.
	e.mu.Lock()
	if prev, ok := e.lastTotal[id]; ok && prev == total {
		e.mu.Unlock()
		return
	}
	e.lastTotal[id] = total
	e.mu.Unlock()

	model, harness := dominant(summary)
	// Emit measured token counts only. Cost in dollars is not in the transcript
	// (providers record tokens, not a price), so it is a derived view computed
	// at query time in PostHog (tokens x per-model rate) rather than frozen into
	// each event with a rate that can be wrong or go stale.
	payload := map[string]any{
		"harness":             harness,
		"model":               model,
		"input_tokens":        input,
		"cached_input_tokens": cached,
		"output_tokens":       output,
		"total_tokens":        total,
		"incomplete":          summary.Incomplete,
	}
	if org := e.githubOrg(ctx, id); org != "" {
		payload["github_org"] = org
	}

	sessionID := id
	ev := ports.TelemetryEvent{
		Name:       "ao.session.token_usage",
		Source:     "usage_telemetry",
		OccurredAt: e.now().UTC(),
		Level:      ports.TelemetryLevelInfo,
		SessionID:  &sessionID,
	}
	if pid := e.projectID(ctx, id); pid != "" {
		p := domain.ProjectID(pid)
		ev.ProjectID = &p
	}
	ev.Payload = payload
	e.telemetry.Emit(context.Background(), ev)
}

func deref(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

// dominant picks the model (and its harness) that produced the most output
// tokens, used to label the event. Ties break on model id for stability.
func dominant(summary domain.SessionUsageSummary) (model, harness string) {
	var best int64 = -1
	for _, h := range summary.Harnesses {
		for _, m := range h.Models {
			out := deref(m.Totals.OutputTokens)
			if out > best || (out == best && m.ModelID < model) {
				best = out
				model = m.ModelID
				harness = string(h.Harness)
			}
		}
	}
	return model, harness
}

func (e *Emitter) projectID(ctx context.Context, id domain.SessionID) string {
	if e.store == nil {
		return ""
	}
	rec, ok, err := e.store.GetSession(ctx, id)
	if err != nil || !ok {
		return ""
	}
	return string(rec.ProjectID)
}

// githubOrg resolves the GitHub owner/org of the session's project remote, or
// "" when unknown or not a GitHub remote. Only the owner segment is used.
func (e *Emitter) githubOrg(ctx context.Context, id domain.SessionID) string {
	if e.store == nil || e.scm == nil {
		return ""
	}
	rec, ok, err := e.store.GetSession(ctx, id)
	if err != nil || !ok {
		return ""
	}
	project, ok, err := e.store.GetProject(ctx, string(rec.ProjectID))
	if err != nil || !ok {
		return ""
	}
	repo, ok := e.scm.ParseRepository(project.RepoOriginURL)
	if !ok || repo.Provider != "github" {
		return ""
	}
	return repo.Owner
}
