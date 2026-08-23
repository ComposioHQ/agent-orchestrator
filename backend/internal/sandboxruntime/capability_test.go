//go:build unix

package sandboxruntime

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeCapability(t *testing.T, body []byte, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "capability")
	if err := os.WriteFile(path, body, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWithCapabilityAcceptsRawBytesAndZeroesBuffer(t *testing.T) {
	secret := []byte("opaque-bearer-value")
	path := writeCapability(t, secret, 0o600)
	var observed []byte
	err := withCapabilityAt(path, uint32(os.Getuid()), func(raw []byte) error {
		observed = raw
		if string(raw) != string(secret) {
			t.Fatalf("raw capability = %q", raw)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for i, b := range observed {
		if b != 0 {
			t.Fatalf("capability byte %d was not zeroed", i)
		}
	}
}

func TestWithCapabilityRejectsJSONShapeWithoutLeakingSecret(t *testing.T) {
	secret := `{"token":"should-never-appear"}`
	path := writeCapability(t, []byte(secret), 0o600)
	err := withCapabilityAt(path, uint32(os.Getuid()), func([]byte) error {
		t.Fatal("JSON capability reached callback")
		return nil
	})
	if !errors.Is(err, ErrCapabilityInvalid) {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), "should-never-appear") {
		t.Fatalf("error leaked capability: %v", err)
	}
}

func TestWithCapabilityRejectsWrongMode(t *testing.T) {
	path := writeCapability(t, []byte("opaque-bearer-value"), 0o640)
	err := withCapabilityAt(path, uint32(os.Getuid()), func([]byte) error { return nil })
	if !errors.Is(err, ErrCapabilityInsecure) || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("error = %v", err)
	}
}

func TestWithCapabilityRejectsWrongUID(t *testing.T) {
	path := writeCapability(t, []byte("opaque-bearer-value"), 0o600)
	err := withCapabilityAt(path, uint32(os.Getuid()+1), func([]byte) error { return nil })
	if !errors.Is(err, ErrCapabilityInsecure) || !strings.Contains(err.Error(), "owner") {
		t.Fatalf("error = %v", err)
	}
}

func TestWithCapabilityRejectsSymlink(t *testing.T) {
	target := writeCapability(t, []byte("opaque-bearer-value"), 0o600)
	link := filepath.Join(t.TempDir(), "capability")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	err := withCapabilityAt(link, uint32(os.Getuid()), func([]byte) error { return nil })
	if !errors.Is(err, ErrCapabilityInsecure) || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("error = %v", err)
	}
}

func TestWithCapabilityRejectsNonRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "capability")
	if err := os.Mkdir(path, 0o600); err != nil {
		t.Fatal(err)
	}
	err := withCapabilityAt(path, uint32(os.Getuid()), func([]byte) error { return nil })
	if !errors.Is(err, ErrCapabilityInsecure) || !strings.Contains(err.Error(), "regular") {
		t.Fatalf("error = %v", err)
	}
}

func TestWithCapabilityRejectsHeaderControlBytes(t *testing.T) {
	path := writeCapability(t, []byte("opaque-bearer\nvalue"), 0o600)
	err := withCapabilityAt(path, uint32(os.Getuid()), func([]byte) error { return nil })
	if !errors.Is(err, ErrCapabilityInvalid) || !strings.Contains(err.Error(), "control") {
		t.Fatalf("error = %v", err)
	}
}
