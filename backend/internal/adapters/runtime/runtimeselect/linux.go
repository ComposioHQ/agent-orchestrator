package runtimeselect

import "log/slog"

func newLinuxRuntime(legacy, direct routedBackend, log *slog.Logger) *hybridRuntime {
	return newHybridRuntime(legacy, direct, log, "Linux")
}
