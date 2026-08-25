package conpty

import (
	"reflect"
	"strings"
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

func TestMergeWindowsEnvReplacesInheritedPathWithOverlay(t *testing.T) {
	got := mergeWindowsEnv(
		[]string{"Path=C:\\Users\\me\\AppData\\Roaming\\npm", "AO_KEEP=parent"},
		map[string]string{"PATH": "C:\\Program Files\\Agent Orchestrator\\resources\\daemon"},
		nil,
	)

	seen := map[string]string{}
	for _, entry := range got {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			seen[key] = value
		}
	}
	if seen["Path"] != "" {
		t.Fatalf("inherited Path survived alongside PATH: %v", got)
	}
	if seen["PATH"] != "C:\\Program Files\\Agent Orchestrator\\resources\\daemon" {
		t.Fatalf("PATH = %q, want AO daemon path in %v", seen["PATH"], got)
	}
	if seen["AO_KEEP"] != "parent" {
		t.Fatalf("AO_KEEP = %q, want parent", seen["AO_KEEP"])
	}
}

func TestMergeWindowsEnvPinnedPATHWinsOverAssignments(t *testing.T) {
	got := mergeWindowsEnv(
		[]string{"Path=C:\\base"},
		map[string]string{"PATH": "C:\\overlay"},
		[]string{"path=C:\\assignment"},
	)

	seen := map[string]string{}
	for _, entry := range got {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			seen[key] = value
		}
	}
	if len(seen) != 1 || seen["PATH"] != "C:\\overlay" {
		t.Fatalf("merged env = %v, want only AO-pinned PATH", got)
	}
}

func TestMergeWindowsEnvPinnedPATHWinsOverProjectPath(t *testing.T) {
	got := mergeWindowsEnv(
		[]string{"Path=C:\\Users\\me\\AppData\\Roaming\\npm"},
		map[string]string{
			"Path": "C:\\Project\\node_modules\\.bin",
			"PATH": "C:\\Program Files\\Agent Orchestrator\\resources\\daemon;C:\\Project\\node_modules\\.bin",
		},
		nil,
	)

	seen := map[string]string{}
	for _, entry := range got {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			seen[key] = value
		}
	}
	if len(seen) != 1 {
		t.Fatalf("merged env = %v, want one PATH entry", got)
	}
	if seen["PATH"] != "C:\\Program Files\\Agent Orchestrator\\resources\\daemon;C:\\Project\\node_modules\\.bin" {
		t.Fatalf("PATH = %q, want AO-pinned PATH in %v", seen["PATH"], got)
	}
}
