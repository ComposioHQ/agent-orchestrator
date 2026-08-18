package projectcontrol_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/projectcontrol"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type fixture struct {
	t       *testing.T
	ctx     context.Context
	dataDir string
	store   interface {
		projectcontrol.Store
		UpsertProject(context.Context, domain.ProjectRecord) error
		Close() error
	}
	service *projectcontrol.Service
	serial  atomic.Int64
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, ctx: context.Background(), dataDir: t.TempDir()}
	store, err := sqlitetest.Open(f.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	f.store = store
	t.Cleanup(func() { _ = store.Close() })
	f.service = projectcontrol.NewWithDeps(projectcontrol.Deps{
		Store: store,
		NewID: func() string { return fmt.Sprintf("id-%d", f.serial.Add(1)) },
		Clock: func() time.Time { return time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC) },
	})
	f.seedProject("ao")
	return f
}

func (f *fixture) seedProject(id domain.ProjectID) {
	f.t.Helper()
	err := f.store.UpsertProject(f.ctx, domain.ProjectRecord{
		ID: string(id), Path: "/tmp/" + string(id), RegisteredAt: time.Now().UTC(),
	})
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) count(table string) int64 {
	f.t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(f.dataDir, "ao.db")+"?mode=ro")
	if err != nil {
		f.t.Fatal(err)
	}
	defer db.Close()
	var count int64
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
		f.t.Fatal(err)
	}
	return count
}

func initialInput(key string) domain.SetOutcomeInput {
	return domain.SetOutcomeInput{
		ExpectedRevision: 0, IdempotencyKey: key, Statement: "Ship a trustworthy slice",
		Criteria: []domain.AcceptanceCriterionInput{
			{Statement: "Persists after restart", VerificationMethod: "Reopen the database", DisplayOrder: 1},
			{Statement: "Writes one event", VerificationMethod: "Count durable events", DisplayOrder: 0},
		},
	}
}

