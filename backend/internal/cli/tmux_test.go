package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

func tmuxLookPath(available ...string) func(string) (string, error) {
	found := make(map[string]bool, len(available))
	for _, name := range available {
		found[name] = true
	}
	return func(name string) (string, error) {
		if found[name] {
			return "/usr/bin/" + name, nil
		}
		return "", exec.ErrNotFound
	}
}

func tmuxFakeTerminal(t *testing.T, answer string) io.Reader {
	t.Helper()
	original := stdinIsInteractive
	stdinIsInteractive = func(io.Reader) bool { return true }
	t.Cleanup(func() { stdinIsInteractive = original })
	return strings.NewReader(answer)
}

func TestEnsureTmuxSkipsSatisfiedAndWindows(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
	}{
		{name: "already installed", goos: "linux", available: []string{"tmux", "apt-get", "sudo"}},
		{name: "windows uses conpty", goos: "windows"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := &bytes.Buffer{}
			c := &commandContext{deps: Deps{
				LookPath: tmuxLookPath(tc.available...),
				RunInteractive: func(context.Context, string, ...string) error {
					t.Fatal("unexpected install")
					return nil
				},
			}.withDefaults()}
			c.ensureTmux(context.Background(), tc.goos, &bytes.Buffer{}, out)
			if out.Len() != 0 {
				t.Fatalf("output = %q, want none", out.String())
			}
		})
	}
}

func TestEnsureTmuxNonInteractiveOnlyWarns(t *testing.T) {
	out := &bytes.Buffer{}
	c := &commandContext{deps: Deps{
		LookPath: tmuxLookPath("apt-get", "sudo"),
		RunInteractive: func(context.Context, string, ...string) error {
			t.Fatal("unexpected install")
			return nil
		},
	}.withDefaults()}

	c.ensureTmux(context.Background(), "linux", &bytes.Buffer{}, out)
	if got := out.String(); !strings.Contains(got, "terminal sessions will fail") || !strings.Contains(got, "apt-get install -y tmux") {
		t.Fatalf("warning = %q, want consequence and install command", got)
	}
}

func TestEnsureTmuxDoesNotPromptOnDevNull(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no /dev/null on Windows")
	}
	in, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = in.Close() })
	out := &bytes.Buffer{}
	c := &commandContext{deps: Deps{
		LookPath: tmuxLookPath("apt-get", "sudo"),
		RunInteractive: func(context.Context, string, ...string) error {
			t.Fatal("unexpected install")
			return nil
		},
	}.withDefaults()}

	c.ensureTmux(context.Background(), "linux", in, out)
	if got := out.String(); strings.Contains(got, "Install it now") || !strings.Contains(got, "Warning:") {
		t.Fatalf("output = %q, want non-interactive warning", got)
	}
}

func TestEnsureTmuxInteractiveInstallAndVerify(t *testing.T) {
	installed := false
	var command []string
	out := &bytes.Buffer{}
	c := &commandContext{deps: Deps{
		LookPath: func(name string) (string, error) {
			if name == "tmux" && !installed {
				return "", exec.ErrNotFound
			}
			return "/usr/bin/" + name, nil
		},
		RunInteractive: func(_ context.Context, name string, args ...string) error {
			command = append([]string{name}, args...)
			installed = true
			return nil
		},
	}.withDefaults()}

	c.ensureTmux(context.Background(), "darwin", tmuxFakeTerminal(t, "\n"), out)
	if got := strings.Join(command, " "); got != "brew install tmux" {
		t.Fatalf("command = %q, want brew install tmux", got)
	}
	if got := out.String(); !strings.Contains(got, "Install it now") || !strings.Contains(got, "tmux installed.") {
		t.Fatalf("output = %q, want prompt and success", got)
	}
}

func TestEnsureTmuxDeclineAndFailureDoNotBlockLaunch(t *testing.T) {
	for _, tc := range []struct {
		name   string
		answer string
		runErr error
		want   string
	}{
		{name: "declined", answer: "n\n", want: "Warning:"},
		{name: "installer failed", answer: "\n", runErr: errors.New("exit status 100"), want: "exit status 100"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := &bytes.Buffer{}
			c := &commandContext{deps: Deps{
				LookPath: tmuxLookPath("brew"),
				RunInteractive: func(context.Context, string, ...string) error {
					return tc.runErr
				},
			}.withDefaults()}

			c.ensureTmux(context.Background(), "darwin", tmuxFakeTerminal(t, tc.answer), out)
			if got := out.String(); !strings.Contains(got, tc.want) || !strings.Contains(got, "terminal sessions will fail") {
				t.Fatalf("output = %q, want %q and final warning", got, tc.want)
			}
		})
	}
}

func TestTmuxInstallCommandSelection(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
		want      string
	}{
		{name: "homebrew", goos: "darwin", available: []string{"brew", "sudo"}, want: "brew install tmux"},
		{name: "apt", goos: "linux", available: []string{"apt-get", "dnf", "sudo"}, want: "apt-get install -y tmux"},
		{name: "dnf", goos: "linux", available: []string{"dnf", "sudo"}, want: "dnf install -y tmux"},
		{name: "pacman", goos: "linux", available: []string{"pacman", "sudo"}, want: "pacman -S --noconfirm tmux"},
		{name: "zypper", goos: "linux", available: []string{"zypper", "sudo"}, want: "zypper install -y tmux"},
		{name: "apk", goos: "linux", available: []string{"apk", "sudo"}, want: "apk add tmux"},
		{name: "unsupported", goos: "plan9", available: []string{"apt-get", "brew"}, want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &commandContext{deps: Deps{LookPath: tmuxLookPath(tc.available...)}.withDefaults()}
			got := strings.Join(c.tmuxInstallCommand(tc.goos), " ")
			if tc.want == "" && got != "" {
				t.Fatalf("command = %q, want none", got)
			}
			if tc.want != "" && !strings.HasSuffix(got, tc.want) {
				t.Fatalf("command = %q, want suffix %q", got, tc.want)
			}
		})
	}
}
