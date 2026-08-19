package postgres

import (
	"reflect"
	"testing"
)

func TestEffectiveModeCapsButNeverLoosens(t *testing.T) {
	cases := []struct {
		sessionMode string
		modeCap     string
		want        string
	}{
		{"trusted", "", "trusted"},
		{"trusted", "read-only", "read-only"},
		{"trusted", "standard", "standard"},
		{"standard", "trusted", "standard"},
		{"read-only", "trusted", "read-only"},
		{"read-only", "", "read-only"},
	}
	for _, tc := range cases {
		if got := effectiveMode(tc.sessionMode, tc.modeCap); got != tc.want {
			t.Errorf("effectiveMode(%q, %q) = %q, want %q", tc.sessionMode, tc.modeCap, got, tc.want)
		}
	}
}

func TestEffectiveDeniedCommandsUnionsAndDedupes(t *testing.T) {
	got := effectiveDeniedCommands([]string{"rm", "curl"}, []string{"curl", "git push"})
	want := []string{"rm", "curl", "git push"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("effectiveDeniedCommands = %v, want %v", got, want)
	}
	if got := effectiveDeniedCommands([]string{"rm"}, nil); !reflect.DeepEqual(got, []string{"rm"}) {
		t.Fatalf("effectiveDeniedCommands with no grant list = %v, want [rm]", got)
	}
}
