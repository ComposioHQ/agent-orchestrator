package session

import "testing"

func TestCanonicalGitLabIssueURL(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantNative string
		wantHost  string
		wantOk    bool
	}{
		{
			name:      "gitlab.com simple repo",
			raw:       "https://gitlab.com/group/project/-/issues/42",
			wantNative: "group/project#42",
			wantHost:  "", // gitlab.com → zero value
			wantOk:    true,
		},
		{
			name:      "gitlab.com nested namespace",
			raw:       "https://gitlab.com/group/subgroup/project/-/issues/42",
			wantNative: "group/subgroup/project#42",
			wantHost:  "", // gitlab.com → zero value
			wantOk:    true,
		},
		{
			name:      "self-managed GitLab",
			raw:       "https://gitlab.internal/group/project/-/issues/42",
			wantNative: "group/project#42",
			wantHost:  "gitlab.internal",
			wantOk:    true,
		},
		{
			name:      "self-managed GitLab nested namespace",
			raw:       "https://gitlab.internal/group/subgroup/project/-/issues/99",
			wantNative: "group/subgroup/project#99",
			wantHost:  "gitlab.internal",
			wantOk:    true,
		},
		{
			name:      "self-managed with port",
			raw:       "https://gitlab.local:8443/group/project/-/issues/7",
			wantNative: "group/project#7",
			wantHost:  "gitlab.local:8443",
			wantOk:    true,
		},
		{
			name:      "not a GitLab issue URL",
			raw:       "https://github.com/owner/repo/issues/42",
			wantNative: "",
			wantHost:  "",
			wantOk:    false,
		},
		{
			name:      "missing issue number",
			raw:       "https://gitlab.com/group/project/-/issues/",
			wantNative: "",
			wantHost:  "",
			wantOk:    false,
		},
		{
			name:      "no project path",
			raw:       "https://gitlab.com/-/issues/42",
			wantNative: "",
			wantHost:  "",
			wantOk:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotNative, gotHost, gotOk := canonicalGitLabIssueURL(tt.raw)
			if gotOk != tt.wantOk {
				t.Fatalf("ok = %v, want %v", gotOk, tt.wantOk)
			}
			if gotNative != tt.wantNative {
				t.Errorf("native = %q, want %q", gotNative, tt.wantNative)
			}
			if gotHost != tt.wantHost {
				t.Errorf("host = %q, want %q", gotHost, tt.wantHost)
			}
		})
	}
}