func TestGetUnconfiguredAndFirstSetOutcome(t *testing.T) {
	f := newFixture(t)
	state, err := f.service.Get(f.ctx, "ao")
	if err != nil {
		t.Fatal(err)
	}
	if state.Configured || state.Revision != 0 || state.Health != domain.ProjectControlHealthUnconfigured ||
		state.Confidence != domain.ProjectControlConfidenceUnknown || state.Outcome != nil {
		t.Fatalf("unconfigured state = %#v", state)
	}
	if got := f.count("project_control_heads"); got != 0 {
		t.Fatalf("Get backfilled %d heads", got)
	}

	state, err = f.service.SetOutcome(f.ctx, "ao", initialInput("set-1"))
	if err != nil {
		t.Fatal(err)
	}
	if !state.Configured || state.Revision != 1 || state.Health != domain.ProjectControlHealthUnknown ||
		state.Confidence != domain.ProjectControlConfidenceUnknown || state.Outcome == nil {
		t.Fatalf("configured state = %#v", state)
	}
	if state.Outcome.ID != "outcome-id-1" || state.Outcome.Owner != domain.ProjectOwnerRole ||
		len(state.Outcome.Criteria) != 2 || state.Outcome.Criteria[0].DisplayOrder != 0 ||
		state.Outcome.Criteria[0].ID != "criterion-id-2" || state.Outcome.Criteria[1].ID != "criterion-id-3" {
		t.Fatalf("outcome = %#v", state.Outcome)
	}
	for table, want := range map[string]int64{
		"project_control_heads": 1, "project_control_outcomes": 1,
		"project_control_acceptance_criteria": 2, "project_control_set_results": 1,
		"project_control_events": 1,
	} {
		if got := f.count(table); got != want {
			t.Errorf("%s count = %d, want %d", table, got, want)
		}
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(f.dataDir, "ao.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var eventType string
	var eventRevision int64
	var payload string
	if err := db.QueryRow(`SELECT event_type, revision, payload FROM project_control_events`).Scan(&eventType, &eventRevision, &payload); err != nil {
		t.Fatal(err)
	}
	var eventState domain.ProjectControl
	if err := json.Unmarshal([]byte(payload), &eventState); err != nil {
		t.Fatal(err)
	}
	if eventType != "outcome.set" || eventRevision != 1 || !reflect.DeepEqual(eventState, state) {
		t.Fatalf("event = type:%q revision:%d payload:%#v", eventType, eventRevision, eventState)
	}
	loaded, err := f.service.Get(f.ctx, "ao")
	if err != nil || !reflect.DeepEqual(loaded, state) {
		t.Fatalf("Get after SetOutcome = %#v, %v; want %#v", loaded, err, state)
	}
}

func TestSetOutcomeUpdatesStableCriteriaReordersAndDeletesOmissions(t *testing.T) {
	f := newFixture(t)
	first, err := f.service.SetOutcome(f.ctx, "ao", initialInput("set-1"))
	if err != nil {
		t.Fatal(err)
	}
	c0, c1 := first.Outcome.Criteria[0], first.Outcome.Criteria[1]
	updated, err := f.service.SetOutcome(f.ctx, "ao", domain.SetOutcomeInput{
		ExpectedRevision: 1, IdempotencyKey: "set-2", Statement: "Ship the durable core",
		Criteria: []domain.AcceptanceCriterionInput{
			{ID: c0.ID, Statement: "Exactly one event", VerificationMethod: "Count events", DisplayOrder: 1},
			{ID: c1.ID, Statement: c1.Statement, VerificationMethod: c1.VerificationMethod, DisplayOrder: 0},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 || updated.Outcome.ID != first.Outcome.ID ||
		updated.Outcome.Criteria[0].ID != c1.ID || updated.Outcome.Criteria[1].ID != c0.ID {
		t.Fatalf("reordered update = %#v", updated)
	}

	final, err := f.service.SetOutcome(f.ctx, "ao", domain.SetOutcomeInput{
		ExpectedRevision: 2, IdempotencyKey: "set-3", Statement: updated.Outcome.Statement,
		Criteria: []domain.AcceptanceCriterionInput{{
			ID: c0.ID, Statement: "Exactly one event", VerificationMethod: "Count events", DisplayOrder: 0,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if final.Revision != 3 || len(final.Outcome.Criteria) != 1 || final.Outcome.Criteria[0].ID != c0.ID {
		t.Fatalf("omission result = %#v", final)
	}
	if got := f.count("project_control_acceptance_criteria"); got != 1 {
		t.Fatalf("criteria count = %d, want 1", got)
	}
	if got := f.count("project_control_events"); got != 3 {
		t.Fatalf("event count = %d, want 3", got)
	}
}

func TestSetOutcomeRejectsInvalidCriterionReferencesWithoutWrites(t *testing.T) {
	f := newFixture(t)
	first, err := f.service.SetOutcome(f.ctx, "ao", initialInput("set-1"))
	if err != nil {
		t.Fatal(err)
	}
	f.seedProject("other")

	_, err = f.service.SetOutcome(f.ctx, "ao", domain.SetOutcomeInput{
		ExpectedRevision: 1, IdempotencyKey: "unknown", Statement: first.Outcome.Statement,
		Criteria: []domain.AcceptanceCriterionInput{{
			ID: "criterion-does-not-exist", Statement: "Unknown", VerificationMethod: "Reject it", DisplayOrder: 0,
		}},
	})
	if !errors.Is(err, domain.ErrAcceptanceCriterionIDUnknown) {
		t.Fatalf("unknown ID error = %v", err)
	}

	_, err = f.service.SetOutcome(f.ctx, "other", domain.SetOutcomeInput{
		ExpectedRevision: 0, IdempotencyKey: "cross", Statement: "Other outcome",
		Criteria: []domain.AcceptanceCriterionInput{{
			ID: first.Outcome.Criteria[0].ID, Statement: "Cross", VerificationMethod: "Reject it", DisplayOrder: 0,
		}},
	})
	if !errors.Is(err, domain.ErrAcceptanceCriterionIDUnknown) {
		t.Fatalf("cross-outcome ID error = %v", err)
	}
	other, err := f.service.Get(f.ctx, "other")
	if err != nil || other.Configured {
		t.Fatalf("other state = %#v, %v; want unconfigured", other, err)
	}
	if f.count("project_control_events") != 1 || f.count("project_control_set_results") != 1 {
		t.Fatal("rejected criterion reference wrote durable command state")
	}
}

func TestSetOutcomeRejectsDuplicateIDsAndDisplayOrders(t *testing.T) {
	f := newFixture(t)
	for name, tc := range map[string]struct {
		criteria []domain.AcceptanceCriterionInput
		target   error
	}{
		"id": {[]domain.AcceptanceCriterionInput{
			{ID: "same", Statement: "a", VerificationMethod: "a", DisplayOrder: 0},
			{ID: "same", Statement: "b", VerificationMethod: "b", DisplayOrder: 1},
		}, domain.ErrDuplicateCriterionID},
		"order": {[]domain.AcceptanceCriterionInput{
			{Statement: "a", VerificationMethod: "a", DisplayOrder: 0},
			{Statement: "b", VerificationMethod: "b", DisplayOrder: 0},
		}, domain.ErrDuplicateCriterionDisplayOrder},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := f.service.SetOutcome(f.ctx, "ao", domain.SetOutcomeInput{
				ExpectedRevision: 0, IdempotencyKey: name, Statement: "outcome", Criteria: tc.criteria,
			})
			if !errors.Is(err, tc.target) {
				t.Fatalf("error = %v, want %v", err, tc.target)
			}
		})
	}
	if f.count("project_control_heads") != 0 || f.count("project_control_events") != 0 {
		t.Fatal("duplicate input wrote state")
	}
}

func TestSetOutcomeIdempotencyAndStaleRevisionAreWriteFree(t *testing.T) {
	f := newFixture(t)
	input := initialInput("same-key")
	first, err := f.service.SetOutcome(f.ctx, "ao", input)
	if err != nil {
		t.Fatal(err)
	}
	retry := input
	retry.Statement = "  " + retry.Statement + "  "
	retry.Criteria[0], retry.Criteria[1] = retry.Criteria[1], retry.Criteria[0]
	for i := range retry.Criteria {
		retry.Criteria[i].Statement = " " + retry.Criteria[i].Statement + " "
		retry.Criteria[i].VerificationMethod = " " + retry.Criteria[i].VerificationMethod + " "
	}
	again, err := f.service.SetOutcome(f.ctx, "ao", retry)
	if err != nil || !reflect.DeepEqual(again, first) {
		t.Fatalf("retry = %#v, %v; want %#v", again, err, first)
	}
	if f.count("project_control_events") != 1 || f.count("project_control_set_results") != 1 {
		t.Fatal("idempotent retry wrote event/result")
	}

	changed := input
	changed.Statement = "Different"
	_, err = f.service.SetOutcome(f.ctx, "ao", changed)
	if !errors.Is(err, domain.ErrProjectControlIdempotencyConflict) {
		t.Fatalf("idempotency conflict = %v", err)
	}
	_, err = f.service.SetOutcome(f.ctx, "ao", domain.SetOutcomeInput{
		ExpectedRevision: 0, IdempotencyKey: "stale", Statement: "Stale",
	})
	var stale *domain.ProjectControlRevisionConflictError
	if !errors.As(err, &stale) || stale.CurrentRevision != 1 {
		t.Fatalf("stale error = %#v, %v", stale, err)
	}
	if f.count("project_control_events") != 1 || f.count("project_control_set_results") != 1 {
		t.Fatal("conflicts wrote durable command state")
	}
}

func TestSetOutcomeConcurrencyCommitsOneRevisionAndDeduplicatesRetries(t *testing.T) {
	f := newFixture(t)
	first, err := f.service.SetOutcome(f.ctx, "ao", initialInput("set-1"))
	if err != nil {
		t.Fatal(err)
	}
	criterion := first.Outcome.Criteria[0]
	inputs := []domain.SetOutcomeInput{
		{ExpectedRevision: 1, IdempotencyKey: "left", Statement: "Left", Criteria: []domain.AcceptanceCriterionInput{{ID: criterion.ID, Statement: criterion.Statement, VerificationMethod: criterion.VerificationMethod, DisplayOrder: 0}}},
		{ExpectedRevision: 1, IdempotencyKey: "right", Statement: "Right", Criteria: []domain.AcceptanceCriterionInput{{ID: criterion.ID, Statement: criterion.Statement, VerificationMethod: criterion.VerificationMethod, DisplayOrder: 0}}},
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	results := make([]domain.ProjectControl, 2)
	for i := range inputs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = f.service.SetOutcome(f.ctx, "ao", inputs[i])
		}(i)
	}
	wg.Wait()
	var successes, staleConflicts int
	for i, err := range errs {
		if err == nil {
			successes++
			if results[i].Revision != 2 {
				t.Fatalf("winning revision = %d", results[i].Revision)
			}
			continue
		}
		var stale *domain.ProjectControlRevisionConflictError
		if errors.As(err, &stale) && stale.CurrentRevision == 2 {
			staleConflicts++
			continue
		}
		t.Fatalf("unexpected concurrent error: %v", err)
	}
	if successes != 1 || staleConflicts != 1 || f.count("project_control_events") != 2 {
		t.Fatalf("successes=%d stale=%d events=%d", successes, staleConflicts, f.count("project_control_events"))
	}

	retryInput := domain.SetOutcomeInput{
		ExpectedRevision: 2, IdempotencyKey: "concurrent-retry", Statement: "Final",
		Criteria: []domain.AcceptanceCriterionInput{{Statement: "New", VerificationMethod: "Verify", DisplayOrder: 0}},
	}
	results = make([]domain.ProjectControl, 2)
	errs = make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = f.service.SetOutcome(f.ctx, "ao", retryInput)
		}(i)
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil || !reflect.DeepEqual(results[0], results[1]) ||
		results[0].Revision != 3 || f.count("project_control_events") != 3 {
		t.Fatalf("concurrent retries = (%#v,%v) (%#v,%v), events=%d", results[0], errs[0], results[1], errs[1], f.count("project_control_events"))
	}
}

func TestGetAndSetOutcomeRejectMissingProject(t *testing.T) {
	f := newFixture(t)
	if _, err := f.service.Get(f.ctx, "missing"); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Fatalf("Get missing error = %v", err)
	}
	if _, err := f.service.SetOutcome(f.ctx, "missing", initialInput("missing")); !errors.Is(err, domain.ErrProjectNotFound) {
		t.Fatalf("SetOutcome missing error = %v", err)
	}
}
