package androidsdk

import (
	"testing"
	"time"
)

func TestEnvProviderReturnsNoEnvWhenSDKNotInstalled(t *testing.T) {
	toolsDir := t.TempDir()
	vars, dirs := EnvProvider(toolsDir)()
	if vars != nil || dirs != nil {
		t.Fatalf("vars=%v dirs=%v, want nil/nil when nothing is installed", vars, dirs)
	}
}

func TestEnvProviderReturnsAndroidHomeAndPathDirsWhenInstalled(t *testing.T) {
	toolsDir := t.TempDir()
	if err := writeInstalledManifest(toolsDir, installedManifest{SystemImageSHA1: "abc123"}); err != nil {
		t.Fatal(err)
	}
	vars, dirs := EnvProvider(toolsDir)()

	wantHome := Dir(toolsDir)
	if vars["ANDROID_HOME"] != wantHome || vars["ANDROID_SDK_ROOT"] != wantHome {
		t.Fatalf("vars = %+v, want ANDROID_HOME/ANDROID_SDK_ROOT = %q", vars, wantHome)
	}
	if len(dirs) != 2 || dirs[0] != PlatformToolsDir(toolsDir) || dirs[1] != EmulatorDir(toolsDir) {
		t.Fatalf("dirs = %v, want [%q, %q]", dirs, PlatformToolsDir(toolsDir), EmulatorDir(toolsDir))
	}
}

func TestEnvProviderRechecksAfterTTL(t *testing.T) {
	toolsDir := t.TempDir()
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	provider := newEnvProvider(toolsDir, time.Second, func() time.Time { return clock })

	vars, _ := provider()
	if vars != nil {
		t.Fatalf("expected no env before install, got %v", vars)
	}

	if err := writeInstalledManifest(toolsDir, installedManifest{SystemImageSHA1: "abc123"}); err != nil {
		t.Fatal(err)
	}
	vars, _ = provider()
	if vars != nil {
		t.Fatalf("expected the cached nil result to still apply within the TTL, got %v", vars)
	}

	clock = clock.Add(2 * time.Second)
	vars, _ = provider()
	if vars == nil {
		t.Fatal("expected a fresh check after the TTL elapsed to see the completed install")
	}
}
