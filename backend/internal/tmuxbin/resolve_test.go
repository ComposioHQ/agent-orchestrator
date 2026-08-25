package tmuxbin

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestResolveWithPrefersConfiguredTmux(t *testing.T) {
	configured := filepath.Join(string(filepath.Separator), "opt", "ao", "tmux")
	var lookups []string
	got, err := ResolveWith(configured, func() (string, error) {
		t.Fatal("executable lookup must not run when tmux is configured")
		return "", nil
	}, func(name string) (string, error) {
		lookups = append(lookups, name)
		return name, nil
	})
	if err != nil {
		t.Fatalf("ResolveWith: %v", err)
	}
	if got.Path != configured || got.Source != SourceConfigured {
		t.Fatalf("resolution = %+v, want configured %q", got, configured)
	}
	if !reflect.DeepEqual(lookups, []string{configured}) {
		t.Fatalf("lookups = %v, want configured path only", lookups)
	}
}

func TestResolveWithDoesNotFallbackFromMissingConfiguredTmux(t *testing.T) {
	configured := filepath.Join(string(filepath.Separator), "missing", "bundled", "tmux")
	var lookups []string
	_, err := ResolveWith(configured, func() (string, error) { return "", nil }, func(name string) (string, error) {
		lookups = append(lookups, name)
		if name == "tmux" {
			return "/usr/bin/tmux", nil
		}
		return "", errors.New("not found")
	})
	if err == nil {
		t.Fatal("ResolveWith error = nil, want missing configured tmux error")
	}
	if !reflect.DeepEqual(lookups, []string{configured}) {
		t.Fatalf("lookups = %v, want no system fallback", lookups)
	}
}

func TestResolveWithFindsPackagedTmuxOnMacOSAndLinuxLayouts(t *testing.T) {
	for _, resourcesName := range []string{"Resources", "resources"} {
		t.Run(resourcesName, func(t *testing.T) {
			self := filepath.Join(t.TempDir(), resourcesName, "daemon", "ao")
			bundled := filepath.Join(filepath.Dir(filepath.Dir(self)), "tmux", "bin", "tmux")
			got, err := ResolveWith("", func() (string, error) { return self, nil }, func(name string) (string, error) {
				if name == bundled {
					return bundled, nil
				}
				return "", errors.New("not found")
			})
			if err != nil {
				t.Fatalf("ResolveWith: %v", err)
			}
			if got.Path != bundled || got.Source != SourceBundled {
				t.Fatalf("resolution = %+v, want bundled %q", got, bundled)
			}
		})
	}
}

func TestResolveWithDoesNotFallbackFromBrokenPackagedTmux(t *testing.T) {
	for _, tc := range []struct {
		name      string
		lookupErr error
	}{
		{name: "missing", lookupErr: errors.New("not found")},
		{name: "empty resolution"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			self := filepath.Join(t.TempDir(), "AO.app", "Contents", "Resources", "daemon", "ao")
			bundled := filepath.Join(filepath.Dir(filepath.Dir(self)), "tmux", "bin", "tmux")
			var lookups []string

			_, err := ResolveWith("", func() (string, error) { return self, nil }, func(name string) (string, error) {
				lookups = append(lookups, name)
				if name == bundled {
					return "", tc.lookupErr
				}
				// A system tmux is deliberately available: packaged resolution must
				// still fail closed before consulting it.
				if name == "tmux" {
					return "/usr/bin/tmux", nil
				}
				return "", errors.New("unexpected lookup")
			})
			if err == nil {
				t.Fatal("ResolveWith error = nil, want broken packaged tmux error")
			}
			if !errors.Is(err, errTmuxNotFound) {
				t.Fatalf("ResolveWith error = %v, want errTmuxNotFound", err)
			}
			if !reflect.DeepEqual(lookups, []string{bundled}) {
				t.Fatalf("lookups = %v, want packaged candidate only", lookups)
			}
		})
	}
}

func TestResolveWithFollowsExecutableSymlinkIntoBundle(t *testing.T) {
	daemonDir := filepath.Join(t.TempDir(), "AO.app", "Contents", "Resources", "daemon")
	if err := os.MkdirAll(daemonDir, 0o755); err != nil {
		t.Fatal(err)
	}
	realAO := filepath.Join(daemonDir, "ao")
	if err := os.WriteFile(realAO, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(t.TempDir(), "ao")
	if err := os.Symlink(realAO, shim); err != nil {
		t.Fatal(err)
	}
	canonicalAO, err := filepath.EvalSymlinks(realAO)
	if err != nil {
		t.Fatal(err)
	}
	bundled := filepath.Join(filepath.Dir(filepath.Dir(canonicalAO)), "tmux", "bin", "tmux")
	got, err := ResolveWith("", func() (string, error) { return shim, nil }, func(name string) (string, error) {
		if name == bundled {
			return bundled, nil
		}
		return "", errors.New("not found")
	})
	if err != nil {
		t.Fatalf("ResolveWith: %v", err)
	}
	if got.Path != bundled || got.Source != SourceBundled {
		t.Fatalf("resolution = %+v, want bundled %q", got, bundled)
	}
}

func TestResolveWithFallsBackToSystemTmux(t *testing.T) {
	got, err := ResolveWith("", func() (string, error) { return "/usr/local/bin/ao", nil }, func(name string) (string, error) {
		if name == "tmux" {
			return "/usr/local/bin/tmux", nil
		}
		return "", errors.New("not found")
	})
	if err != nil {
		t.Fatalf("ResolveWith: %v", err)
	}
	if got.Path != "/usr/local/bin/tmux" || got.Source != SourceSystem {
		t.Fatalf("resolution = %+v, want system tmux", got)
	}
}

func TestResolveWithReturnsErrorWhenTmuxIsUnavailable(t *testing.T) {
	_, err := ResolveWith("", func() (string, error) { return "/usr/local/bin/ao", nil }, func(string) (string, error) {
		return "", errors.New("not found")
	})
	if err == nil {
		t.Fatal("ResolveWith error = nil, want missing tmux error")
	}
}
