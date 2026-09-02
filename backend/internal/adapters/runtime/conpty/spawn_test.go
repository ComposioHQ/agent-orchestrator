package conpty

import (
	"reflect"
	"slices"
	"testing"
)

func TestStripEnvAssignments(t *testing.T) {
	tests := []struct {
		name            string
		argv            []string
		wantAssignments []string
		wantRest        []string
	}{
		{
			name:            "no env prefix returns argv unchanged",
			argv:            []string{"opencode", "--agent", "ao-x"},
			wantAssignments: nil,
			wantRest:        []string{"opencode", "--agent", "ao-x"},
		},
		{
			name:            "env prefix is split from the real command",
			argv:            []string{"env", "OPENCODE_CONFIG=C:/cfg.json", "opencode", "--agent", "ao-x"},
			wantAssignments: []string{"OPENCODE_CONFIG=C:/cfg.json"},
			wantRest:        []string{"opencode", "--agent", "ao-x"},
		},
		{
			name:            "env with no command left is untouched",
			argv:            []string{"env", "A=1", "B=2"},
			wantAssignments: nil,
			wantRest:        []string{"env", "A=1", "B=2"},
		},
		{
			name:            "a binary merely starting with env is not treated as a prefix",
			argv:            []string{"envoy", "--config", "x"},
			wantAssignments: nil,
			wantRest:        []string{"envoy", "--config", "x"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotAssignments, gotRest := stripEnvAssignments(tt.argv)
			if !reflect.DeepEqual(gotAssignments, tt.wantAssignments) {
				t.Errorf("assignments = %#v, want %#v", gotAssignments, tt.wantAssignments)
			}
			if !reflect.DeepEqual(gotRest, tt.wantRest) {
				t.Errorf("rest = %#v, want %#v", gotRest, tt.wantRest)
			}
		})
	}
}

func TestInteractiveTerminalEnvDropsAmbientNoColorAndAdvertisesTrueColor(t *testing.T) {
	env := interactiveTerminalEnv(
		[]string{"PATH=/usr/bin", "TERM=dumb", "COLORTERM=ansi", "NO_COLOR=1"},
		map[string]string{"AO_SESSION_ID": "sess-1"},
		nil,
	)

	for _, want := range []string{
		"PATH=/usr/bin",
		"AO_SESSION_ID=sess-1",
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	} {
		if !slices.Contains(env, want) {
			t.Errorf("env missing %q: %#v", want, env)
		}
	}
	for _, got := range env {
		if got == "NO_COLOR=1" {
			t.Fatalf("ambient NO_COLOR leaked into interactive terminal env: %#v", env)
		}
	}
}

func TestInteractiveTerminalEnvPreservesExplicitNoColor(t *testing.T) {
	for _, tt := range []struct {
		name        string
		configured  map[string]string
		assignments []string
	}{
		{name: "runtime config", configured: map[string]string{"NO_COLOR": "1"}},
		{name: "argv env assignment", assignments: []string{"NO_COLOR=1"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			env := interactiveTerminalEnv(
				[]string{"NO_COLOR=ambient"},
				tt.configured,
				tt.assignments,
			)
			if !slices.Contains(env, "NO_COLOR=1") {
				t.Fatalf("explicit NO_COLOR not preserved: %#v", env)
			}
		})
	}
}
