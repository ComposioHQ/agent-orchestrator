package androidsdk

import (
	"sync"
	"time"
)

// envProviderTTL bounds how stale the cached "is the SDK installed" check may
// be: long enough that a burst of concurrent session/shell spawns doesn't
// each stat the SDK manifest, short enough that a fresh `ao android sdk
// setup` becomes visible to newly spawned sessions without a daemon restart.
const envProviderTTL = 10 * time.Second

// EnvProvider returns a closure shaped for session_manager.Deps.AndroidEnv
// and shellterm.Service.SetAndroidEnv: nil/nil until an Android SDK is
// installed at toolsDir (AO's own managed copy, or a user-adopted external
// one), then ANDROID_HOME/ANDROID_SDK_ROOT plus platform-tools/emulator to
// prepend to PATH -- pointed at whichever root is actually installed, so
// agent sessions and standalone shells see adb/gradle regardless of source.
func EnvProvider(toolsDir string) func() (map[string]string, []string) {
	return newEnvProvider(toolsDir, envProviderTTL, time.Now)
}

// newEnvProvider is EnvProvider with an injectable TTL/clock for deterministic
// tests.
func newEnvProvider(toolsDir string, ttl time.Duration, now func() time.Time) func() (map[string]string, []string) {
	var (
		mu        sync.Mutex
		checkedAt time.Time
		vars      map[string]string
		dirs      []string
	)
	return func() (map[string]string, []string) {
		mu.Lock()
		defer mu.Unlock()
		if !checkedAt.IsZero() && now().Sub(checkedAt) < ttl {
			return vars, dirs
		}
		checkedAt = now()
		sdk, ok := Installed(toolsDir)
		if !ok {
			vars, dirs = nil, nil
			return vars, dirs
		}
		vars = map[string]string{"ANDROID_HOME": sdk.Root, "ANDROID_SDK_ROOT": sdk.Root}
		dirs = []string{PlatformToolsDirIn(sdk.Root), EmulatorDirIn(sdk.Root)}
		return vars, dirs
	}
}
