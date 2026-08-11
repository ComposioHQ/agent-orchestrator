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
// and shellterm.Service.SetAndroidEnv: nil/nil until AO's managed Android SDK
// is installed at toolsDir, then ANDROID_HOME/ANDROID_SDK_ROOT plus
// platform-tools/emulator to prepend to PATH.
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
		if _, ok := InstalledSystemImageSHA1(toolsDir); !ok {
			vars, dirs = nil, nil
			return vars, dirs
		}
		home := Dir(toolsDir)
		vars = map[string]string{"ANDROID_HOME": home, "ANDROID_SDK_ROOT": home}
		dirs = []string{PlatformToolsDir(toolsDir), EmulatorDir(toolsDir)}
		return vars, dirs
	}
}
