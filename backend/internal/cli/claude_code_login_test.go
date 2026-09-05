package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"
)

func TestClaudeCodeLoginRunsSelectedNativeLoginMethod(t *testing.T) {
	tests := []struct {
		name      string
		selection string
		wantArgs  []string
	}{
		{name: "Claude account", selection: "1\n", wantArgs: []string{"auth", "login", "--claudeai"}},
		{name: "enterprise SSO", selection: "2\n", wantArgs: []string{"auth", "login", "--claudeai", "--sso"}},
		{name: "Anthropic Console", selection: "3\n", wantArgs: []string{"auth", "login", "--console"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout bytes.Buffer
			var gotName string
			var gotArgs []string
			deps := Deps{
				In: strings.NewReader(tt.selection), Out: &stdout, Err: &stdout,
				LookPath: func(string) (string, error) { return "/usr/local/bin/claude", nil },
				RunInteractiveCommand: func(_ context.Context, name string, args []string, _ io.Reader, _, _ io.Writer) error {
					gotName = name
					gotArgs = append([]string(nil), args...)
					return nil
				},
			}
			cmd := newClaudeCodeLoginCommand(&commandContext{deps: deps.withDefaults()})
			cmd.SetIn(deps.In)
			cmd.SetOut(deps.Out)
			cmd.SetErr(deps.Err)
			if err := cmd.Execute(); err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if gotName != "/usr/local/bin/claude" {
				t.Errorf("executable = %q, want resolved Claude Code", gotName)
			}
			if !slices.Equal(gotArgs, tt.wantArgs) {
				t.Errorf("args = %q, want %q", gotArgs, tt.wantArgs)
			}
		})
	}
}

func TestClaudeCodeLoginMenuListsEverySupportedMethod(t *testing.T) {
	var stdout bytes.Buffer
	if err := writeClaudeCodeLoginMenu(&stdout, accountLoginStyle{}); err != nil {
		t.Fatalf("writeClaudeCodeLoginMenu: %v", err)
	}
	for _, fragment := range []string{"Sign in to Claude Code", "Claude account in browser", "Enterprise SSO", "Anthropic Console", "Selection [1-3]"} {
		if !strings.Contains(stdout.String(), fragment) {
			t.Fatalf("menu missing %q:\n%s", fragment, stdout.String())
		}
	}
	const maxRows = 14
	if rows := strings.Count(stdout.String(), "\n") + 1; rows > maxRows {
		t.Fatalf("menu uses %d rows, want at most %d", rows, maxRows)
	}
}

func TestClaudeCodeLoginReportsMissingBinaryAndNativeFailure(t *testing.T) {
	tests := []struct {
		name string
		deps Deps
		want string
	}{
		{name: "missing binary", deps: Deps{LookPath: func(string) (string, error) { return "", errors.New("missing") }}, want: "claude CLI is not installed"},
		{name: "native failure", deps: Deps{
			In: strings.NewReader("1\n"), LookPath: func(string) (string, error) { return "/claude", nil },
			RunInteractiveCommand: func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) error {
				return errors.New("exit status 1")
			},
		}, want: "claude login failed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := newClaudeCodeLoginCommand(&commandContext{deps: tt.deps.withDefaults()})
			if tt.deps.In == nil {
				cmd.SetIn(strings.NewReader("1\n"))
			} else {
				cmd.SetIn(tt.deps.In)
			}
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Execute error = %v, want %q", err, tt.want)
			}
		})
	}
}
