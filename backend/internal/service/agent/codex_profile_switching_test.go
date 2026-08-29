package agent

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func switchProfile(id string, status domain.CodexCapacityState, freshness domain.AgentReadinessFreshness, used *float64) domain.CodexProfileSnapshot {
	return domain.CodexProfileSnapshot{
		ID: id, Label: id, Source: domain.CodexProfileSourceManaged, Status: domain.CodexProfileStatusValid,
		Authentication: domain.AgentAuthenticationObservation{State: domain.AgentAuthenticationAuthorized, Freshness: domain.AgentReadinessFresh},
		Capacity:       domain.CodexCapacitySnapshot{State: status, Freshness: freshness, UsedPercent: used, AdditionalBuckets: []domain.CodexCapacityBucket{}},
	}
}

func TestCodexProfileSwitchOptionsRanksAvailableByRemainingCapacity(t *testing.T) {
	used20, used60, used80 := 20.0, 60.0, 80.0
	service := &Service{}
	options := service.codexProfileSwitchOptions(domain.CodexSessionBinding{ProfileID: "source", Source: domain.CodexProfileSourceManaged}, []domain.CodexProfileSnapshot{
		switchProfile("source", domain.CodexCapacityNearLimit, domain.AgentReadinessFresh, &used80),
		switchProfile("available-60", domain.CodexCapacityAvailable, domain.AgentReadinessFresh, &used60),
		switchProfile("near-80", domain.CodexCapacityNearLimit, domain.AgentReadinessFresh, &used80),
		switchProfile("available-20", domain.CodexCapacityAvailable, domain.AgentReadinessFresh, &used20),
	})
	if options.RecommendedProfileID == nil || *options.RecommendedProfileID != "available-20" {
		t.Fatalf("recommended = %v", options.RecommendedProfileID)
	}
	if len(options.Candidates) != 3 || options.Candidates[0].ID != "available-20" || options.Candidates[1].ID != "available-60" || options.Candidates[2].ID != "near-80" {
		t.Fatalf("candidate order = %#v", options.Candidates)
	}
	for _, candidate := range options.Candidates {
		if candidate.ID == "source" {
			t.Fatal("source profile appeared as a target")
		}
	}
}

func TestCodexProfileSwitchOptionsRequiresAcknowledgementForUnverifiedCapacity(t *testing.T) {
	service := &Service{}
	unknown := switchProfile("unknown", domain.CodexCapacityUnknown, domain.AgentReadinessStale, nil)
	exhausted := switchProfile("exhausted", domain.CodexCapacityExhausted, domain.AgentReadinessFresh, nil)
	signedOut := switchProfile("signed-out", domain.CodexCapacityAvailable, domain.AgentReadinessFresh, nil)
	signedOut.Authentication = domain.AgentAuthenticationObservation{State: domain.AgentAuthenticationUnauthorized, Freshness: domain.AgentReadinessFresh}
	options := service.codexProfileSwitchOptions(domain.CodexSessionBinding{ProfileID: "source", Source: domain.CodexProfileSourceExisting}, []domain.CodexProfileSnapshot{unknown, exhausted, signedOut})
	if options.RecommendedProfileID != nil {
		t.Fatalf("unexpected recommendation = %q", *options.RecommendedProfileID)
	}
	if len(options.Candidates) != 3 {
		t.Fatalf("candidate count = %d", len(options.Candidates))
	}
	if got := options.Candidates[0]; !got.Selectable || !got.RequiresCapacityAcknowledgement || got.ReasonCode != domain.CodexProfileSwitchReasonCapacityAckRequired {
		t.Fatalf("unknown candidate = %#v", got)
	}
	if got := options.Candidates[1]; got.Selectable || got.ReasonCode != domain.CodexProfileSwitchReasonCapacityExhausted {
		t.Fatalf("exhausted candidate = %#v", got)
	}
	if got := options.Candidates[2]; got.Selectable || got.ReasonCode != domain.CodexProfileSwitchReasonAuthenticationRequired {
		t.Fatalf("signed-out candidate = %#v", got)
	}
}
