package domain

import "testing"

func TestEffectiveAgentReadiness(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name         string
		installation AgentInstallationState
		auth         AgentAuthenticationState
		want         AgentEffectiveReadiness
	}{
		{"missing", AgentInstallationNotInstalled, AgentAuthenticationUnknown, AgentReadinessNotReady},
		{"installation unknown", AgentInstallationUnknown, AgentAuthenticationAuthorized, AgentReadinessUnknown},
		{"authorized", AgentInstallationInstalled, AgentAuthenticationAuthorized, AgentReadinessReady},
		{"auth not applicable", AgentInstallationInstalled, AgentAuthenticationNotApplicable, AgentReadinessReady},
		{"unauthorized", AgentInstallationInstalled, AgentAuthenticationUnauthorized, AgentReadinessNotReady},
		{"auth unknown", AgentInstallationInstalled, AgentAuthenticationUnknown, AgentReadinessUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := EffectiveAgentReadiness(tt.installation, tt.auth); got != tt.want {
				t.Fatalf("EffectiveAgentReadiness(%q, %q) = %q, want %q", tt.installation, tt.auth, got, tt.want)
			}
		})
	}
}

func TestAgentAuthenticationStateSignedIn(t *testing.T) {
	t.Parallel()
	tests := []struct {
		state AgentAuthenticationState
		want  bool
	}{
		{AgentAuthenticationAuthorized, true},
		{AgentAuthenticationNotApplicable, true},
		{AgentAuthenticationUnauthorized, false},
		{AgentAuthenticationUnknown, false},
		{AgentAuthenticationState("checking"), false},
	}
	for _, tt := range tests {
		t.Run(string(tt.state), func(t *testing.T) {
			t.Parallel()
			if got := tt.state.SignedIn(); got != tt.want {
				t.Fatalf("%q.SignedIn() = %t, want %t", tt.state, got, tt.want)
			}
		})
	}
	// Readiness derivation and the predicate must not drift apart.
	for _, state := range []AgentAuthenticationState{AgentAuthenticationAuthorized, AgentAuthenticationNotApplicable, AgentAuthenticationUnauthorized, AgentAuthenticationUnknown} {
		ready := EffectiveAgentReadiness(AgentInstallationInstalled, state) == AgentReadinessReady
		if ready != state.SignedIn() {
			t.Fatalf("%q: ready=%t but SignedIn=%t", state, ready, state.SignedIn())
		}
	}
}

func TestAgentReadinessPurposeValidation(t *testing.T) {
	t.Parallel()
	if !AgentReadinessPurposeDisplay.Valid() || !AgentReadinessPurposeLaunch.Valid() {
		t.Fatal("documented readiness purposes must be valid")
	}
	if AgentReadinessPurpose("force").Valid() {
		t.Fatal("unknown readiness purpose must be invalid")
	}
}
