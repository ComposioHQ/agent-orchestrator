package cli

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func lookPathFor(available ...string) func(string) (string, error) {
	set := make(map[string]bool, len(available))
	for _, name := range available {
		set[name] = true
	}
	return func(file string) (string, error) {
		if set[file] {
			return "/usr/bin/" + file, nil
		}
		return "", exec.ErrNotFound
	}
}

func TestEnsureTmuxSkipsWhenSatisfied(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
	}{
		{"tmux already installed", "linux", []string{"tmux", "apt-get"}},
		{"windows uses conpty", "windows", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := &bytes.Buffer{}
			c := &commandContext{deps: Deps{LookPath: lookPathFor(tc.available...)}.withDefaults()}
			c.ensureTmux(context.Background(), tc.goos, &bytes.Buffer{}, out)
			if out.Len() != 0 {
				t.Fatalf("expected no output, got %q", out.String())
			}
		})
	}
}

func TestEnsureTmuxWarnsWithExactManualCommand(t *testing.T) {
	for _, tc := range []struct {
		name      string
		available []string
		want      string
	}{
		{"package manager and sudo", []string{"apt-get", "sudo"}, "apt-get install -y tmux"},
		{"package manager without sudo", []string{"apt-get"}, "sudo apt-get install -y tmux"},
		{"no package manager", nil, "install it with your package manager"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "package manager without sudo" && os.Geteuid() == 0 {
				t.Skip("root does not need a sudo-prefixed remedy")
			}
			out := &bytes.Buffer{}
			c := &commandContext{deps: Deps{LookPath: lookPathFor(tc.available...)}.withDefaults()}

			c.ensureTmux(context.Background(), "linux", &bytes.Buffer{}, out)

			if !strings.Contains(out.String(), "Warning: tmux is not in PATH") {
				t.Fatalf("expected a warning, got %q", out.String())
			}
			if !strings.Contains(out.String(), tc.want) {
				t.Fatalf("output %q should mention %q", out.String(), tc.want)
			}
			if strings.Contains(out.String(), "Install it now") || strings.Contains(out.String(), "Running ") {
				t.Fatalf("ao start must not prompt or execute an installer: %q", out.String())
			}
		})
	}
}

func TestTmuxInstallCommand(t *testing.T) {
	for _, tc := range []struct {
		name      string
		goos      string
		available []string
		want      string
	}{
		{"darwin uses homebrew", "darwin", []string{"brew"}, "brew install tmux"},
		{"darwin without homebrew", "darwin", nil, ""},
		{"linux prefers apt-get", "linux", []string{"apt-get", "dnf"}, "apt-get install -y tmux"},
		{"linux falls back to dnf", "linux", []string{"dnf"}, "dnf install -y tmux"},
		{"linux falls back to pacman", "linux", []string{"pacman"}, "pacman -S --noconfirm tmux"},
		{"linux falls back to zypper", "linux", []string{"zypper"}, "zypper install -y tmux"},
		{"linux falls back to apk", "linux", []string{"apk"}, "apk add tmux"},
		{"linux without a package manager", "linux", nil, ""},
		{"unsupported platform", "plan9", []string{"apt-get", "brew"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &commandContext{deps: Deps{LookPath: lookPathFor(tc.available...)}.withDefaults()}
			got := strings.Join(c.tmuxInstallCommand(tc.goos), " ")
			if tc.want == "" {
				if got != "" {
					t.Fatalf("got %q, want no command", got)
				}
				return
			}
			if !strings.HasSuffix(got, tc.want) {
				t.Fatalf("got %q, want it to end with %q", got, tc.want)
			}
		})
	}
}

func TestTmuxInstallCommandNeverSudoesHomebrew(t *testing.T) {
	c := &commandContext{deps: Deps{LookPath: lookPathFor("brew", "sudo")}.withDefaults()}
	if got := strings.Join(c.tmuxInstallCommand("darwin"), " "); got != "brew install tmux" {
		t.Fatalf("got %q, want an unprivileged brew invocation", got)
	}
}

func TestTmuxInstallCommandNamesSudoEvenWhenUnavailable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, so no sudo prefix is needed")
	}
	c := &commandContext{deps: Deps{LookPath: lookPathFor("apt-get")}.withDefaults()}
	if got := strings.Join(c.tmuxInstallCommand("linux"), " "); got != "sudo apt-get install -y tmux" {
		t.Fatalf("got %q, want exact sudo-prefixed manual command", got)
	}
}
