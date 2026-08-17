package deepseekharness

import "context"

// ResolveBinary exposes the resolved DeepSeek CLI path to AO's registry-level
// probes. It delegates to the cached Plugin.deepseekBinary so subsequent calls share the
// resolution GetLaunchCommand performed.
func (p *Plugin) ResolveBinary(ctx context.Context) (string, error) {
	return p.deepseekBinary(ctx)
}

// SuggestedInstallCommand intentionally returns no recommendation. AO supports
// an existing `deepseek` executable without endorsing a third-party package.
func SuggestedInstallCommand() string {
	return ""
}
