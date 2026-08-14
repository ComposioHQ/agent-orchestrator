package agy

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestDeriveActivityState(t *testing.T) {
	tests := []struct {
		name    string
		event   string
		payload string
		want    domain.ActivityState
		wantOK  bool
	}{
		{"pre invocation -> active", "pre-invocation", `{}`, domain.ActivityActive, true},
		{"post tool use -> active", "post-tool-use", `{}`, domain.ActivityActive, true},
		{"stop fully idle -> idle", "stop", `{"fullyIdle":true}`, domain.ActivityIdle, true},
		{"stop background work -> active", "stop", `{"fullyIdle":false}`, domain.ActivityActive, true},
		{"stop legacy snake case -> idle", "stop", `{"fully_idle":true}`, domain.ActivityIdle, true},
		{"stop missing fullyIdle degrades to idle", "stop", `{}`, domain.ActivityIdle, true},
		{"unknown event -> no signal", "unknown", `{}`, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := DeriveActivityState(tt.event, []byte(tt.payload))
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("DeriveActivityState(%q) = (%q, %v), want (%q, %v)",
					t.event, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}
