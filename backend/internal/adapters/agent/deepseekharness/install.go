package deepseekharness

import "context"

// ResolveBinary exposes the resolved DeepSeek Harness path to AO's registry-level
// probes. It delegates to the cached Plugin.dshBinary so subsequent calls share the
// resolution GetLaunchCommand performed.
func (p *Plugin) ResolveBinary(ctx context.Context) (string, error) {
	return p.dshBinary(ctx)
}

// SuggestedInstallCommand returns the recommended npm command for installing
// DeepSeek Harness. It is not part of any interface and exists only so docs
// and tests can reference a single canonical install string.
//
// Notes for users:
//   - Node 20 or newer is required by the npm-distributed CLI.
//   - `npx @deepseek-ai/dsh` may time out on the first invocation while the
//     dependency graph is resolved; a pre-installed global CLI is faster and
//     is what the runtime expects to find on PATH.
func SuggestedInstallCommand() string {
	return "npm install -g @deepseek-ai/dsh"
}
